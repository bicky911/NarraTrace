import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const contentSource = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const startMarker = '  let _devicePixelRatioMedia = null;';
const endMarker = "  window.addEventListener('resize', updateZoomCompensation);";
const start = contentSource.indexOf(startMarker);
const end = contentSource.indexOf(endMarker, start);
assert.ok(start >= 0 && end > start, 'production DPR watcher source should be present');
const watcherSource = contentSource.slice(start, end).trim();

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

test('zoom compensation no longer uses a recurring polling interval', () => {
  assert.doesNotMatch(contentSource, /setInterval\(updateZoomCompensation,\s*1200\)/);
  assert.match(contentSource, /window\.addEventListener\('pageshow'[\s\S]{0,180}watchDevicePixelRatio\(\)/);
  assert.match(contentSource, /window\.addEventListener\('pagehide'[\s\S]{0,180}stopDevicePixelRatioWatch\(\)/);
});
