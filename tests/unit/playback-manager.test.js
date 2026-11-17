import test from "node:test";
import assert from "node:assert/strict";
import { playbackManager, PlaybackState } from "../../playback-manager.js";
import { KOKORO_EXTENSION_ID, SUPERTONIC_EXTENSION_ID } from "../../speech-engine.js";

const PlaybackManager = playbackManager.constructor;

function createManager() {
  return new PlaybackManager();
}

function installChromeTts(t, { speaking = false } = {}) {
  const previousChrome = globalThis.chrome;
  let currentSpeaking = speaking;
  globalThis.chrome = {
    runtime: { lastError: null },
    tts: {
      stop() {},
      isSpeaking(callback) {
        callback(currentSpeaking);
      }
    }
  };

  t.after(() => {
    if (previousChrome === undefined) {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = previousChrome;
    }
  });

  return {
    setSpeaking(value) {
      currentSpeaking = Boolean(value);
    }
  };
}

test("sanitizeQueue accepts strings and sentence objects, dropping malformed entries", () => {
  assert.deepEqual(
    PlaybackManager.sanitizeQueue([
      "First sentence.",
      { text: "Second sentence." },
      null,
      {},
      42,
      { text: "   " },
      { text: 123 }
    ]),
    [
      { index: 0, text: "First sentence." },
      { index: 1, text: "Second sentence." }
    ]
  );
});

test("sanitizeQueue enforces the 5000-item safety cap", () => {
  const source = Array.from({ length: 5005 }, (_, index) => "Sentence " + index + ".");
  assert.equal(PlaybackManager.sanitizeQueue(source).length, 5000);
});

test("pronunciation rules ignore comments and malformed lines", () => {
  const rules = PlaybackManager.parsePronunciations([
    "# custom dictionary",
    "",
    "Zea mays = zee-uh maze",
    "invalid line",
    " = missing source",
    "missing target = "
  ].join("\n"));

  assert.equal(rules.length, 1);
});

test("pronunciation replacements are case-insensitive and do not mutate original input", () => {
  const manager = createManager();
  manager.pronunciationRules = PlaybackManager.parsePronunciations("Zea mays = zee-uh maze");

  const input = "Zea mays is a crop. zea mays is widely grown.";
  const result = manager.applyPronunciations(input);

  assert.equal(result.changed, true);
  assert.equal(result.text, "zee-uh maze is a crop. zee-uh maze is widely grown.");
  assert.equal(input, "Zea mays is a crop. zea mays is widely grown.");
});

test("buildBatch maps words across punctuation-only prosody rewrites", () => {
  const manager = createManager();
  manager.batchSize = 1;
  manager.pronunciationRules = [];
  const source = "Alpha — beta: gamma.";
  manager.queue = [{ index: 0, text: source }];

  const batch = manager.buildBatch(0, 0);
  assert.equal(batch.wordAlignmentUsable, true);

  const beta = batch.wordAlignmentMaps[0].find((word) =>
    batch.spokenTexts[0].slice(word.spokenStart, word.spokenEnd) === "beta"
  );
  assert.ok(beta);
  assert.equal(beta.sourceStart, source.indexOf("beta"));
  assert.notEqual(beta.spokenStart, beta.sourceStart);
});

test("buildBatch disables word highlighting when semantic cleanup removes source words", () => {
  const manager = createManager();
  manager.batchSize = 1;
  manager.pronunciationRules = [];
  manager.queue = [{
    index: 0,
    text: "Read [1] the report at https://example.com/report and continue."
  }];

  const batch = manager.buildBatch(0, 0);
  assert.equal(batch.wordAlignmentUsable, false);
  assert.equal(batch.wordAlignmentMaps[0], null);
});

test("buildBatch disables word highlighting when pronunciation changes spoken words", () => {
  const manager = createManager();
  manager.batchSize = 1;
  manager.pronunciationRules = PlaybackManager.parsePronunciations(
    "Zea mays = zee-uh maze"
  );
  manager.queue = [{ index: 0, text: "Zea mays is a crop." }];

  const batch = manager.buildBatch(0, 0);
  assert.equal(batch.wordAlignmentUsable, false);
  assert.equal(batch.wordAlignmentMaps[0], null);
});

