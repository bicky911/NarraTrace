import { expect } from '@playwright/test';
import { test } from './fixtures.js';

async function getActiveTabId(worker) {
  return worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return Number.isInteger(tab?.id) ? tab.id : null;
  });
}

async function openExtensionPage(context, extensionId, relativePath, query = '') {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${relativePath}${query}`);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

async function setTestVoice(popup, voiceName, expectedExtensionId) {
  const voiceSelect = popup.locator('#popup-voice-select');
  await expect.poll(async () => voiceSelect.locator('option').evaluateAll(
    (options, expectedVoiceName) => options.some(option => option.value === expectedVoiceName),
    voiceName
  ), { timeout: 15000 }).toBe(true);

  await voiceSelect.selectOption(voiceName);
  const selectedOption = await voiceSelect.locator('option:checked').evaluate(option => ({
    value: option.value,
    extensionId: option.dataset.extensionId || null,
    lang: option.dataset.lang || null
  }));
  expect(selectedOption.extensionId).toBe(expectedExtensionId);

  await expect.poll(async () => popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ action: 'GET_PLAYBACK_STATE' });
    return response?.state?.options?.voiceName || null;
  }), { timeout: 10000 }).toBe(voiceName);
}

async function getSessionState(diagnosticsPage) {
  const response = await diagnosticsPage.evaluate(() =>
    chrome.runtime.sendMessage({ action: 'GET_SESSION_STORAGE' })
  );
  if (!response?.success) {
    throw new Error(response?.error || 'Diagnostics page could not read the session.');
  }
  return response.data?.readAloud_sessionState || null;
}

test('injects the floating player and keeps session diagnostics behind the extension page boundary', async ({
  extensionContext,
  extensionWorkers,
  articlePage
}) => {
  const targetTabId = await getActiveTabId(extensionWorkers.narratrace);
  expect(targetTabId).not.toBeNull();
  const popup = await openExtensionPage(
    extensionContext,
    extensionWorkers.narratraceId,
    'popup.html',
    `?tab=${targetTabId}`
  );
  const diagnostics = await openExtensionPage(
    extensionContext,
    extensionWorkers.narratraceId,
    'test.html'
  );

  await expect(articlePage.locator('#read-aloud-player-host')).toBeAttached();
  const playerReady = await articlePage.evaluate(() => {
    const host = document.querySelector('#read-aloud-player-host');
    return Boolean(host?.shadowRoot?.querySelector('#ra-play'));
  });
  expect(playerReady).toBe(true);

  await expect(popup.locator('#ctrl-play')).toBeVisible();
  const playbackState = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ action: 'GET_PLAYBACK_STATE' })
  );
  expect(playbackState.success).toBe(true);
  expect(playbackState.state.playbackState).toBe('IDLE');

  const popupDenied = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ action: 'GET_SESSION_STORAGE' })
  );
  expect(popupDenied.success).toBe(false);
  expect(popupDenied.error).toContain('restricted');

  const diagnosticsAllowed = await diagnostics.evaluate(() =>
    chrome.runtime.sendMessage({ action: 'GET_SESSION_STORAGE' })
  );
  expect(diagnosticsAllowed.success).toBe(true);

  const invalidRate = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ action: 'SET_RATE', rate: 'very fast' })
  );
  expect(invalidRate.success).toBe(false);
});

test('uses Chrome TTS word events and re-anchors highlighting after a live DOM replacement', async ({
  extensionContext,
  extensionWorkers,
  articlePage
}) => {
  const targetTabId = await getActiveTabId(extensionWorkers.narratrace);
  expect(targetTabId).not.toBeNull();
  const popup = await openExtensionPage(
    extensionContext,
    extensionWorkers.narratraceId,
    'popup.html',
    `?tab=${targetTabId}`
  );

  await extensionWorkers.fakeTtsEngine.evaluate(() => {
    globalThis.__NARRATRACE_TEST_DELAY_MS = 110;
  });
  await setTestVoice(popup, 'NarraTrace Browser Test Voice', extensionWorkers.fakeTtsEngineId);

  await popup.locator('#ctrl-play').click();

  await expect.poll(async () => popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ action: 'GET_PLAYBACK_STATE' });
    return response?.state?.playbackState;
  }), { timeout: 10000 }).toBe('PLAYING');

  const playback = await popup.evaluate(async () =>
    (await chrome.runtime.sendMessage({ action: 'GET_PLAYBACK_STATE' })).state
  );
  const initialTtsMetrics = await extensionWorkers.fakeTtsEngine.evaluate(() =>
    globalThis.__NARRATRACE_TEST_METRICS
  );
  console.log('[NARRATRACE_TTS_DIAGNOSTICS]', JSON.stringify({
    playbackState: playback.playbackState,
    selectedVoice: playback.options?.voiceName,
    selectedExtensionId: playback.options?.extensionId,
    fakeTtsEngineId: extensionWorkers.fakeTtsEngineId,
    initialTtsMetrics
  }));

  await expect.poll(async () => extensionWorkers.fakeTtsEngine.evaluate(() =>
    globalThis.__NARRATRACE_TEST_METRICS.wordCount
  ), { timeout: 10000 }).toBeGreaterThan(0);

  const wordBox = articlePage.locator('#read-aloud-player-host #ra-word-box');
  await expect(wordBox).toHaveClass(/visible/, { timeout: 10000 });

  // Wait until the active sentence Range reaches the first paragraph. The
  // first extracted block may be the article heading; use the actual sentence
  // Range because it is the one the MutationObserver must re-anchor.
  await expect.poll(() => articlePage.evaluate(() => {
    const highlights = window.CSS?.highlights?.get('read-aloud-sentence');
    const range = highlights ? Array.from(highlights)[0] : null;
    const paragraph = document.querySelector('#article-intro');
    return Boolean(range && paragraph && paragraph.contains(range.startContainer));
  }), { timeout: 15000 }).toBe(true);

  // Page churn outside the active sentence must not disturb its word capsule.
  await articlePage.evaluate(() => {
    const aside = document.querySelector('#unrelated-updates');
    for (let index = 0; index < 5; index += 1) {
      const marker = document.createElement('span');
      marker.textContent = `Live update ${index} `;
      aside.appendChild(marker);
    }
  });
  await expect(wordBox).toHaveClass(/visible/);

  // Replace the exact block containing the active sentence Range. This
  // ensures the removed node is the node that currently owns the playback range.
  const replacedBlock = await articlePage.evaluate(() => {
    const highlights = window.CSS?.highlights?.get('read-aloud-sentence');
    const range = highlights ? Array.from(highlights)[0] : null;
    const startElement = range && (range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer
      : range.startContainer.parentElement);
    const activeBlock = startElement?.closest('p, h1, h2, h3, h4, h5, h6, li, blockquote');
    if (!activeBlock || activeBlock.id !== 'article-intro') return null;

    activeBlock.dataset.e2eActiveBlock = 'true';
    const replacement = activeBlock.cloneNode(true);
    activeBlock.replaceWith(replacement);
    return {
      tagName: replacement.tagName,
      text: replacement.textContent
    };
  });
  expect(replacedBlock).not.toBeNull();

  await expect.poll(() => articlePage.evaluate(() => {
    const highlights = window.CSS?.highlights?.get('read-aloud-sentence');
    const range = highlights ? Array.from(highlights)[0] : null;
    const replacement = document.querySelector('[data-e2e-active-block="true"]');
    return Boolean(range && replacement && replacement.contains(range.startContainer));
  }), { timeout: 10000 }).toBe(true);

  await popup.locator('#ctrl-stop').click();
  await expect.poll(async () => popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ action: 'GET_PLAYBACK_STATE' });
    return response?.state?.playbackState;
  })).toBe('STOPPED');
});

test('exposes accessible controls and keyboard-operable playback progress', async ({
  extensionContext,
  extensionWorkers,
  articlePage
}) => {
  const targetTabId = await getActiveTabId(extensionWorkers.narratrace);
  expect(targetTabId).not.toBeNull();
  const popup = await openExtensionPage(
    extensionContext,
    extensionWorkers.narratraceId,
    'popup.html',
    `?tab=${targetTabId}`
  );

  await expect(popup.getByRole('main')).toBeVisible();
  await expect(popup.getByRole('status').first()).toBeAttached();
  const popupAudit = await popup.evaluate(() => {
    const unnamedButtons = Array.from(document.querySelectorAll('button'))
      .filter(button => !(
        button.getAttribute('aria-label') ||
        button.textContent.trim() ||
        button.title
      ))
      .map(button => button.id || button.outerHTML.slice(0, 100));

    const unnamedFields = Array.from(document.querySelectorAll('input, select'))
      .filter(field => !(
        field.getAttribute('aria-label') ||
        field.labels?.length
      ))
      .map(field => field.id || field.outerHTML.slice(0, 100));

    return { unnamedButtons, unnamedFields };
  });
  expect(popupAudit.unnamedButtons).toEqual([]);
  expect(popupAudit.unnamedFields).toEqual([]);

  const speedChips = await popup.locator('.speed-chip, .chip').evaluateAll(buttons =>
    buttons.every(button => button.hasAttribute('aria-pressed'))
  );
  expect(speedChips).toBe(true);

  const progress = articlePage.locator('#read-aloud-player-host #ra-progress-track');
  await expect(progress).toHaveAttribute('role', 'slider');
  await expect(progress).toHaveAttribute('tabindex', '0');
  await expect(progress).toHaveAttribute('aria-label', 'Playback progress');

  await extensionWorkers.fakeTtsEngine.evaluate(() => {
    globalThis.__NARRATRACE_TEST_DELAY_MS = 500;
  });
  await setTestVoice(popup, 'NarraTrace Browser Test Voice', extensionWorkers.fakeTtsEngineId);
  await popup.locator('#ctrl-play').click();

  let playback = null;
  await expect.poll(async () => popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ action: 'GET_PLAYBACK_STATE' });
    return response?.state?.playbackState;
  }), { timeout: 10000 }).toBe('PLAYING');

  playback = await popup.evaluate(async () =>
    (await chrome.runtime.sendMessage({ action: 'GET_PLAYBACK_STATE' })).state
  );
  expect(playback.totalSentences).toBeGreaterThan(1);

  await progress.focus();
  await progress.press('End');
  await expect.poll(async () => popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ action: 'GET_PLAYBACK_STATE' });
    return response?.state?.currentIndex;
  }), { timeout: 10000 }).toBe(playback.totalSentences - 1);
  await expect(progress).toHaveAttribute(
    'aria-valuetext',
    `Sentence ${playback.totalSentences} of ${playback.totalSentences}`
  );

  // Focus Reader acts as a dialog: it receives focus on open and returns it
  // to the invoking settings control on Escape.
  const playerPill = articlePage.locator('#read-aloud-player-host .player-pill');
  await playerPill.hover();
  const settingsButton = articlePage.locator('#read-aloud-player-host #ra-settings');
  await expect(settingsButton).toBeVisible();
  await settingsButton.click();
  const readerButton = articlePage.locator('#read-aloud-player-host #ra-settings-reader');
  await readerButton.click();

  const readerDialog = articlePage.locator('#read-aloud-player-host #ra-reader-overlay');
  await expect(readerDialog).toHaveAttribute('role', 'dialog');
  await expect(readerDialog).toHaveAttribute('aria-modal', 'true');
  await expect.poll(() => articlePage.evaluate(() =>
    document.querySelector('#read-aloud-player-host')?.shadowRoot?.activeElement?.id || ''
  )).toBe('ra-reader-close');

  await articlePage.keyboard.press('Escape');
  await expect(readerDialog).not.toHaveClass(/open/);
  await expect.poll(() => articlePage.evaluate(() =>
    document.querySelector('#read-aloud-player-host')?.shadowRoot?.activeElement?.id || ''
  )).toBe('ra-settings-reader');

  await popup.locator('#ctrl-stop').click();
});

test('scans a large local article and records browser performance and queue metrics', async ({
  extensionContext,
  extensionWorkers
}) => {
  const page = extensionContext.pages()[0] || await extensionContext.newPage();
  await page.goto('http://127.0.0.1:4173/large-article');
  await page.locator('#read-aloud-player-host').waitFor({ state: 'attached', timeout: 15000 });

  const targetTabId = await getActiveTabId(extensionWorkers.narratrace);
  expect(targetTabId).not.toBeNull();
  const popup = await openExtensionPage(
    extensionContext,
    extensionWorkers.narratraceId,
    'popup.html',
    `?tab=${targetTabId}`
  );
  const diagnostics = await openExtensionPage(
    extensionContext,
    extensionWorkers.narratraceId,
    'test.html'
  );

  await extensionWorkers.fakeTtsEngine.evaluate(() => {
    globalThis.__NARRATRACE_TEST_DELAY_MS = 500;
  });
  await setTestVoice(popup, 'NarraTrace Browser Test Voice', extensionWorkers.fakeTtsEngineId);

  const cdp = await extensionContext.newCDPSession(page);
  await cdp.send('Performance.enable');
  const startedAt = Date.now();

  await popup.locator('#ctrl-play').click();

  let session = null;
  await expect.poll(async () => {
    session = await getSessionState(diagnostics);
    return Array.isArray(session?.queue) ? session.queue.length : 0;
  }, { timeout: 20000 }).toBeGreaterThan(60);

  const extractionMs = Date.now() - startedAt;
  const metricsResponse = await cdp.send('Performance.getMetrics');
  const metrics = Object.fromEntries(metricsResponse.metrics.map(item => [item.name, item.value]));
  const usedHeapBytes = metrics.JSHeapUsedSize;

  console.log('[NARRATRACE_BROWSER_METRICS]', JSON.stringify({
    queueSentences: session.queue.length,
    extractionMs,
    jsHeapUsedMiB: Number.isFinite(usedHeapBytes)
      ? Number((usedHeapBytes / (1024 * 1024)).toFixed(2))
      : null,
    taskDurationSeconds: Number.isFinite(metrics.TaskDuration)
      ? Number(metrics.TaskDuration.toFixed(3))
      : null
  }));

  expect(session.queue.length).toBeGreaterThan(60);
  expect(extractionMs).toBeLessThan(15000);
  expect(Number.isFinite(usedHeapBytes)).toBe(true);
  expect(usedHeapBytes).toBeLessThan(256 * 1024 * 1024);

  await diagnostics.evaluate(() =>
    chrome.runtime.sendMessage({ action: 'STOP_PLAYBACK' })
  );
  await cdp.detach();
});
