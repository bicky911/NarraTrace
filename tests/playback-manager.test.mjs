import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function loadPlaybackManager(stopGates) {
  const source = await readFile(new URL('../playback-manager.js', import.meta.url), 'utf8');

  // Run the real playback-manager source in an isolated VM, replacing only its
  // speech-engine import/export boundary with deterministic Chrome/TTS mocks.
  const importPattern = /^import\\s*\\{[\\s\\S]*?\\}\\s*from\\s*['"]\\.\\/speech-engine\\.js['"];\\s*/m;
  assert.match(source, importPattern, 'expected one speech-engine import');
  let executable = source.replace(importPattern, '');
  executable = executable.replace('export const PlaybackState =', 'const PlaybackState =');
  executable = executable.replace(
    'export const playbackManager = new PlaybackManager();',
    'globalThis.__playbackManager = new PlaybackManager();'
  );
  assert.ok(executable.includes('globalThis.__playbackManager'), 'singleton export boundary was replaced');

  const chrome = {
    storage: {
      session: {
        get: async () => ({}),
        set: async () => undefined
      },
      local: {
        get: async () => ({}),
        set: async () => undefined
      }
    },
    tabs: {
      sendMessage: () => Promise.resolve(undefined)
    },
    runtime: {
      sendMessage: () => Promise.resolve(undefined)
    }
  };

  const context = {
    chrome,
    console: { log() {}, warn() {}, error() {} },
    setInterval: () => 1,
    clearInterval() {},
    safeSpeak: () => new Promise(() => {}),
    stopSpeech: async () => undefined,
    stopSpeechAndWait: () => {
      const next = stopGates.shift();
      return next ? next.promise : Promise.resolve(true);
    },
    pauseSpeech: async () => undefined,
    resumeSpeech: async () => undefined,
    isSpeaking: async () => false,
    detectAndSelectVoice: async () => ({ allVoices: [], selectedVoice: null }),
    detectScript: () => 'en',
    findBestVoiceForLang: () => null
  };

  vm.runInNewContext(executable, context, { filename: 'playback-manager.js' });
  return context.__playbackManager;
}

test('a superseded start cannot overwrite the newer queue', async () => {
  const olderStop = deferred();
  const newerStop = deferred();
  const manager = await loadPlaybackManager([olderStop, newerStop]);

  // Both commands start before either stop request completes.
  const olderStart = manager.start(['older request'], 0, 101);
  const newerStart = manager.start(['newer request'], 0, 202);

  // Force the newer command to finish first, then let the stale request finish.
  newerStop.resolve(true);
  assert.equal(await newerStart, true);
  assert.deepEqual(
    Array.from(manager.queue, item => item.text),
    ['newer request']
  );
  assert.equal(manager.tabId, 202);

  olderStop.resolve(true);
  assert.equal(
    await olderStart,
    false,
    'the stale start should report that it was superseded'
  );
  assert.deepEqual(
    Array.from(manager.queue, item => item.text),
    ['newer request'],
    'the older start must not replace the active queue'
  );
  assert.equal(manager.tabId, 202);
});
