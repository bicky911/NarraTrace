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
  const intervalCallbacks = new Map();
  let nextIntervalId = 0;
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
    setInterval: callback => {
      const id = ++nextIntervalId;
      intervalCallbacks.set(id, callback);
      return id;
    },
    clearInterval: id => intervalCallbacks.delete(id),
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
    runtimeMessages: () => runtimeMessages,
    intervalCallbacks: () => [...intervalCallbacks.values()]
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


test('overlapping rate changes restart speech only once with the latest option', async () => {
  const loaded = await loadPlaybackManager([]);
  const { manager } = loaded;
  manager.queue = [{ index: 0, text: 'Change the reading speed safely.' }];
  manager.currentIndex = 0;
  manager.tabId = 606;
  manager.playbackState = 'PLAYING';

  const olderRate = manager.setRate(1.5);
  const latestRate = manager.setRate(2.0);
  const results = await Promise.all([olderRate, latestRate]);

  assert.equal(results[0], false, 'the earlier option update should be superseded');
  assert.equal(results[1], true, 'the latest option update should own the restart');
  assert.equal(manager.options.rate, 2.0);
  assert.equal(loaded.safeSpeakCallCount(), 1, 'only one replacement utterance should be started');
});


test('sparse native word events are bridged by the estimator after the grace period', async () => {
  const loaded = await loadPlaybackManager([]);
  const { manager } = loaded;
  const spoken = 'One two three four.';
  manager.queue = [{ index: 0, text: spoken }];
  manager.currentIndex = 0;
  manager.playbackState = 'PLAYING';
  manager.options.rate = 1;

  const batch = {
    firstIndex: 0,
    offsets: [0],
    spokenLengths: [spoken.length],
    spokenTexts: [spoken],
    text: spoken,
    resumeOffset: 0,
    sawWords: false,
    sawSentences: false,
    currentSentence: 0,
    anchorChar: null,
    anchorTime: null,
    anchorEnd: null,
    segmentIndex: 0,
    requestedAt: Date.now() - 2000,
    startedAt: Date.now() - 2000,
    lastNativeWordAt: null,
    lastNativeWordCharIndex: null,
    lastNativeWordLength: 0,
    lastEstimatedWordStart: null,
    firstBoundaryDelay: null,
    firstBoundaryTime: null
  };
  manager.activeBatch = batch;

  manager.handleTtsEvent({ type: 'word', charIndex: 0, length: 3 }, batch);
  assert.equal(batch.sawWords, true);
  assert.equal(batch.lastNativeWordCharIndex, 0);

  manager.startEstimator(batch);
  assert.equal(loaded.intervalCallbacks().length, 1);
  const tick = loaded.intervalCallbacks()[0];

  // The estimator stays silent while native events are still inside the grace
  // period; native timing is preferred when it is fresh.
  tick();
  let wordEvents = loaded.runtimeMessages()
    .filter(message => message.action === 'TTS_EVENT' && message.event?.type === 'word');
  assert.equal(wordEvents.length, 1, 'fresh native boundaries must not be duplicated by estimates');

  // The native driver has not reported another boundary for longer than the
  // configured grace period, so the estimator must move beyond "One".
  batch.lastNativeWordAt = Date.now() - 900;
  tick();
  wordEvents = loaded.runtimeMessages()
    .filter(message => message.action === 'TTS_EVENT' && message.event?.type === 'word');
  assert.equal(wordEvents.length, 2, 'one native and one synthetic word event should be emitted');
  assert.ok(
    wordEvents[1].event.charIndex > 0,
    'the synthetic event should advance past the first word'
  );

  // A second tick in the same word must not broadcast another identical
  // synthetic event.
  tick();
  wordEvents = loaded.runtimeMessages()
    .filter(message => message.action === 'TTS_EVENT' && message.event?.type === 'word');
  assert.equal(wordEvents.length, 2, 'synthetic word events should be de-duplicated');

  assert.equal(
    manager.lastWordCharIndex > 0,
    true,
    'pause/resume bookkeeping should follow the estimated position'
  );

  manager.stopEstimator();
});

