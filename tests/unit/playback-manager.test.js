import test from "node:test";
import assert from "node:assert/strict";
import { playbackManager, PlaybackState } from "../../playback-manager.js";

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
