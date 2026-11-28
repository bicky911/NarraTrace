import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosticKeepAlive } from '../diagnostic-keepalive.js';

test('diagnostic keep-alive pings the existing session key every 15 seconds and stops cleanly', () => {
  const calls = [];
  const cleared = [];
  let scheduledCallback = null;
  let scheduledDelay = null;

  const keepAlive = createDiagnosticKeepAlive({
    get(key) {
      calls.push(key);
      return Promise.resolve({});
    }
  }, {
    schedule(callback, delay) {
      scheduledCallback = callback;
      scheduledDelay = delay;
      return 41;
    },
    cancel(timerId) {
      cleared.push(timerId);
    }
  });

  assert.equal(keepAlive.start(), true);
  assert.equal(keepAlive.start(), false, 'starting twice must not create duplicate timers');
  assert.equal(scheduledDelay, 15_000);
  assert.deepEqual(calls, []);

  scheduledCallback();
  assert.deepEqual(calls, ['readAloud_sessionState']);

  assert.equal(keepAlive.stop(), true);
  assert.equal(keepAlive.stop(), false, 'stopping twice must remain harmless');
  assert.deepEqual(cleared, [41]);
});

test('storage failures do not escape the keep-alive tick or prevent cleanup', async () => {
  let scheduledCallback = null;
  let cleared = false;

  const keepAlive = createDiagnosticKeepAlive({
    get() {
      return Promise.reject(new Error('storage temporarily unavailable'));
    }
  }, {
    schedule(callback) {
      scheduledCallback = callback;
      return 7;
    },
    cancel(timerId) {
      assert.equal(timerId, 7);
      cleared = true;
    }
  });

  keepAlive.start();
  assert.doesNotThrow(() => scheduledCallback());
  await Promise.resolve();
  assert.equal(keepAlive.stop(), true);
  assert.equal(cleared, true);
});

test('a session storage area is required', () => {
  assert.throws(
    () => createDiagnosticKeepAlive(null),
    /Chrome session storage area is required/
  );
});
