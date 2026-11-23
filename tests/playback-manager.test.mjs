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
  let sessionState = { ...(options.sessionData || {}) };
  const runtimeMessages = [];
  const intervalCallbacks = new Map();
  const alarms = new Map();
  if (options.preexistingAlarm) alarms.set('readAloudKeepAlive', { periodInMinutes: 0.5 });
  const alarmEvents = [];
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
        get: async () => sessionState,
        set: async value => {
          sessionState = { ...sessionState, ...value };
        }
      },
      local: {
        get: async () => ({}),
        set: async () => undefined
      }
    },
    tabs: {
      sendMessage: () => Promise.resolve(undefined)
    },
    alarms: {
      get: async name => alarms.has(name) ? { name, ...alarms.get(name) } : null,
      create: async (name, info) => {
        alarms.set(name, info);
        alarmEvents.push({ action: 'create', name, info });
      },
      clear: async name => {
        const existed = alarms.delete(name);
        alarmEvents.push({ action: 'clear', name, existed });
        return existed;
      }
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
    findBestVoiceForLang: () => null,
    SUPERTONIC_EXTENSION_ID: 'mdoplmghlkjcnegkdhocjbjcncocbdhk'
  };

  vm.runInNewContext(executable, context, { filename: 'playback-manager.js' });
  return {
    manager: context.__playbackManager,
    safeSpeakCallCount: () => safeSpeakCalls,
    stopSpeechAndWaitCallCount: () => stopSpeechAndWaitCalls,
    runtimeMessages: () => runtimeMessages,
    sessionData: () => sessionState,
    intervalCallbacks: () => [...intervalCallbacks.values()],
    alarms: () => new Map(alarms),
    alarmEvents: () => [...alarmEvents]
  };
}

test('the recovery alarm exists only during active playback', async () => {
  const loaded = await loadPlaybackManager([]);
  const { manager } = loaded;

  manager.playbackState = 'IDLE';
  await manager.saveToSession();
  assert.equal(loaded.alarms().has('readAloudKeepAlive'), false,
    'idle playback must not schedule a recurring wake-up alarm');

  manager.playbackState = 'PLAYING';
  await manager.saveToSession();
  assert.equal(loaded.alarms().has('readAloudKeepAlive'), true,
    'active playback must retain the service-worker recovery alarm');
  assert.equal(loaded.intervalCallbacks().length, 1,
    'the worker-side keep-alive tick should be active during playback');

  manager.playbackState = 'PAUSED';
  await manager.saveToSession();
  assert.equal(loaded.alarms().has('readAloudKeepAlive'), false,
    'pausing must clear the recovery alarm');
  assert.equal(loaded.intervalCallbacks().length, 0,
    'pausing must clear the worker-side keep-alive interval');

  manager.playbackState = 'PLAYING';
  await manager.saveToSession();
  manager.playbackState = 'STOPPED';
  await manager.saveToSession();
  assert.equal(loaded.alarms().has('readAloudKeepAlive'), false,
    'stopping must leave no recovery alarm behind');
});

test('worker startup reconciles stale alarms and restores active-session alarms', async () => {
  const idle = await loadPlaybackManager([], { preexistingAlarm: true });
  assert.equal(await idle.manager.restoreFromSession(), false);
  assert.equal(idle.alarms().has('readAloudKeepAlive'), false,
    'an idle/empty restored session must clear a stale alarm');

  const active = await loadPlaybackManager([], {
    sessionData: {
      readAloud_sessionState: {
        queue: ['Continue the restored session.'],
        currentIndex: 0,
        playbackState: 'PLAYING',
        tabId: 77
      }
    }
  });
  assert.equal(await active.manager.restoreFromSession(), true);
  assert.equal(active.alarms().has('readAloudKeepAlive'), true,
    'a restored active session must recreate its recovery alarm');
  assert.equal(active.intervalCallbacks().length, 1);
});

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

test('worker recovery replays the current sentence when Chrome has no active utterance', async () => {
  const loaded = await loadPlaybackManager([], { isSpeaking: async () => false });
  const { manager } = loaded;
  manager.queue = [
    { index: 0, text: 'Replay the sentence that Chrome never accepted.' },
    { index: 1, text: 'Continue only after that sentence ends.' }
  ];
  manager.currentIndex = 0;
  manager.tabId = 504;
  manager.playbackState = 'PLAYING';

  const requests = [];
  manager.speakCurrentSentence = (runId, offset = 0) =>
    requests.push({ runId, index: manager.currentIndex, offset });

  await manager.recoverAfterWorkerRestart();

  assert.deepEqual(requests, [{
    runId: manager.playbackRunId,
    index: 0,
    offset: 0
  }], 'when Chrome is idle and no pending orphan marker exists, replay the current sentence');
  assert.equal(manager.recoveryPendingAdvance, false);
  assert.equal(manager.currentIndex, 0);
  assert.equal(loaded.stopSpeechAndWaitCallCount(), 0);
});