test('invalid native word boundaries do not disable estimator fallback', async () => {
  const loaded = await loadPlaybackManager([]);
  const { manager } = loaded;
  const spoken = 'An invalid index must not freeze highlighting.';
  manager.queue = [{ index: 0, text: spoken }];
  manager.currentIndex = 0;
  manager.playbackState = 'PLAYING';

  const batch = {
    firstIndex: 0,
    offsets: [0],
    spokenLengths: [spoken.length],
    spokenTexts: [spoken],
    text: spoken,
    resumeOffset: 0,
    sawWords: false,
    sawSentences: false,
    currentSentence: 0,
    anchorChar: null,
    anchorTime: null,
    anchorEnd: null,
    segmentIndex: 0,
    requestedAt: Date.now() - 5000,
    startedAt: Date.now() - 5000,
    firstBoundaryDelay: null,
    firstBoundaryTime: null
  };
  manager.activeBatch = batch;

  manager.handleTtsEvent({ type: 'word', charIndex: Number.NaN, length: 4 }, batch);
  assert.equal(batch.sawWords, false, 'invalid indices must not mark native word tracking as active');

  manager.startEstimator(batch);
  const tick = loaded.intervalCallbacks()[0];
  tick();

  const wordEvents = loaded.runtimeMessages()
    .filter(message => message.action === 'TTS_EVENT' && message.event?.type === 'word');
  assert.equal(wordEvents.length, 1, 'the estimator should still supply a word event');
  manager.stopEstimator();
});


test('native word offsets map to the correct sentence inside a grouped utterance', async () => {
  const loaded = await loadPlaybackManager([]);
  const { manager } = loaded;
  const first = 'The first sentence.';
  const second = 'The second sentence is longer.';
  manager.queue = [{ index: 0, text: first }, { index: 1, text: second }];
  manager.currentIndex = 0;
  manager.playbackState = 'PLAYING';
  manager.wordEventsUsable = true;

  const secondStart = first.length + 1;
  const batch = {
    firstIndex: 0,
    offsets: [0, secondStart],
    spokenLengths: [first.length, second.length],
    spokenTexts: [first, second],
    text: `${first} ${second}`,
    resumeOffset: 0,
    sawWords: false,
    currentSentence: 0,
    requestedAt: Date.now(),
    firstBoundaryDelay: null,
    firstBoundaryTime: null
  };

  manager.handleTtsEvent({
    type: 'word',
    charIndex: secondStart + 4,
    length: 6
  }, batch);

  assert.equal(manager.currentIndex, 1, 'the boundary should move ownership to sentence two');
  const sentenceChange = loaded.runtimeMessages().find(message => message.action === 'SENTENCE_CHANGED');
  assert.equal(sentenceChange?.index, 1);
  const wordEvent = loaded.runtimeMessages().find(message =>
    message.action === 'TTS_EVENT' && message.event?.type === 'word'
  );
  assert.equal(wordEvent?.index, 1);
  assert.equal(wordEvent?.event.charIndex, 4, 'the UI receives an offset relative to sentence two');
  assert.equal(wordEvent?.event.length, 6);
});

test('native word offsets preserve the full-source resume position', async () => {
  const loaded = await loadPlaybackManager([]);
  const { manager } = loaded;
  const spokenRemainder = 'remaining words continue from here';
  const resumeOffset = 17;
  manager.queue = [{ index: 0, text: `A longer source sentence: ${spokenRemainder}` }];
  manager.currentIndex = 0;
  manager.playbackState = 'PLAYING';
  manager.wordEventsUsable = true;

  const batch = {
    firstIndex: 0,
    offsets: [0],
    spokenLengths: [spokenRemainder.length],
    spokenTexts: [spokenRemainder],
    text: spokenRemainder,
    resumeOffset,
    sawWords: false,
    currentSentence: 0,
    requestedAt: Date.now(),
    firstBoundaryDelay: null,
    firstBoundaryTime: null
  };

  manager.handleTtsEvent({ type: 'word', charIndex: 5, length: 5 }, batch);

  assert.equal(manager.lastWordCharIndex, resumeOffset + 5);
  const wordEvent = loaded.runtimeMessages().find(message =>
    message.action === 'TTS_EVENT' && message.event?.type === 'word'
  );
  assert.equal(wordEvent?.event.charIndex, 5);
  assert.equal(wordEvent?.resumeOffset, 0, 'content script applies the offset announced by SENTENCE_CHANGED');
});
