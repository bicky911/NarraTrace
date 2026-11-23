import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const contentSource = await readFile(new URL('../content.js', import.meta.url), 'utf8');

const gazeStartMarker = '  const GAZE_ANCHOR';
const gazeEndMarker = '  // Per-property spring state';
const gazeStart = contentSource.indexOf(gazeStartMarker);
const gazeEnd = contentSource.indexOf(gazeEndMarker, gazeStart);
assert.ok(gazeStart >= 0 && gazeEnd > gazeStart, 'production Golden Gaze source should be present');
const gazeSource = contentSource.slice(gazeStart, gazeEnd).trim();

function createGoldenGaze() {
  const frames = new Map();
  const timers = new Map();
  const cancelledFrames = [];
  let nextFrameId = 0;
  let nextTimerId = 0;
  const windowMock = {
    innerWidth: 1200,
    scrollY: 0,
    scrollTo(_x, y) { this.scrollY = y; }
  };
  const context = {
    window: windowMock,
    requestAnimationFrame(callback) {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      cancelledFrames.push(id);
      frames.delete(id);
    },
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    Date,
    console
  };

  vm.runInNewContext(`
${gazeSource}
globalThis.__gazeApi = {
  gazeScrollTo,
  gazeCancelScroll,
  gazeYieldToUser,
  get state() { return { target: _gazeTarget, rafId: _gazeRafId, resumeAt: _gazeResumeAt, resumeTimer: _gazeResumeTimer }; }
};`, context, { filename: 'content.js#golden-gaze' });

  return { api: context.__gazeApi, frames, timers, cancelledFrames, window: windowMock };
}

const startMarker = '  let _devicePixelRatioMedia = null;';
const endMarker = "  window.addEventListener('resize', updateZoomCompensation);";
const start = contentSource.indexOf(startMarker);
const end = contentSource.indexOf(endMarker, start);
assert.ok(start >= 0 && end > start, 'production DPR watcher source should be present');
const watcherSource = contentSource.slice(start, end).trim();

const observerStartMarker = '  function scheduleMutationCheck() {';
const observerEndMarker = '  let displayScale = 1;';
const observerStart = contentSource.indexOf(observerStartMarker);
const observerEnd = contentSource.indexOf(observerEndMarker, observerStart);
assert.ok(observerStart >= 0 && observerEnd > observerStart, 'production mutation observer source should be present');
const observerSource = contentSource.slice(observerStart, observerEnd).trim();

function createMutationObserverLifecycle(hasBody = true) {
  const observers = [];
  const timers = new Map();
  const clearedTimers = [];
  const mutationCalls = [];
  let nextTimerId = 0;

  const documentMock = { body: hasBody ? { id: 'body' } : null };
  class MutationObserverMock {
    constructor(callback) {
      this.callback = callback;
      this.observeCalls = [];
      this.disconnectCalls = 0;
      observers.push(this);
    }
    observe(target, options) {
      this.observeCalls.push({ target, options });
    }
    disconnect() {
      this.disconnectCalls++;
    }
    trigger() {
      this.callback([]);
    }
  }

  const context = {
    document: documentMock,
    MutationObserver: MutationObserverMock,
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      clearedTimers.push(id);
      timers.delete(id);
    },
    handleDomMutation() {
      mutationCalls.push('mutation');
    }
  };

  vm.runInNewContext(
    `let mutationObserver = null;
let mutationTimer = null;
${observerSource}
globalThis.__observerApi = {
  startMutationObserver,
  stopMutationObserver,
  scheduleMutationCheck,
  get state() { return { hasObserver: Boolean(mutationObserver), mutationTimer }; }
};`,
    context,
    { filename: 'content.js#mutation-observer-lifecycle' }
  );

  return {
    api: context.__observerApi,
    document: documentMock,
    observers,
    timers,
    clearedTimers,
    mutationCalls
  };
}