test("native word events are mapped back to original sentence character offsets", () => {
  const manager = createManager();
  manager.batchSize = 1;
  manager.pronunciationRules = [];
  const source = "Alpha — beta: gamma.";
  manager.queue = [{ index: 0, text: source }];
  const built = manager.buildBatch(0, 0);
  const batch = {
    ...built,
    currentSentence: 0,
    firstBoundaryDelay: null,
    firstBoundaryTime: null,
    requestedAt: Date.now(),
    startedAt: Date.now(),
    sawWords: false,
    sawSentences: false,
    firstWordAt: 0,
    lastWordAt: 0,
    firstWordIndex: 0,
    lastWordIndex: 0,
    anchorChar: null,
    anchorTime: null,
    anchorEnd: null,
    segmentIndex: 0
  };
  const messages = [];
  manager.broadcast = (action, payload) => messages.push({ action, payload });

  const spokenIndex = batch.spokenTexts[0].indexOf("beta");
  manager.handleTtsEvent({ type: "word", charIndex: spokenIndex, length: 4 }, batch);

  const wordMessage = messages.find((item) => item.action === "TTS_EVENT");
  assert.ok(wordMessage);
  assert.equal(wordMessage.payload.event.charIndex, source.indexOf("beta"));
  assert.equal(wordMessage.payload.event.charLength, 4);
  assert.equal(manager.lastWordCharIndex, source.indexOf("beta"));
});

test("Supertonic first-boundary estimator uses its seeded lead-in delay", () => {
  const manager = createManager();
  manager.options.extensionId = SUPERTONIC_EXTENSION_ID;
  const batch = {
    firstIndex: 0,
    offsets: [0],
    spokenLengths: [100],
    text: "x".repeat(100),
    anchorTime: 1000,
    anchorChar: 0,
    anchorEnd: 100,
    firstBoundaryDelay: 0,
    segmentIndex: 0
  };

  assert.equal(manager.calculateEstimatedPosition(batch, 3000), 0);
  assert.ok(manager.calculateEstimatedPosition(batch, 5000) > 0);
});

test("Kokoro late first boundary does not inherit Supertonic lead-in delay", () => {
  const manager = createManager();
  manager.options.extensionId = KOKORO_EXTENSION_ID;
  const batch = {
    firstIndex: 0,
    offsets: [0],
    spokenLengths: [100],
    text: "x".repeat(100),
    anchorTime: 10000,
    anchorChar: 0,
    anchorEnd: 100,
    firstBoundaryDelay: 10000,
    segmentIndex: 0
  };

  assert.equal(manager.calculateEstimatedPosition(batch, 12000), 27);
});

test("first early boundary interval does not erase Supertonic's seeded lead-in", () => {
  const manager = createManager();
  manager.options.extensionId = SUPERTONIC_EXTENSION_ID;
  const profile = manager.engineProfile();
  assert.equal(profile.leadInMs, 3200);
  assert.equal(profile.baseCharsPerSecond, 0);

  const text = "x".repeat(100);
  manager.queue = [{ index: 0, text }];
  manager.broadcast = () => {};
  const batch = {
    firstIndex: 0,
    offsets: [0],
    spokenLengths: [100],
    spokenTexts: [text],
    wordAlignmentMaps: [[]],
    text,
    currentSentence: 0,
    anchorChar: 0,
    anchorTime: 1000,
    anchorEnd: null,
    segmentIndex: 0,
    firstBoundaryDelay: 0,
    firstBoundaryTime: 1000,
    requestedAt: 1000
  };

  const originalNow = Date.now;
  Date.now = () => 9000;
  try {
    manager.handleTtsEvent({ type: "sentence", charIndex: 65 }, batch);
  } finally {
    Date.now = originalNow;
  }

  assert.ok(profile.baseCharsPerSecond > 0);
  assert.equal(profile.leadInMs, 3200);
});

