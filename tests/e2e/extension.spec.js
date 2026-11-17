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

  // Replace the block that currently contains the active word. The first
  // extracted item can be a heading, so derive the target from the live Range
  // instead of assuming that the first paragraph is always sentence zero.
  const replacedBlock = await articlePage.evaluate(() => {
    const highlights = window.CSS?.highlights?.get('read-aloud-word');
    const range = highlights ? Array.from(highlights)[0] : null;
    if (!range) return null;

    const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer
      : range.startContainer.parentElement;
    const activeBlock = startElement?.closest('p, h1, h2, h3, h4, h5, h6, li, blockquote');
    if (!activeBlock) return null;

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
    const highlights = window.CSS?.highlights?.get('read-aloud-word');
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
