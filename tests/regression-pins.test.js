/**
 * Regression pins for fixes that live in the content script / worker, where a
 * full DOM harness would be disproportionate.
 *
 * Each assertion describes the bug it prevents; if an invariant is refactored
 * away, the test should be updated deliberately, not silently.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const content = read('content.js');
const background = read('background.js');
const engine = read('speech-engine.js');
const manager = read('playback-manager.js');

test('the shadow root is declared before any failure path can touch it', () => {
  const declaration = content.indexOf('let shadow = null;');
  const assignment = content.indexOf('shadow = host.attachShadow');
  assert.notEqual(declaration, -1, 'shadow must be hoisted with a null initialiser');
  assert.notEqual(assignment, -1, 'the shadow root must still be created');
  assert.ok(declaration < assignment, 'declaration must precede creation');
  // handleContextInvalidated runs before the player exists when a stale
  // content script wakes up — it must not read a `const` in its TDZ.
  assert.ok(content.indexOf('let shadow = null;') < content.indexOf('function handleContextInvalidated'));
  assert.match(content, /function showToast\(message\) \{\s*if \(!shadow\) return;/);
});

test('the hover button geometry matches the CSS box', () => {
  const css = content.match(/\.hover-play-btn\s*\{([\s\S]*?)\}/);
  const js = content.match(/const BTN = (\d+);\s*\/\/ keep in sync/);
  assert.ok(css && js, 'both the CSS rule and the JS constant must exist');
  const cssSize = Number(css[1].match(/width:\s*(\d+)px/)[1]);
  assert.equal(Number(js[1]), cssSize, 'BTN must equal the rendered button width');
});

test('playback stops on real navigations, never on same-document URL changes', () => {
  assert.match(background, /chrome\.tabs\.onUpdated\.addListener\(\(tabId, changeInfo\) => \{\s*if \(changeInfo\.status !== 'loading'\) return;/);
  assert.doesNotMatch(background, /changeInfo\.status !== 'loading' && !changeInfo\.url/);
});

test('the zoom poll is cheap and does not run forever in a hidden tab', () => {
  assert.match(content, /if \(zoom === _lastAppliedZoom\) return;/);
  assert.match(content, /if \(document\.visibilityState === 'hidden'\) return;/);
  assert.match(content, /clearInterval\(_zoomPollTimer\)/);
});

test('the watchdog stops the engine before resolving a timeout', () => {
  assert.match(engine, /watchdogTimer = setTimeout\(\(\) => \{[\s\S]{0,600}?stopEngineQuietly\(\);\s*settle\(resolve/);
  assert.match(engine, /let settled = false;/);
  assert.match(engine, /if \(settled \|\| !event/);
});

test('the playback manager ignores events from an abandoned batch', () => {
  assert.match(manager, /this\.activeBatch !== batchRef\) return;/);
});

test('the persisted queue has its own session key (per-sentence writes stay small)', () => {
  assert.match(manager, /const SESSION_QUEUE_KEY = 'readAloud_sessionQueue';/);
  assert.match(manager, /if \(!this\._queueDirty\) \{\s*await chrome\.storage\.session\.set\(\{ \[SESSION_STORAGE_KEY\]: data \}\);\s*return;/);
  // Upgrading users keep their session: the legacy inline queue is still read.
  assert.match(manager, /Array\.isArray\(data && data\.queue\)/);
});

test('seeking while paused cannot resume audio', () => {
  assert.match(manager, /const wasPaused = this\.playbackState === PlaybackState\.PAUSED;/);
  assert.match(manager, /if \(wasPaused\) \{[\s\S]{0,600}?return;\s*\}/);
});

test('reset() and recovery both silence the engine', () => {
  const resetBlock = manager.match(/async reset\(\) \{([\s\S]*?)\n  \}/);
  assert.ok(resetBlock, 'reset() must exist');
  assert.match(resetBlock[1], /await stopSpeechAndWait\(\)/);

  const recoverBlock = manager.match(/async recoverAfterWorkerRestart\(\) \{([\s\S]*?)\n  \}\n/);
  assert.match(recoverBlock[1], /Orphaned utterance never went idle/);
  assert.match(recoverBlock[1], /await stopSpeechAndWait\(1000\)/);
});

test('the Focus Reader is a properly hidden modal dialog', () => {
  assert.match(content, /readerOverlay\.setAttribute\('role', 'dialog'\)/);
  assert.match(content, /readerOverlay\.setAttribute\('aria-modal', 'true'\)/);
  assert.match(content, /readerOverlay\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(content, /readerOverlay\.setAttribute\('aria-hidden', 'false'\)/);
  // A closed overlay that is only transparent still traps Tab focus.
  assert.match(content, /\.reader-overlay \{[\s\S]{0,600}?visibility: hidden;/);
  assert.match(content, /readerReturnFocus/);
  assert.match(content, /if \(e\.key !== 'Tab' \|\| !isReaderOpen\) return;/);
});

test('the context menu routes selections through the tab so ranges can exist', () => {
  assert.match(background, /action: 'TRIGGER_READ_SELECTION'/);
  assert.match(content, /case 'TRIGGER_READ_SELECTION':/);
});