test("system voice estimator does not inherit a network provider lead-in", () => {
  const manager = createManager();
  manager.options.extensionId = null;
  const batch = {
    firstIndex: 0,
    offsets: [0],
    spokenLengths: [100],
    text: "x".repeat(100),
    startedAt: 1000,
    anchorTime: null,
    requestedAt: 1000
  };

  assert.equal(manager.calculateEstimatedPosition(batch, 2000), 13.5);
});

test("deferred worker recovery state survives session save and restore", async (t) => {
  const previousChrome = globalThis.chrome;
  const sessionStore = {};
  globalThis.chrome = {
    storage: {
      session: {
        async set(values) {
          Object.assign(sessionStore, values);
        },
        async get(key) {
          return { [key]: sessionStore[key] };
        }
      }
    }
  };

  t.after(() => {
    if (previousChrome === undefined) {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = previousChrome;
    }
  });

  const source = createManager();
  source.playbackState = PlaybackState.PLAYING;
  source.queue = [{ index: 0, text: "Current sentence." }];
  source.currentIndex = 0;
  source.recoveryPendingAdvance = true;
  source._syncKeepAliveTick = () => {};

  await source.saveToSession();

  const restored = createManager();
  const didRestore = await restored.restoreFromSession();

  assert.equal(didRestore, true);
  assert.equal(restored.playbackState, PlaybackState.PLAYING);
  assert.equal(restored.currentIndex, 0);
  assert.equal(restored.recoveryPendingAdvance, true);
});

test("changing pitch resumes at the last confirmed word offset", async (t) => {
  installChromeTts(t);
  const manager = createManager();
  manager.playbackState = PlaybackState.PLAYING;
  manager.queue = [{ index: 0, text: "A sentence that is already being spoken." }];
  manager.wordEventsUsable = true;
  manager.sawWordEvents = true;
  manager.lastWordCharIndex = 17;
  manager.resumeOffset = 3;
  manager.savePreferences = async () => {};
  manager.saveToSession = async () => {};

  let spokenArgs = null;
  manager.speakCurrentSentence = (...args) => {
    spokenArgs = args;
  };

  await manager.setPitch(1.2);

  assert.ok(spokenArgs);
  assert.equal(spokenArgs[0], manager.playbackRunId);
  assert.equal(spokenArgs[1], 17);
});

test("worker recovery defers an active utterance and advances on a later idle check", async (t) => {
  const tts = installChromeTts(t, { speaking: true });
  const manager = createManager();
  manager.playbackState = PlaybackState.PLAYING;
  manager.queue = [
    { index: 0, text: "Current sentence." },
    { index: 1, text: "Next sentence." }
  ];
  manager.currentIndex = 0;
  manager.awaitingSpeech = false;
  manager.waitForSpeechIdle = async () => false;
  manager.saveToSession = async () => {};

  let restartCount = 0;
  manager.speakCurrentSentence = () => {
    restartCount++;
  };

  await manager.recoverAfterWorkerRestart();

  assert.equal(restartCount, 0);
  assert.equal(manager.currentIndex, 0);
  assert.equal(manager.playbackState, PlaybackState.PLAYING);
  assert.equal(manager.isSwitchingSentence, false);
  assert.equal(manager.recoveryPendingAdvance, true);

  // Simulate the next alarm after the browser-owned utterance has finished.
  tts.setSpeaking(false);
  await manager.recoverAfterWorkerRestart();

  assert.equal(manager.currentIndex, 1);
  assert.equal(restartCount, 1);
  assert.equal(manager.recoveryPendingAdvance, false);
});
test("worker recovery advances after the orphaned utterance becomes idle", async (t) => {
  installChromeTts(t, { speaking: true });
  const manager = createManager();
  manager.playbackState = PlaybackState.PLAYING;
  manager.queue = [
    { index: 0, text: "Current sentence." },
    { index: 1, text: "Next sentence." }
  ];
  manager.currentIndex = 0;
  manager.waitForSpeechIdle = async () => true;
  manager.saveToSession = async () => {};

  let restarted = false;
  manager.speakCurrentSentence = () => {
    restarted = true;
  };

  await manager.recoverAfterWorkerRestart();

  assert.equal(manager.currentIndex, 1);
  assert.equal(restarted, true);
});
