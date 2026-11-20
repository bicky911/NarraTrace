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

async function loadPlaybackManager(stopGates, options = {}) {
  let safeSpeakCalls = 0;
  let stopSpeechAndWaitCalls = 0;
  const runtimeMessages = [];
  const source = await readFile(new URL('../playback-manager.js', import.meta.url), 'utf8');

  // Run the real playback-manager source in an isolated VM, replacing only its
  // speech-engine import/export boundary with deterministic Chrome/TTS mocks.
  const importPattern = /^import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/speech-engine\.js['"];\s*/m;
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
      sendMessage: message => {
        runtimeMessages.push(message);
        return Promise.resolve(undefined);
      }
    }
  };

  const context = {
    chrome,
    console: { log() {}, warn() {}, error() {} },
    setInterval: () => 1,
    clearInterval() {},
    safeSpeak: () => {
      safeSpeakCalls++;
      return new Promise(() => {});
    },
    stopSpeech: async () => undefined,
    stopSpeechAndWait: () => {
      stopSpeechAndWaitCalls++;
      const next = stopGates.shift();
      return next ? next.promise : Promise.resolve(true);
    },
    pauseSpeech: async () => undefined,
    resumeSpeech: async () => undefined,
    isSpeaking: options.isSpeaking || (async () => false),
    detectAndSelectVoice: async () => ({ allVoices: [], selectedVoice: null }),
    detectScript: () => 'en',
    findBestVoiceForLang: () => null
  };

  vm.runInNewContext(executable, context, { filename: 'playback-manager.js' });
  return {
    manager: context.__playbackManager,
    safeSpeakCallCount: () => safeSpeakCalls,
    stopSpeechAndWaitCallCount: () => stopSpeechAndWaitCalls,
    runtimeMessages: () => runtimeMessages
  };
}

test('a superseded start cannot overwrite the newer queue', async () => {
  const olderStop = deferred();
  const newerStop = deferred();
  const { manager } = await loadPlaybackManager([olderStop, newerStop]);

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


test('rapid next commands are accumulated but start only one replacement utterance', async () => {
  const firstStop = deferred();
  const secondStop = deferred();
  const loaded = await loadPlaybackManager([firstStop, secondStop]);
  const { manager } = loaded;

  manager.queue = [
    { index: 0, text: 'First sentence.' },
    { index: 1, text: 'Second sentence.' },
    { index: 2, text: 'Third sentence.' }
  ];
  manager.currentIndex = 0;
  manager.tabId = 303;
  manager.playbackState = 'PLAYING';

  // The two clicks represent two Next commands. The second stop resolves
  // first to reproduce reversed async completion.
  const firstNext = manager.skipForward();
  const secondNext = manager.skipForward();

  secondStop.resolve(true);
  await secondNext;
  assert.equal(manager.currentIndex, 2, 'both Next inputs should be retained');
  assert.equal(loaded.safeSpeakCallCount(), 1, 'only the latest command should start speech');

  firstStop.resolve(true);
  await firstNext;
  assert.equal(manager.currentIndex, 2);
  assert.equal(loaded.safeSpeakCallCount(), 1, 'the stale command must not start a duplicate utterance');
});


test('a delayed pause cannot overwrite a later resume', async () => {
  const pauseStop = deferred();
  const loaded = await loadPlaybackManager([pauseStop]);
  const { manager } = loaded;
  manager.queue = [{ index: 0, text: 'Resume this sentence.' }];
  manager.currentIndex = 0;
  manager.tabId = 404;
  manager.playbackState = 'PLAYING';

  const pausing = manager.pause();
  assert.equal(manager.playbackState, 'PAUSED');
  assert.equal(await manager.resume(), true);
  assert.equal(manager.playbackState, 'PLAYING');
  assert.equal(loaded.safeSpeakCallCount(), 1);

  pauseStop.resolve(true);
  assert.equal(await pausing, false, 'the old pause must be discarded');
  assert.equal(manager.playbackState, 'PLAYING');
  assert.equal(loaded.runtimeMessages().some(message => message.action === 'PLAYBACK_PAUSED'), false);
});

test('worker recovery stops a timed-out orphan before replaying', async () => {
  const loaded = await loadPlaybackManager([], { isSpeaking: async () => true });
  const { manager } = loaded;
  manager.queue = [{ index: 0, text: 'Recover this sentence.' }];
  manager.currentIndex = 0;
  manager.tabId = 505;
  manager.playbackState = 'PLAYING';
  manager.waitForSpeechIdle = async () => false;

  const replayedRuns = [];
  manager.speakCurrentSentence = runId => replayedRuns.push(runId);

  await manager.recoverAfterWorkerRestart();

  assert.equal(loaded.stopSpeechAndWaitCallCount(), 1, 'the orphan must be stopped before a new utterance is queued');
  assert.deepEqual(replayedRuns, [manager.playbackRunId]);
});