function createWatcher(initialDpr = 1, legacy = false) {
  const queries = [];
  const calls = [];
  const windowMock = {
    devicePixelRatio: initialDpr,
    matchMedia(query) {
      const listeners = new Set();
      const media = {
        media: query,
        listeners,
        ...(legacy
          ? {
              addListener(listener) { listeners.add(listener); },
              removeListener(listener) { listeners.delete(listener); }
            }
          : {
              addEventListener(type, listener) {
                if (type === 'change') listeners.add(listener);
              },
              removeEventListener(type, listener) {
                if (type === 'change') listeners.delete(listener);
              }
            }),
        fireChange() {
          for (const listener of [...listeners]) listener({ matches: false, media: query });
        }
      };
      queries.push(media);
      return media;
    }
  };

  const context = {
    window: windowMock,
    updateZoomCompensation() { calls.push('update'); }
  };
  vm.runInNewContext(
    `${watcherSource}
globalThis.__watcher = { watchDevicePixelRatio, stopDevicePixelRatioWatch }; `,
    context,
    { filename: 'content.js#device-pixel-ratio-watcher' }
  );
  return { watcher: context.__watcher, window: windowMock, queries, calls };
}

test('DPR watcher registers for the current device-pixel-ratio', () => {
  const state = createWatcher(1.25);
  assert.equal(state.watcher.watchDevicePixelRatio(), true);
  assert.equal(state.queries.length, 1);
  assert.equal(state.queries[0].media, '(resolution: 1.25dppx)');
  assert.equal(state.queries[0].listeners.size, 1);
});

test('DPR watcher re-arms for a new resolution and updates zoom once', () => {
  const state = createWatcher(1);
  state.watcher.watchDevicePixelRatio();
  state.window.devicePixelRatio = 1.5;
  state.queries[0].fireChange();

  assert.equal(state.queries.length, 2);
  assert.equal(state.queries[0].listeners.size, 0, 'old query listener should be detached');
  assert.equal(state.queries[1].media, '(resolution: 1.5dppx)');
  assert.equal(state.queries[1].listeners.size, 1);
  assert.deepEqual(state.calls, ['update']);
});

test('DPR watcher cleanup is idempotent and can restart after page restore', () => {
  const state = createWatcher(2);
  state.watcher.watchDevicePixelRatio();
  state.watcher.stopDevicePixelRatioWatch();
  state.watcher.stopDevicePixelRatioWatch();

  assert.equal(state.queries[0].listeners.size, 0);
  assert.equal(state.watcher.watchDevicePixelRatio(), true);
  assert.equal(state.queries.length, 2);
  assert.equal(state.queries[1].listeners.size, 1);
});

test('DPR watcher supports legacy MediaQueryList listeners', () => {
  const state = createWatcher(1.75, true);
  assert.equal(state.watcher.watchDevicePixelRatio(), true);
  assert.equal(state.queries[0].listeners.size, 1);
  state.watcher.stopDevicePixelRatioWatch();
  assert.equal(state.queries[0].listeners.size, 0);
});

