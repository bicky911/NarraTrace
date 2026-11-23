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

  await browser.installExtension(REPOSITORY_ROOT);
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(`http://127.0.0.1:${address.port}/article`, {
    waitUntil: 'domcontentloaded',
    timeout: 10000
  });
  await waitForShadow(page, root => Boolean(root.getElementById('ra-settings')));
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
      activeId: root.activeElement?.id
    };
  });
  assert.deepEqual(settingsOpen, {
    expanded: 'true',
    hidden: 'false',
    inert: false,
    activeId: 'ra-settings-close'
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
    root.querySelector('.player-pill').classList.add('is-tucked', 'beaded');
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
      playerBeaded: root.querySelector('.player-pill')?.classList.contains('beaded')
    };
  });
  console.log('[NarraTrace accessibility reader Escape]', JSON.stringify(afterReaderEscape));
  assert.equal(afterReaderEscape.isOpen, false, 'Escape should remove the reader open state');
  assert.equal(afterReaderEscape.inert, true, 'Escape should make the reader dialog inert');
  assert.equal(afterReaderEscape.ariaHidden, 'true', 'Escape should hide the reader dialog from assistive technology');
  assert.equal(afterReaderEscape.activeId, 'ra-settings', 'Escape should restore focus to the settings trigger');
  assert.equal(afterReaderEscape.playerBeaded, false, 'Restoring focus should untuck the player first');

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
    return panel.inert &&
      panel.getAttribute('aria-hidden') === 'true' &&
      root.getElementById('ra-settings').getAttribute('aria-expanded') === 'false' &&
      root.activeElement?.id === 'ra-settings';
  });
});