test('worker recovery persists an orphaned utterance and advances once after it becomes idle', async () => {
  const original = await loadPlaybackManager([], { isSpeaking: async () => true });
  const manager = original.manager;
  manager.queue = [
    { index: 0, text: 'The orphaned sentence is still speaking.' },
    { index: 1, text: 'Continue with the next sentence.' }
  ];
  manager.currentIndex = 0;
  manager.tabId = 505;
  manager.playbackState = 'PLAYING';
  manager.waitForSpeechIdle = async () => false;

  const firstWorkerRequests = [];
  manager.speakCurrentSentence = (runId, offset = 0) => firstWorkerRequests.push({ runId, index: manager.currentIndex, offset });

  await manager.recoverAfterWorkerRestart();

  assert.equal(original.stopSpeechAndWaitCallCount(), 0,
    'recovery must not cut off a browser-owned utterance that is still speaking');
  assert.deepEqual(firstWorkerRequests, [],
    'recovery must not queue a duplicate utterance while the orphan is active');
  assert.equal(manager.recoveryPendingAdvance, true);
  assert.equal(manager.isSwitchingSentence, false);
  assert.equal(original.sessionData().readAloud_sessionState.recoveryPendingAdvance, true,
    'the pending advance must survive a service-worker restart');

  // A subsequent worker can also wake while the browser still owns the old
  // utterance. It must retain the marker and defer again, without stopping or
  // replaying the current sentence.
  const secondWorker = await loadPlaybackManager([], {
    isSpeaking: async () => true,
    sessionData: original.sessionData()
  });
  assert.equal(await secondWorker.manager.restoreFromSession(), true);
  secondWorker.manager.waitForSpeechIdle = async () => false;
  const secondWorkerRequests = [];
  secondWorker.manager.speakCurrentSentence = (runId, offset = 0) =>
    secondWorkerRequests.push({ runId, index: secondWorker.manager.currentIndex, offset });

  await secondWorker.manager.recoverAfterWorkerRestart();

  assert.equal(secondWorker.manager.recoveryPendingAdvance, true);
  assert.equal(secondWorker.manager.currentIndex, 0);
  assert.deepEqual(secondWorkerRequests, []);
  assert.equal(secondWorker.stopSpeechAndWaitCallCount(), 0);
  assert.equal(secondWorker.sessionData().readAloud_sessionState.recoveryPendingAdvance, true);

  // Once Chrome reports idle, a later recovery consumes the marker exactly
  // once and starts the next sentence instead of repeating the orphan.
  const thirdWorker = await loadPlaybackManager([], {
    isSpeaking: async () => false,
    sessionData: secondWorker.sessionData()
  });
  assert.equal(await thirdWorker.manager.restoreFromSession(), true);
  const thirdWorkerRequests = [];
  thirdWorker.manager.speakCurrentSentence = (runId, offset = 0) =>
    thirdWorkerRequests.push({ runId, index: thirdWorker.manager.currentIndex, offset });

  await thirdWorker.manager.recoverAfterWorkerRestart();

  assert.equal(thirdWorker.manager.recoveryPendingAdvance, false);
  assert.equal(thirdWorker.manager.currentIndex, 1);
  assert.deepEqual(thirdWorkerRequests, [{
    runId: thirdWorker.manager.playbackRunId,
    index: 1,
    offset: 0
  }]);
  assert.equal(thirdWorker.stopSpeechAndWaitCallCount(), 0);
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



test('Supertonic first-utterance highlighting respects its measured audible lead-in', async () => {
  const loaded = await loadPlaybackManager([]);
  const { manager } = loaded;
  const spoken = 'Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november.';
  manager.options.extensionId = 'mdoplmghlkjcnegkdhocjbjcncocbdhk';
  manager.options.rate = 1;
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
    sawSentences: true,
    currentSentence: 0,
    anchorChar: 0,
    anchorTime: Date.now() - 1000,
    anchorEnd: null,
    segmentIndex: 0,
    requestedAt: Date.now() - 1000,
    startedAt: Date.now() - 1000,
    firstBoundaryDelay: 0,
    firstBoundaryTime: Date.now() - 1000,
    lastEstimatedWordStart: null
  };
  manager.activeBatch = batch;

  const profile = manager.engineProfile();
  assert.equal(profile.leadInMs, 3200, 'Supertonic should start with its measured provider-specific lead-in');
  manager.startEstimator(batch);
  loaded.intervalCallbacks()[0]();

  const wordEvents = loaded.runtimeMessages()
    .filter(message => message.action === 'TTS_EVENT' && message.event?.type === 'word');
  assert.equal(wordEvents.length, 1);
  assert.equal(wordEvents[0].event.charIndex, 0,
    'the first utterance must not advance the highlight during the known pre-audio window');
  manager.stopEstimator();
});

test('generic engines do not inherit Supertonic lead-in assumptions', async () => {
  const { manager } = await loadPlaybackManager([]);
  manager.options.extensionId = 'generic-third-party-engine';
  assert.equal(manager.engineProfile().leadInMs, 0);
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


test('speech cleanup falls back to sentence-level highlighting when source offsets change', async () => {
  const { manager } = await loadPlaybackManager([]);
  const original = 'The result is reported [12] at https://example.com.';
  manager.queue = [{ index: 0, text: original }];
  manager.batchSize = 1;

  const batch = manager.buildBatch(0, 0);

  assert.equal(batch.pronunciationChanged, true,
    'removed citations and URLs invalidate direct speech-to-source word offsets');
  assert.equal(manager.queue[0].text, original,
    'the original source sentence must remain unchanged');
});

test('prosody edits fall back to sentence-level highlighting while unchanged text stays aligned', async () => {
  const { manager } = await loadPlaybackManager([]);
  manager.queue = [{ index: 0, text: 'The first clause — the second clause.' }];
  manager.batchSize = 1;
  const prosodyBatch = manager.buildBatch(0, 0);
  assert.equal(prosodyBatch.pronunciationChanged, true,
    'inserted prosody pauses can change character offsets');

  manager.queue = [{ index: 0, text: 'The first clause and the second clause.' }];
  const unchangedBatch = manager.buildBatch(0, 0);
  assert.equal(unchangedBatch.pronunciationChanged, false,
    'unchanged spoken text keeps exact word-offset highlighting');
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
  const sourcePrefix = 'A longer source sentence: ';
  const resumeOffset = sourcePrefix.length;
  manager.queue = [{ index: 0, text: `${sourcePrefix}${spokenRemainder}` }];
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