test('content script has no recurring idle interval besides active-playback heartbeat', () => {
  assert.doesNotMatch(contentSource, /setInterval\(updateZoomCompensation,\s*1200\)/);
  const intervals = contentSource.match(/\bsetInterval\(/g) || [];
  assert.equal(intervals.length, 1, 'only the playback heartbeat should remain');
  assert.match(contentSource, /heartbeatTimer = setInterval\(\(\) => \{[\s\S]{0,350}if \(currentPlaybackState === 'PLAYING'\)[\s\S]{0,250}stopHeartbeat\(\)/);
  assert.match(contentSource, /window\.addEventListener\('pageshow'[\s\S]{0,180}watchDevicePixelRatio\(\)/);
  assert.match(contentSource, /window\.addEventListener\('pagehide'[\s\S]{0,180}stopDevicePixelRatioWatch\(\)/);
});


test('mutation observer is created once while playback is active', () => {
  const state = createMutationObserverLifecycle();
  state.api.startMutationObserver();
  state.api.startMutationObserver();

  assert.equal(state.observers.length, 1, 'duplicate starts should not create duplicate observers');
  assert.equal(state.observers[0].observeCalls.length, 1);
  assert.equal(state.observers[0].observeCalls[0].target, state.document.body);
  assert.deepEqual(
    { ...state.observers[0].observeCalls[0].options },
    { childList: true, subtree: true, characterData: true }
  );
  assert.equal(state.api.state.hasObserver, true);
});

test('mutation observer throttles checks and stop clears the pending timer', () => {
  const state = createMutationObserverLifecycle();
  state.api.startMutationObserver();
  const observer = state.observers[0];

  observer.trigger();
  observer.trigger();
  assert.equal(state.timers.size, 1, 'multiple mutation bursts should share one pending check');
  const [timerId, timer] = [...state.timers.entries()][0];
  assert.equal(timer.delay, 800);

  state.api.stopMutationObserver();
  assert.equal(observer.disconnectCalls, 1);
  assert.deepEqual(state.clearedTimers, [timerId]);
  assert.equal(state.timers.size, 0);
  assert.equal(state.api.state.hasObserver, false);
  assert.equal(state.api.state.mutationTimer, null);
});

test('mutation observer can restart after stop and safely skips pages without a body', () => {
  const state = createMutationObserverLifecycle(false);
  state.api.startMutationObserver();
  assert.equal(state.observers.length, 0, 'observer should not be created without document.body');

  state.document.body = { id: 'body-restored' };
  state.api.startMutationObserver();
  assert.equal(state.observers.length, 1);
  state.api.stopMutationObserver();
  state.api.startMutationObserver();
  assert.equal(state.observers.length, 2, 'a stopped observer can be recreated');
});

test('playback state transitions own mutation observer lifetime', () => {
  assert.match(contentSource, /if \(state === 'STOPPED' \|\| state === 'IDLE'\) \{[\s\S]{0,120}stopMutationObserver\(\)/);
  assert.match(contentSource, /if \(state === 'PLAYING'\) \{[\s\S]{0,500}startMutationObserver\(\)/);
  assert.match(contentSource, /window\.addEventListener\('pagehide'[\s\S]{0,180}stopMutationObserver\(\)/);
});


test('Golden Gaze yields immediately to wheel input and resumes the latest target after a quiet period', () => {
  const state = createGoldenGaze();
  state.api.gazeScrollTo(250, null);
  assert.equal(state.frames.size, 1, 'automatic scroll should schedule one animation frame');

  state.api.gazeYieldToUser({ type: 'wheel', deltaX: 0, deltaY: 80 });
  assert.equal(state.frames.size, 0, 'manual input should cancel the active animation frame');
  assert.equal(state.api.state.target, null);
  assert.equal(state.cancelledFrames.length, 1);

  state.api.gazeScrollTo(420, null);
  assert.equal(state.frames.size, 0, 'automatic scroll must remain yielded');
  assert.equal(state.timers.size, 1, 'one quiet-period timer should be scheduled');
  const [timerId, timer] = [...state.timers.entries()][0];
  assert.equal(timer.delay, 1200);

  timer.callback();
  state.timers.delete(timerId);
  assert.equal(state.frames.size, 1, 'automatic scroll resumes after the quiet period');
  const [frameId, frame] = [...state.frames.entries()][0];
  state.frames.delete(frameId);
  frame(16);
  assert.ok(state.window.scrollY > 0 && state.window.scrollY < 420,
    'resumed scrolling should interpolate from the user\'s current position');
  state.api.gazeCancelScroll();
});

test('Golden Gaze detects scrollbar pointer input but ignores ordinary pointer clicks and text-field keys', () => {
  const state = createGoldenGaze();
  state.api.gazeYieldToUser({ type: 'pointerdown', button: 0, clientX: 600 });
  assert.equal(state.api.state.resumeAt, 0, 'ordinary page clicks should not pause automatic scrolling');

  state.api.gazeYieldToUser({ type: 'pointerdown', button: 0, clientX: 1190 });
  assert.ok(state.api.state.resumeAt > 0, 'a pointer near the viewport edge should yield to scrollbar control');

  state.api.gazeCancelScroll();
  state.api.gazeYieldToUser({
    type: 'keydown',
    key: 'PageDown',
    target: { isContentEditable: false, closest: () => null }
  });
  assert.ok(state.api.state.resumeAt > 0, 'document scroll keys should yield');

  state.api.gazeCancelScroll();
  state.api.gazeYieldToUser({
    type: 'keydown',
    key: 'ArrowDown',
    target: { isContentEditable: false, closest: () => ({ tagName: 'INPUT' }) }
  });
  assert.equal(state.api.state.resumeAt, 0, 'typing and form controls must not trigger scroll yielding');
});
