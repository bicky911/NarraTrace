#!/usr/bin/env node
/**
 * Optional DOM smoke test — boots the real content script inside jsdom.
 *
 * The behavioural suite covers the worker-side modules with a fake chrome.tts;
 * this tool covers the other half: "does the content script actually survive
 * being injected into a page?" It catches init-order errors (TDZ), missing
 * browser globals, extraction crashes and broken shadow-DOM wiring that a
 * string scan cannot see.
 *
 * It is deliberately OPTIONAL: NarraTrace ships with zero dependencies, so
 * jsdom is not installed by default. Run:
 *
 *   npm install --no-save jsdom
 *   npm run test:dom
 *
 * Exit code is 0 only when every assertion passes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch (_) {
  console.error('jsdom is not installed. Run: npm install --no-save jsdom');
  process.exit(2);
}

const failures = [];
const passes = [];
function check(name, condition, detail = '') {
  if (condition) {
    passes.push(name);
    console.log(`  ✓ ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

const ARTICLE = `<!doctype html><html><head><title>Irrigation and Yield — Journal</title></head><body>
<article>
  <h1>Irrigation and Yield</h1>
  <p>Dr. Smith reported that the U.S. Army trial raised yield by 12% [1] in 2024. The control group (e.g. The unwatered plot) stayed flat.</p>
  <p>Prof. Jones added a second paragraph with enough words to be considered substantive prose for extraction purposes.</p>
</article></body></html>`;

const dom = new JSDOM(ARTICLE, { url: 'https://example.com/article', pretendToBeVisual: true });
const { window } = dom;

// ── Browser globals the content script expects ──────────────────────────
globalThis.window = window;
globalThis.document = window.document;
globalThis.location = window.location;
globalThis.history = window.history;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.Node = window.Node;
globalThis.NodeFilter = window.NodeFilter;
globalThis.MutationObserver = window.MutationObserver;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.CSS = { highlights: new Map(), supports: () => false };
globalThis.Highlight = class Highlight { constructor(...ranges) { this.ranges = ranges; } };
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.devicePixelRatio = 1;
window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
window.cancelAnimationFrame = (id) => clearTimeout(id);
// jsdom (without runScripts) evaluates the page code against Node's global
// scope, so the browser globals the content script uses must exist there too.
globalThis.requestAnimationFrame = window.requestAnimationFrame;
globalThis.cancelAnimationFrame = window.cancelAnimationFrame;

// ── Minimal chrome mock ─────────────────────────────────────────────────
const sent = [];
globalThis.chrome = {
  runtime: {
    id: 'dom-smoke',
    lastError: undefined,
    sendMessage(message, callback) {
      sent.push(message);
      if (typeof callback !== 'function') return;
      const engineVoice = { voiceName: 'Kokoro Heart', extensionId: 'kokoro-test', lang: 'en-US' };
      let response = { success: true };
      if (message.action === 'GET_VOICES') {
        response = {
          success: true,
          data: {
            engines: [{
              id: 'kokoro-test',
              label: 'Kokoro',
              fullLabel: 'Kokoro (local neural)',
              badge: 'KOKORO',
              voices: [engineVoice, { ...engineVoice, voiceName: 'Kokoro Bella' }]
            }],
            localSystemVoices: [{ voiceName: 'Microsoft David', lang: 'en-US' }],
            selectedVoice: engineVoice,
            statusMessage: 'Using Kokoro voice "Kokoro Heart".',
            engineId: 'kokoro-test',
            engineLabel: 'Kokoro',
            engineBadge: 'KOKORO'
          }
        };
      } else if (message.action === 'GET_PAGE_ZOOM') {
        response = { success: true, data: { zoom: 1 } };
      } else if (message.action === 'GET_PLAYBACK_STATE') {
        response = {
          success: true,
          state: { playbackState: 'IDLE', options: { rate: 1, volume: 1 }, hasQueue: false }
        };
      }
      setTimeout(() => callback(response), 0);
    },
    onMessage: { addListener() {} }
  },
  storage: {
    local: {
      get(keys, callback) { callback({}); },
      set() { return Promise.resolve(); }
    }
  }
};

// ── Inject exactly what the manifest injects, in order ──────────────────
console.log('\nNarraTrace — DOM smoke test\n');
for (const file of ['readability.js', 'sentence-tokenizer.js', 'content.js']) {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  try {
    window.eval(code);
  } catch (err) {
    check(`${file} evaluates`, false, err && err.message);
  }
}
await new Promise((resolve) => setTimeout(resolve, 150));

const host = document.getElementById('read-aloud-player-host');
const shadow = host && host.shadowRoot;
check('player host is injected', Boolean(host));
check('shadow root is populated', Boolean(shadow && shadow.childElementCount > 5));

const actions = new Set(sent.map((m) => m.action));
check('content script asks for page zoom', actions.has('GET_PAGE_ZOOM'));
check('content script syncs playback state', actions.has('GET_PLAYBACK_STATE'));

// ── Accessibility wiring ────────────────────────────────────────────────
const overlay = shadow && shadow.getElementById('ra-reader-overlay');
check('Focus Reader is a named dialog',
  overlay && overlay.getAttribute('role') === 'dialog' && overlay.getAttribute('aria-label') === 'Focus Reader');
check('closed Focus Reader is hidden from assistive technology',
  overlay && overlay.getAttribute('aria-hidden') === 'true');
const play = shadow && shadow.getElementById('ra-play');
check('play button has an accessible label', Boolean(play && play.getAttribute('aria-label')));

// ── Clicking play builds a queue and starts playback ────────────────────
sent.length = 0;
play.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 80));
const start = sent.find((m) => m.action === 'START_PLAYBACK');
check('play click starts playback', Boolean(start));
check('abbreviations stay whole in the real queue',
  Boolean(start && start.sentences.every((s) => !/^(Dr|Prof|U\.S|et al)\.?$/.test(s.text.trim()))),
  start ? JSON.stringify(start.sentences.map((s) => s.text)) : 'no queue');
check('queue is numbered and non-empty',
  Boolean(start && start.sentences.length >= 3 && start.sentences.every((s, i) => s.index === i)));

// ── Opening the reader is keyboard-safe ─────────────────────────────────
// The pill has no reader button by design; the settings panel's FOCUS READER
// action (and Alt+R) are the entry points.
shadow.getElementById('ra-settings').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 40));
const readerOpen = shadow.getElementById('ra-settings-reader');
check('settings panel exposes the Focus Reader action', Boolean(readerOpen));
const voiceOptions = shadow.getElementById('ra-voice-select').querySelectorAll('option');
check('voice picker is populated from the worker response', voiceOptions.length >= 3,
  `found ${voiceOptions.length} options`);
check('the active engine is marked in the picker',
  Array.from(shadow.getElementById('ra-voice-select').querySelectorAll('optgroup'))
    .some((group) => group.label.startsWith('★')));
readerOpen.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 60));
check('opening the reader un-hides it', overlay.getAttribute('aria-hidden') === 'false');
check('opening the reader moves focus inside it',
  Boolean(shadow.activeElement && overlay.contains(shadow.activeElement)));

window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 60));
check('Escape closes the reader', overlay.getAttribute('aria-hidden') === 'true');
check('closing the reader returns focus',
  !shadow.activeElement || !overlay.contains(shadow.activeElement));

// ── Same-document navigation must not throw ─────────────────────────────
let navigationThrew = false;
try {
  window.history.pushState({}, '', '/article?page=2');
  await new Promise((resolve) => setTimeout(resolve, 220));
} catch (_) {
  navigationThrew = true;
}
check('SPA pushState is handled without throwing', !navigationThrew);

console.log(`\n${passes.length} passed, ${failures.length} failed\n`);
process.exit(failures.length === 0 ? 0 : 1);
