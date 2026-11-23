import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

const ARTICLE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Accessibility regression article</title>
</head>
<body>
  <main>
    <article>
      <h1>Accessibility regression article</h1>
      ${Array.from({ length: 8 }, (_, index) => `
        <p>Paragraph ${index + 1} describes the observed process and the measured results across several experimental conditions. Researchers recorded the next observation and reviewed the complete result carefully.</p>
      `).join('')}
    </article>
  </main>
</body>
</html>`;

async function closeBrowser(browser) {
  if (!browser) return;
  const process = browser.process();
  await Promise.race([
    browser.close().catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 5000))
  ]);
  if (process && process.exitCode === null) process.kill('SIGKILL');
}

async function waitForShadow(page, predicate, timeout = 10000) {
  await page.waitForFunction((fnSource) => {
    const host = document.getElementById('read-aloud-player-host');
    if (!host?.shadowRoot) return false;
    return Function('root', `return (${fnSource})(root)`)(host.shadowRoot);
  }, { timeout }, predicate.toString());
}

test('Focus Reader and player controls support keyboard navigation and focus restoration', {
  timeout: 60000
}, async (t) => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(ARTICLE);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      pipe: true,
      timeout: 20000,
      enableExtensions: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  } catch (error) {
    await new Promise(resolve => server.close(resolve));
    assert.fail(`Could not launch Chromium for accessibility checks: ${error.message}`);
  }

  t.after(async () => {
    await closeBrowser(browser);
    await new Promise(resolve => server.close(() => resolve()));
  });

  const extensionId = await browser.installExtension(REPOSITORY_ROOT);
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(`http://127.0.0.1:${address.port}/article`, {
    waitUntil: 'domcontentloaded',
    timeout: 10000
  });
  await waitForShadow(page, root => Boolean(root.getElementById('ra-settings')));

  // Reduced motion must disable decorative CSS animation and transitions
  // throughout the Shadow DOM, not only on the word indicator and waveform.
  const reducedMotionStyles = await page.evaluate(() => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    const player = root.querySelector('.player-pill');
    const play = root.getElementById('ra-play');
    player.classList.add('is-playing');
    return {
      playerTransition: getComputedStyle(player).transitionDuration,
      playAnimation: getComputedStyle(play).animationName,
      playTransition: getComputedStyle(play).transitionDuration,
      waveformAnimation: getComputedStyle(root.querySelector('.ra-audio-wave .bar')).animationName
    };
  });
  assert.equal(reducedMotionStyles.playerTransition, '0s');
  assert.equal(reducedMotionStyles.playAnimation, 'none');
  assert.equal(reducedMotionStyles.playTransition, '0s');
  assert.equal(reducedMotionStyles.waveformAnimation, 'none');
  await page.bringToFront();

  // Open settings from the real Shadow DOM trigger. Keyboard navigation is
  // exercised inside the panel and dialog below; a direct activation here
  // keeps this setup step independent of platform-specific Enter-key timing.
  await page.evaluate(() => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    const trigger = root.getElementById('ra-settings');
    trigger.focus();
    trigger.click();
  });
  await page.waitForFunction(() => {
    const root = document.getElementById('read-aloud-player-host')?.shadowRoot;
    return root?.getElementById('ra-settings-panel')?.getAttribute('aria-hidden') === 'false' &&
      root.activeElement?.id === 'ra-settings-close';
  });

  const settingsOpen = await page.evaluate(() => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    const panel = root.getElementById('ra-settings-panel');
    return {
      expanded: root.getElementById('ra-settings').getAttribute('aria-expanded'),
      hidden: panel.getAttribute('aria-hidden'),
      inert: panel.inert,
      activeId: root.activeElement?.id,
      role: panel.getAttribute('role'),
      labelledBy: panel.getAttribute('aria-labelledby'),
      titleText: root.getElementById('ra-settings-title')?.textContent,
      speedValueText: root.getElementById('ra-speed-range')?.getAttribute('aria-valuetext'),
      volumeValueText: root.getElementById('ra-volume-range')?.getAttribute('aria-valuetext'),
      voiceStatusRole: root.getElementById('ra-voice-status')?.getAttribute('role'),
      voiceStatusLive: root.getElementById('ra-voice-status')?.getAttribute('aria-live'),
      statusToastRole: root.getElementById('ra-status-toast')?.getAttribute('role'),
      statusToastLive: root.getElementById('ra-status-toast')?.getAttribute('aria-live'),
      resumeGroupRole: root.getElementById('ra-resume-toast')?.getAttribute('role'),
      resumeTextRole: root.getElementById('ra-resume-text')?.getAttribute('role'),
      resumeTextLive: root.getElementById('ra-resume-text')?.getAttribute('aria-live'),
      resumeCloseName: root.getElementById('ra-resume-close')?.getAttribute('aria-label'),
      themeGroup: root.querySelector('.theme-row[aria-label="Player theme"]')?.getAttribute('role'),
      themeGroupName: root.querySelector('.theme-row[aria-label="Player theme"]')?.getAttribute('aria-label'),
      themePressed: Array.from(root.querySelectorAll('.theme-btn[data-theme]'), button => button.getAttribute('aria-pressed')),
      highlightGroup: root.querySelector('.theme-row[aria-label="Word highlight color"]')?.getAttribute('role'),
      highlightGroupName: root.querySelector('.theme-row[aria-label="Word highlight color"]')?.getAttribute('aria-label'),
      highlightPressed: Array.from(root.querySelectorAll('.color-swatch[data-color]'), button => button.getAttribute('aria-pressed'))
    };
  });
  assert.deepEqual(settingsOpen, {
    expanded: 'true',
    hidden: 'false',
    inert: false,
    activeId: 'ra-settings-close',
    role: 'dialog',
    labelledBy: 'ra-settings-title',
    titleText: 'SETTINGS',
    speedValueText: '1.0 times playback speed',
    volumeValueText: '100 percent volume',
    voiceStatusRole: 'status',
    voiceStatusLive: 'polite',
    statusToastRole: 'status',
    statusToastLive: 'polite',
    resumeGroupRole: 'group',
    resumeTextRole: 'status',
    resumeTextLive: 'polite',
    resumeCloseName: 'Dismiss resume prompt',
    themeGroup: 'group',
    themeGroupName: 'Player theme',
    themePressed: ['true', 'false'],
    highlightGroup: 'group',
    highlightGroupName: 'Word highlight color',
    highlightPressed: ['true', 'false', 'false', 'false']
  });

  // Speed and volume sliders announce readable values as they change.
  await page.evaluate(() => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    const speed = root.getElementById('ra-speed-range');
    const volume = root.getElementById('ra-volume-range');
    speed.value = '1.4';
    speed.dispatchEvent(new Event('input', { bubbles: true }));
    volume.value = '0.35';
    volume.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const root = document.getElementById('read-aloud-player-host')?.shadowRoot;
    return root?.getElementById('ra-speed-range')?.getAttribute('aria-valuetext') === '1.4 times playback speed' &&
      root?.getElementById('ra-volume-range')?.getAttribute('aria-valuetext') === '35 percent volume' &&
      root?.getElementById('ra-speed-display')?.textContent === '1.4×' &&
      root?.getElementById('ra-volume-display')?.textContent === '35%';
  });

  // Selected theme and highlight colors must be exposed as toggle states,
  // not only as visual CSS classes.
  await page.evaluate(() => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    root.querySelector('.theme-btn[data-theme="light"]').click();
    root.querySelector('.color-swatch[data-color="green"]').click();
  });
  await page.waitForFunction(() => {
    const root = document.getElementById('read-aloud-player-host')?.shadowRoot;
    return root?.querySelector('.theme-btn[data-theme="light"]')?.getAttribute('aria-pressed') === 'true' &&
      root?.querySelector('.color-swatch[data-color="green"]')?.getAttribute('aria-pressed') === 'true';
  });
  await page.evaluate(() => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    root.querySelector('.theme-btn[data-theme="te"]').click();
    root.querySelector('.color-swatch[data-color="orange"]').click();
  });

  // Activate Focus Reader from Settings. The settings popover closes first,
  // then the modal reader takes focus.
  await page.evaluate(() => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    const trigger = root.getElementById('ra-settings-reader');
    trigger.focus();
    trigger.click();
  });
  await page.waitForFunction(() => {
    const root = document.getElementById('read-aloud-player-host')?.shadowRoot;
    const dialog = root?.getElementById('ra-reader-overlay');
    return dialog?.getAttribute('aria-hidden') === 'false' &&
      root.activeElement?.id === 'ra-reader-close';
  });

  const dialog = await page.evaluate(() => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    const el = root.getElementById('ra-reader-overlay');
    const focusable = Array.from(el.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(item => !item.closest('[inert]') && item.getClientRects().length > 0);
    return {
      role: el.getAttribute('role'),
      modal: el.getAttribute('aria-modal'),
      labelledBy: el.getAttribute('aria-labelledby'),
      titleExists: Boolean(root.getElementById(el.getAttribute('aria-labelledby'))),
      hidden: el.getAttribute('aria-hidden'),
      inert: el.inert,
      activeId: root.activeElement?.id,
      focusableIds: focusable.map(item => item.id)
    };
  });
  assert.equal(dialog.role, 'dialog');
  assert.equal(dialog.modal, 'true');
  assert.ok(dialog.labelledBy);
  assert.equal(dialog.titleExists, true);
  assert.equal(dialog.hidden, 'false');
  assert.equal(dialog.inert, false);
  assert.equal(dialog.activeId, 'ra-reader-close');
  assert.ok(dialog.focusableIds.length >= 5, 'reader dialog should expose its controls to keyboard users');

  // Editorial design quality contract: restrained type system, readable body,
  // genuine visual hierarchy, named theme controls, and accessible selected state.
  const readerVisual = await page.evaluate(() => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    const body = root.getElementById('ra-reader-body');
    const title = root.getElementById('ra-reader-title');
    const panel = root.getElementById('ra-reader-overlay');
    const firstTheme = root.querySelector('.reader-th-btn[data-rtheme="cream"]');
    const wordStyle = getComputedStyle(root.querySelector('.reader-word-active') || body);
    return {
      fontSize: parseFloat(getComputedStyle(body).fontSize),
      lineHeight: parseFloat(getComputedStyle(body).lineHeight),
      bodyFont: getComputedStyle(body).fontFamily,
      titleFont: getComputedStyle(title).fontFamily,
      titleSize: parseFloat(getComputedStyle(title).fontSize),
      readerWidth: parseFloat(getComputedStyle(root.querySelector('.reader-content-card')).maxWidth),
      themeName: firstTheme.getAttribute('aria-label'),
      themePressed: firstTheme.getAttribute('aria-pressed'),
      headerMinHeight: parseFloat(getComputedStyle(root.querySelector('.reader-header')).minHeight),
      controlSize: Math.round(root.getElementById('ra-rctrl-play').getBoundingClientRect().width),
      fontDecreaseName: root.getElementById('ra-font-dec').getAttribute('aria-label'),
      fontIncreaseName: root.getElementById('ra-font-inc').getAttribute('aria-label'),
      fontSelectName: root.getElementById('ra-reader-font').getAttribute('aria-label'),
      fontGroupName: root.querySelector('.reader-tool-group[role="group"]')?.getAttribute('aria-label'),
      themeGroupName: root.querySelector('.reader-theme-group[role="group"]')?.getAttribute('aria-label'),
      playControls: root.getElementById('ra-rctrl-play').getAttribute('aria-controls'),
      paragraphPlayName: root.getElementById('ra-hover-play').getAttribute('aria-label'),
      selectionPlayName: root.getElementById('ra-selection-play').getAttribute('aria-label')
    };
  });
  assert.equal(readerVisual.fontSize, 20);
  assert.ok(readerVisual.lineHeight >= 36, 'reading text should retain generous line spacing');
  assert.match(readerVisual.bodyFont, /sans-serif/i);
  assert.match(readerVisual.titleFont, /serif/i);
  assert.ok(readerVisual.titleSize >= 32, 'article title should establish a clear editorial hierarchy');
  assert.equal(readerVisual.readerWidth, 680);
  assert.equal(readerVisual.themeName, 'Warm paper theme');
  assert.equal(readerVisual.themePressed, 'true');
  assert.ok(readerVisual.controlSize >= 44);
  assert.equal(readerVisual.fontDecreaseName, 'Decrease reading text size');
  assert.equal(readerVisual.fontIncreaseName, 'Increase reading text size');
  assert.equal(readerVisual.fontSelectName, 'Reading font');
  assert.equal(readerVisual.fontGroupName, 'Reading text size');
  assert.equal(readerVisual.themeGroupName, 'Reading color theme');
  assert.equal(readerVisual.playControls, 'ra-reader-body');
  assert.equal(readerVisual.paragraphPlayName, 'Read this paragraph aloud');
  assert.equal(readerVisual.selectionPlayName, 'Read selected text aloud');

  // Each reading palette exposes a distinct accessible name and selected state.
  await page.evaluate(() => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    root.querySelector('.reader-th-btn[data-rtheme="sepia"]').click();
  });
  await page.waitForFunction(() => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    return root.querySelector('.reader-th-btn[data-rtheme="sepia"]')?.getAttribute('aria-pressed') === 'true';
  });
  const selectedThemeState = await page.evaluate(() => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    return Array.from(root.querySelectorAll('.reader-th-btn'), button => button.getAttribute('aria-pressed'));
  });
  assert.deepEqual(selectedThemeState, ['false', 'false', 'true', 'false']);

  // Every reading palette must preserve WCAG AA contrast for body copy and
  // the active word treatment. The visual system must never trade readability
  // for an atmospheric color treatment.
  const paletteContrast = await page.evaluate(() => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    const overlay = root.getElementById('ra-reader-overlay');
    const body = root.getElementById('ra-reader-body');
    const sampleSentence = document.createElement('span');
    sampleSentence.className = 'reader-sentence active-sentence';
    const sampleWord = document.createElement('span');
    sampleWord.className = 'reader-word-active';
    sampleWord.textContent = 'highlight';
    sampleSentence.appendChild(sampleWord);
    body.appendChild(sampleSentence);

    const parse = (value) => {
      const values = value.match(/[0-9.]+/g)?.map(Number) || [];
      return values.slice(0, 3).map(channel => channel / 255);
    };
    const luminance = (color) => {
      const channels = parse(color).map(value =>
        value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)
      );
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const ratio = (foreground, background) => {
      const a = luminance(foreground);
      const b = luminance(background);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };

    const measurements = ['cream', 'dark', 'sepia', 'oled'].map(theme => {
      root.querySelector(`.reader-th-btn[data-rtheme="${theme}"]`).click();
      const bodyColor = getComputedStyle(body).color;
      const surfaceColor = getComputedStyle(overlay).backgroundColor;
      const wordColor = getComputedStyle(sampleWord).color;
      const wordBackground = getComputedStyle(sampleWord).backgroundColor;
      const metadataColor = getComputedStyle(root.querySelector('.reader-meta')).color;
      return {
        theme,
        bodyContrast: ratio(bodyColor, surfaceColor),
        metadataContrast: ratio(metadataColor, surfaceColor),
        wordContrast: ratio(wordColor, wordBackground)
      };
    });

    sampleSentence.remove();
    root.querySelector('.reader-th-btn[data-rtheme="cream"]').click();
    return measurements;
  });
  for (const palette of paletteContrast) {
    assert.ok(palette.bodyContrast >= 4.5, `${palette.theme} body text must meet WCAG AA contrast`);
    assert.ok(palette.metadataContrast >= 4.5, `${palette.theme} metadata must meet WCAG AA contrast; got ${palette.metadataContrast.toFixed(2)}:1`);
    assert.ok(palette.wordContrast >= 4.5, `${palette.theme} highlighted word must meet WCAG AA contrast`);
  }
  await page.evaluate(() => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    root.querySelector('.reader-th-btn[data-rtheme="cream"]').click();
  });

  // A narrow viewport must keep the reader bar within the visible screen width.
  await page.setViewport({ width: 390, height: 844 });
  const narrowReader = await page.evaluate(() => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    const overlay = root.getElementById('ra-reader-overlay');
    const bar = root.querySelector('.reader-bar');
    const headerRight = root.querySelector('.reader-header-right');
    return {
      viewport: window.innerWidth,
      barLeft: Math.round(bar.getBoundingClientRect().left),
      barRight: Math.round(bar.getBoundingClientRect().right),
      headerRightWidth: Math.round(headerRight.getBoundingClientRect().width),
      readerVisible: getComputedStyle(overlay).pointerEvents !== 'none'
    };
  });
  assert.ok(narrowReader.barLeft >= 0, 'reader controls should not clip beyond the left edge on narrow screens');
  assert.ok(narrowReader.barRight <= narrowReader.viewport, 'reader controls should remain inside narrow screens');
  assert.equal(narrowReader.readerVisible, true);
  await page.setViewport({ width: 800, height: 600 });


  // Tab and Shift+Tab must remain inside the reader dialog.
  const first = dialog.focusableIds[0];
  const last = dialog.focusableIds[dialog.focusableIds.length - 1];
  await page.keyboard.down('Shift');
  await page.keyboard.press('Tab');
  await page.keyboard.up('Shift');
  await page.waitForFunction(expected => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    return root.activeElement?.id === expected;
  }, {}, last);
  await page.keyboard.press('Tab');
  await page.waitForFunction(expected => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    return root.activeElement?.id === expected;
  }, {}, first);

  // Both progress sliders expose current sentence information and support
  // keyboard seeking with arrow keys, Home, and End.
  await page.evaluate(() => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    root.getElementById('ra-rprogress-track').focus();
  });
  const initialProgress = await page.evaluate(() => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    const reader = root.getElementById('ra-rprogress-track');
    const pill = root.getElementById('ra-progress-track');
    return {
      role: reader.getAttribute('role'),
      tabIndex: reader.tabIndex,
      valueText: reader.getAttribute('aria-valuetext'),
      min: reader.getAttribute('aria-valuemin'),
      max: reader.getAttribute('aria-valuemax'),
      pillValueText: pill.getAttribute('aria-valuetext')
    };
  });
  assert.equal(initialProgress.role, 'slider');
  assert.equal(initialProgress.tabIndex, 0);
  assert.match(initialProgress.valueText, /Sentence 1 of (?:[2-9]|[1-9][0-9]+)/);
  assert.equal(initialProgress.valueText, initialProgress.pillValueText);
  assert.equal(initialProgress.min, '0');
  assert.equal(initialProgress.max, '100');

  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    return root.getElementById('ra-rprogress-track').getAttribute('aria-valuetext')?.startsWith('Sentence 2 of ') &&
      root.getElementById('ra-rprogress-track').getAttribute('aria-valuetext') ===
      root.getElementById('ra-progress-track').getAttribute('aria-valuetext');
  });
  await page.keyboard.press('End');
  const endValue = await page.evaluate(() => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    return root.getElementById('ra-rprogress-track').getAttribute('aria-valuetext');
  });
  assert.match(endValue, /Sentence [1-9][0-9]* of [1-9][0-9]*/);
  assert.ok(!endValue.startsWith('Sentence 1 of '), 'End should move to the final sentence');

  // Reproduce the docked-player edge case deterministically: after its
  // auto-tuck, CSS hides the pill-body that contains the Settings opener.
  // Closing the reader must reveal that opener before restoring focus.
  await page.evaluate(() => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    root.querySelector('.player-pill').classList.add('pill-mini', 'is-tucked', 'beaded');
    const settings = root.getElementById('ra-settings');
    if (settings.getClientRects().length !== 0) {
      throw new Error('Expected the beaded player to hide its Settings trigger');
    }
  });

  // Escape closes the dialog, hides it from AT, and restores focus to its opener.
  await page.keyboard.press('Escape');
  await new Promise(resolve => setTimeout(resolve, 100));
  const afterReaderEscape = await page.evaluate(() => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    const dialog = root.getElementById('ra-reader-overlay');
    return {
      isOpen: dialog.classList.contains('open'),
      inert: dialog.inert,
      ariaHidden: dialog.getAttribute('aria-hidden'),
      activeId: root.activeElement?.id,
      playerBeaded: root.querySelector('.player-pill')?.classList.contains('beaded'),
      playerMini: root.querySelector('.player-pill')?.classList.contains('pill-mini'),
      focusRestoring: root.querySelector('.player-pill')?.classList.contains('focus-restoring')
    };
  });
  console.log('[NarraTrace accessibility reader Escape]', JSON.stringify(afterReaderEscape));
  assert.equal(afterReaderEscape.isOpen, false, 'Escape should remove the reader open state');
  assert.equal(afterReaderEscape.inert, true, 'Escape should make the reader dialog inert');
  assert.equal(afterReaderEscape.ariaHidden, 'true', 'Escape should hide the reader dialog from assistive technology');
  assert.equal(afterReaderEscape.activeId, 'ra-settings', 'Escape should restore focus to the settings trigger');
  assert.equal(afterReaderEscape.playerBeaded, false, 'Restoring focus should untuck the player first');
  assert.equal(afterReaderEscape.playerMini, true, 'Focus restoration should preserve the user-selected mini layout');
  assert.equal(afterReaderEscape.focusRestoring, false, 'Temporary focus styling should not persist as a saved layout change');

  // Escape also closes settings, updates expanded state, and restores focus.
  await page.evaluate(() => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    const trigger = root.getElementById('ra-settings');
    trigger.focus();
    trigger.click();
  });
  await page.waitForFunction(() => {
    const root = document.getElementById('read-aloud-player-host')?.shadowRoot;
    return root?.activeElement?.id === 'ra-settings-close';
  });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    const panel = root.getElementById('ra-settings-panel');
    const player = root.querySelector('.player-pill');
    return panel.inert &&
      panel.getAttribute('aria-hidden') === 'true' &&
      root.getElementById('ra-settings').getAttribute('aria-expanded') === 'false' &&
      root.activeElement?.id === 'ra-settings' &&
      player.classList.contains('pill-mini') &&
      !player.classList.contains('focus-restoring');
  });

  // Both ready and warning engine badges must remain legible in the light theme.
  // Its status color is text, so test the rendered foreground against the
  // composited translucent badge surface rather than checking token values.
  assert.equal(typeof extensionId, 'string');
  const popupPage = await browser.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 10000
  });
  await popupPage.waitForFunction(() => document.body.classList.contains('is-hydrated'));
  await popupPage.click('#theme-toggle');
  await popupPage.waitForFunction(() => document.body.classList.contains('light'));
  const popupStatusContrasts = await popupPage.evaluate(() => {
    const badge = document.querySelector('.engine-badge');
    const body = document.body;
    const measureContrast = (warning) => {
      badge.classList.toggle('warning', warning);
      const foreground = getComputedStyle(badge).color.match(/[0-9.]+/g).map(Number);
      const overlay = getComputedStyle(badge).backgroundColor.match(/[0-9.]+/g).map(Number);
      const surface = getComputedStyle(body).backgroundColor.match(/[0-9.]+/g).map(Number);
      const alpha = overlay[3] ?? 1;
      const background = surface.slice(0, 3).map((channel, index) =>
        overlay[index] * alpha + channel * (1 - alpha)
      );
      const luminance = channels => channels.map(channel => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
      }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      const a = luminance(foreground);
      const b = luminance(background);
      return {
        state: warning ? 'warning' : 'ready',
        foreground: getComputedStyle(badge).color,
        background: getComputedStyle(badge).backgroundColor,
        contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      };
    };
    return [measureContrast(false), measureContrast(true)];
  });
  for (const status of popupStatusContrasts) {
    assert.ok(
      status.contrast >= 4.5,
      `Light-theme ${status.state} engine status text must meet WCAG AA contrast; got ${status.contrast.toFixed(2)}:1 (${status.foreground} on ${status.background})`
    );
  }

  // Every range control must expose a human-readable value, not an ambiguous
  // bare number, while retaining its native associated form label.
  const popupControlSemantics = await popupPage.evaluate(() => {
    const labelFor = id => Array.from(document.querySelectorAll(`label[for="${id}"]`))
      .map(label => label.textContent.trim()).join(' ');
    return {
      voiceLabel: labelFor('popup-voice-select'),
      voiceDescribedBy: document.getElementById('popup-voice-select').getAttribute('aria-describedby'),
      voiceStatusRole: document.getElementById('voice-substatus').getAttribute('role'),
      voiceStatusLive: document.getElementById('voice-substatus').getAttribute('aria-live'),
      voiceStatusAtomic: document.getElementById('voice-substatus').getAttribute('aria-atomic'),
      speedLabel: labelFor('popup-speed-slider'),
      volumeLabel: labelFor('popup-volume-slider'),
      speedValueText: document.getElementById('popup-speed-slider').getAttribute('aria-valuetext'),
      volumeValueText: document.getElementById('popup-volume-slider').getAttribute('aria-valuetext'),
      speedChipGroup: document.querySelector('.speed-chips').getAttribute('aria-label'),
      playName: document.getElementById('ctrl-play').getAttribute('aria-label'),
      playPressed: document.getElementById('ctrl-play').getAttribute('aria-pressed')
    };
  });
  assert.equal(popupControlSemantics.voiceLabel, 'VOICE ENGINE');
  assert.equal(popupControlSemantics.voiceDescribedBy, 'voice-substatus');
  assert.equal(popupControlSemantics.voiceStatusRole, 'status');
  assert.equal(popupControlSemantics.voiceStatusLive, 'polite');
  assert.equal(popupControlSemantics.voiceStatusAtomic, 'true');
  assert.equal(popupControlSemantics.speedLabel, 'PLAYBACK SPEED');
  assert.equal(popupControlSemantics.volumeLabel, 'VOLUME');
  // The popup must hydrate the settings changed earlier through the content-side controls.
  assert.equal(popupControlSemantics.speedValueText, '1.4 times playback speed');
  assert.equal(popupControlSemantics.volumeValueText, '35 percent volume');
  assert.equal(popupControlSemantics.speedChipGroup, 'Playback speed presets');
  assert.equal(popupControlSemantics.playName, 'Play reading');
  assert.equal(popupControlSemantics.playPressed, 'false');

  // Playback state changes must describe the action that will happen next.
  // Send the same broadcast used by the background worker during real playback.
  const popupWorkerTarget = await browser.waitForTarget((target) =>
    target.type() === 'service_worker' &&
    target.url().startsWith(`chrome-extension://${extensionId}/`)
  , { timeout: 10000 });
  const popupWorker = await popupWorkerTarget.worker();
  const dispatchPlaybackState = async (action) => {
    await popupWorker.evaluate(async ({ action, targetUrl }) => {
      const tabs = await chrome.tabs.query({});
      const deliveredTo = [];
      for (const tab of tabs) {
        if (typeof tab.id !== 'number') continue;
        try {
          await chrome.tabs.sendMessage(tab.id, { action });
          deliveredTo.push(tab.id);
        } catch {
          // Tabs without a NarraTrace content script are expected here.
        }
      }
      if (deliveredTo.length === 0) {
        throw new Error(`No NarraTrace content script received ${action}; available tab IDs: ${tabs.map(tab => tab.id).join(', ')}`);
      }
      // The popup listens to extension runtime messages; content scripts are
      // addressed through tabs.sendMessage. Exercise both real delivery paths.
      await chrome.runtime.sendMessage({ action }).catch(() => {});
    }, { action, targetUrl: page.url() });
  };
  await dispatchPlaybackState('PLAYBACK_PAUSED');
  await popupPage.waitForFunction(() => {
    const play = document.getElementById('ctrl-play');
    return play.getAttribute('aria-label') === 'Resume reading' &&
      play.getAttribute('aria-pressed') === 'false';
  });

  await page.waitForFunction(() => {
    const root = document.getElementById('read-aloud-player-host')?.shadowRoot;
    const controls = [root?.getElementById('ra-play'), root?.getElementById('ra-rctrl-play')];
    return controls.every(control =>
      control?.getAttribute('aria-label') === 'Resume reading' &&
      control.getAttribute('aria-pressed') === 'false'
    );
  });

  // Opening Focus Reader while paused must preserve the correct next action;
  // the overlay is created on demand and synchronizes from playback state.
  await page.evaluate(() => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    root.getElementById('ra-settings').click();
  });
  await page.waitForFunction(() => {
    const root = document.getElementById('read-aloud-player-host')?.shadowRoot;
    return root?.getElementById('ra-settings-panel')?.getAttribute('aria-hidden') === 'false';
  });
  await page.evaluate(() => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    root.getElementById('ra-settings-reader').click();
  });
  await page.waitForFunction(() => {
    const root = document.getElementById('read-aloud-player-host')?.shadowRoot;
    const reader = root?.getElementById('ra-reader-overlay');
    const play = root?.getElementById('ra-rctrl-play');
    return reader?.getAttribute('aria-hidden') === 'false' &&
      play?.getAttribute('aria-label') === 'Resume reading' &&
      play.getAttribute('aria-pressed') === 'false';
  });
  await page.evaluate(() => {
    const root = document.getElementById('read-aloud-player-host').shadowRoot;
    root.getElementById('ra-reader-close').click();
  });
  await page.waitForFunction(() => {
    const root = document.getElementById('read-aloud-player-host')?.shadowRoot;
    return root?.getElementById('ra-reader-overlay')?.getAttribute('aria-hidden') === 'true';
  });

  await dispatchPlaybackState('PLAYBACK_RESUMED');
  await popupPage.waitForFunction(() => {
    const play = document.getElementById('ctrl-play');
    return play.getAttribute('aria-label') === 'Pause reading' &&
      play.getAttribute('aria-pressed') === 'true';
  });

  await page.waitForFunction(() => {
    const root = document.getElementById('read-aloud-player-host')?.shadowRoot;
    const controls = [root?.getElementById('ra-play'), root?.getElementById('ra-rctrl-play')];
    return controls.every(control =>
      control?.getAttribute('aria-label') === 'Pause reading' &&
      control.getAttribute('aria-pressed') === 'true'
    );
  });

  // Advance the in-page progress before stopping, then verify that both
  // page-level sliders clear their stale sentence announcement.
  await popupWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const message = {
      action: 'SENTENCE_CHANGED',
      sentence: { text: 'A sentence used for page progress accessibility.' },
      index: 2,
      totalSentences: 10
    };
    let delivered = false;
    for (const tab of tabs) {
      if (typeof tab.id !== 'number') continue;
      try {
        await chrome.tabs.sendMessage(tab.id, message);
        delivered = true;
      } catch {
        // Browser-created and extension pages without NarraTrace are expected.
      }
    }
    if (!delivered) throw new Error('No NarraTrace content script received the sentence-progress fixture.');
  });
  await page.waitForFunction(() => {
    const root = document.getElementById('read-aloud-player-host')?.shadowRoot;
    const tracks = [root?.getElementById('ra-progress-track'), root?.getElementById('ra-rprogress-track')];
    return tracks.every(track =>
      track?.getAttribute('aria-valuenow') === '30' &&
      track.getAttribute('aria-valuetext') === 'Sentence 3 of 10'
    );
  });

  await dispatchPlaybackState('PLAYBACK_STOPPED');
  await popupPage.waitForFunction(() => {
    const play = document.getElementById('ctrl-play');
    return play.getAttribute('aria-label') === 'Play reading' &&
      play.getAttribute('aria-pressed') === 'false';
  });

  await page.waitForFunction(() => {
    const root = document.getElementById('read-aloud-player-host')?.shadowRoot;
    const controls = [root?.getElementById('ra-play'), root?.getElementById('ra-rctrl-play')];
    const tracks = [root?.getElementById('ra-progress-track'), root?.getElementById('ra-rprogress-track')];
    return controls.every(control =>
      control?.getAttribute('aria-label') === 'Play reading' &&
      control.getAttribute('aria-pressed') === 'false'
    ) && tracks.every(track =>
      track?.getAttribute('aria-valuenow') === '0' &&
      track.getAttribute('aria-valuetext') === 'No sentences loaded'
    );
  });

  await popupPage.$eval('#popup-speed-slider', slider => {
    slider.value = '1.5';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await popupPage.$eval('#popup-volume-slider', slider => {
    slider.value = '0.4';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await popupPage.waitForFunction(() =>
    document.getElementById('popup-speed-slider').getAttribute('aria-valuetext') === '1.5 times playback speed' &&
    document.getElementById('popup-volume-slider').getAttribute('aria-valuetext') === '40 percent volume' &&
    document.querySelector('.chip[data-speed="1.5"]').getAttribute('aria-pressed') === 'true'
  );

  // Light-theme controls retain visible boundaries, readable labels, and
  // a focus indicator with sufficient contrast against the warm surface.
  await popupPage.focus('#popup-voice-select');
  await popupPage.keyboard.press('Tab');
  await popupPage.hover('.chip[data-speed="1.5"]');
  // The chip animates its hover/selected colors. Wait for the final rendered
  // state rather than sampling a partially blended transition frame.
  await popupPage.waitForFunction(() => {
    const chip = document.querySelector('.chip[data-speed="1.5"]');
    if (!chip || chip.getAttribute('aria-pressed') !== 'true' || !chip.matches(':hover')) return false;
    const accent = getComputedStyle(document.body).getPropertyValue('--ra-accent').trim();
    const probe = document.createElement('span');
    probe.style.color = accent;
    document.body.appendChild(probe);
    const expectedBackground = getComputedStyle(probe).color;
    probe.remove();
    const styles = getComputedStyle(chip);
    return styles.backgroundColor === expectedBackground &&
      styles.color === 'rgb(255, 255, 255)';
  }, { timeout: 3000 });
  const lightControlContrast = await popupPage.evaluate(() => {
    const speed = document.getElementById('popup-speed-slider');
    const voice = document.getElementById('popup-voice-select');
    const chip = document.querySelector('.chip[data-speed="1.5"]');
    const value = document.getElementById('popup-speed-display');
    if (!speed || !voice || !chip || !value) {
      throw new Error('Expected popup slider, voice selector, speed preset, and value label to exist.');
    }
    // Headless Chrome can expose no system TTS voices. Add a temporary option
    // so its light-theme foreground/background style can still be verified.
    let option = voice.options[0];
    if (!option) {
      option = document.createElement('option');
      option.value = 'contrast-test';
      option.textContent = 'Contrast test voice';
      voice.appendChild(option);
    }
    const rgb = value => value.match(/[0-9.]+/g).slice(0, 3).map(Number);
    const luminance = channels => channels.map(channel => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const ratio = (foreground, background) => {
      const a = luminance(rgb(foreground));
      const b = luminance(rgb(background));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const thumb = getComputedStyle(speed, '::-webkit-slider-thumb');
    return {
      speedTrack: getComputedStyle(speed).backgroundColor,
      speedTrackContrast: ratio(getComputedStyle(speed).backgroundColor, getComputedStyle(document.body).backgroundColor),
      speedThumb: thumb.backgroundColor,
      speedThumbContrast: ratio(thumb.backgroundColor, getComputedStyle(document.body).backgroundColor),
      selectBorder: getComputedStyle(voice).borderTopColor,
      selectSurface: getComputedStyle(voice).backgroundColor,
      selectBorderContrast: ratio(getComputedStyle(voice).borderTopColor, getComputedStyle(voice).backgroundColor),
      optionText: getComputedStyle(option).color,
      optionSurface: getComputedStyle(option).backgroundColor,
      optionTextContrast: ratio(getComputedStyle(option).color, getComputedStyle(option).backgroundColor),
      selectedChipText: getComputedStyle(chip).color,
      selectedChipSurface: getComputedStyle(chip).backgroundColor,
      selectedChipHovered: chip.matches(':hover'),
      selectedChipPressed: chip.getAttribute('aria-pressed'),
      selectedChipTextContrast: ratio(getComputedStyle(chip).color, getComputedStyle(chip).backgroundColor),
      valueText: getComputedStyle(value).color,
      valueContrast: ratio(getComputedStyle(value).color, getComputedStyle(document.body).backgroundColor),
      focusOutline: getComputedStyle(speed).outlineColor,
      focusOutlineContrast: ratio(getComputedStyle(speed).outlineColor, getComputedStyle(document.body).backgroundColor),
      focusedControl: document.activeElement?.id
    };
  });
  assert.ok(
    lightControlContrast.speedTrackContrast >= 3,
    `Light-theme speed track must meet 3:1 non-text contrast; got ${lightControlContrast.speedTrackContrast.toFixed(2)}:1`
  );
  assert.ok(
    lightControlContrast.speedThumbContrast >= 3,
    `Light-theme speed thumb must meet 3:1 non-text contrast; got ${lightControlContrast.speedThumbContrast.toFixed(2)}:1`
  );
  assert.ok(
    lightControlContrast.selectBorderContrast >= 3,
    `Light-theme voice selector border must meet 3:1 non-text contrast; got ${lightControlContrast.selectBorderContrast.toFixed(2)}:1`
  );
  assert.ok(
    lightControlContrast.optionTextContrast >= 4.5,
    `Light-theme voice option text must meet WCAG AA; got ${lightControlContrast.optionTextContrast.toFixed(2)}:1`
  );
  assert.ok(
    lightControlContrast.selectedChipTextContrast >= 4.5,
    `Light-theme selected speed preset text must meet WCAG AA; got ${lightControlContrast.selectedChipTextContrast.toFixed(2)}:1 (${lightControlContrast.selectedChipText} on ${lightControlContrast.selectedChipSurface}; aria-pressed=${lightControlContrast.selectedChipPressed})`
  );
  assert.equal(lightControlContrast.selectedChipHovered, true);
  assert.equal(lightControlContrast.selectedChipPressed, 'true');
  assert.notEqual(lightControlContrast.selectedChipSurface, 'rgba(252, 249, 243, 1)');
  assert.ok(
    lightControlContrast.valueContrast >= 4.5,
    `Light-theme speed value text must meet WCAG AA; got ${lightControlContrast.valueContrast.toFixed(2)}:1`
  );
  assert.equal(lightControlContrast.focusedControl, 'popup-speed-slider');
  assert.ok(
    lightControlContrast.focusOutlineContrast >= 3,
    `Light-theme focus indicator must meet 3:1 non-text contrast; got ${lightControlContrast.focusOutlineContrast.toFixed(2)}:1`
  );
  // Reading progress should be announced in the same sentence units shown
  // by the visible sentence counter, while the numeric percentage remains intact.
  await popupWorker.evaluate(async () => {
    await chrome.runtime.sendMessage({
      action: 'SENTENCE_CHANGED',
      sentence: { text: 'A sentence used for progress accessibility.' },
      index: 2,
      totalSentences: 10
    }).catch(() => {});
  });
  await popupPage.waitForFunction(() => {
    const progress = document.querySelector('.progress-bar-wrap');
    return progress.getAttribute('aria-valuetext') === 'Sentence 3 of 10' &&
      progress.getAttribute('aria-valuenow') === '30';
  });

  await dispatchPlaybackState('PLAYBACK_STOPPED');
  await popupPage.waitForFunction(() => {
    const progress = document.querySelector('.progress-bar-wrap');
    return progress.getAttribute('aria-valuetext') === 'No reading progress' &&
      progress.getAttribute('aria-valuenow') === '0';
  });
  await popupPage.close();
});
