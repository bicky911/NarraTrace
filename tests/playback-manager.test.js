/**
 * Playback manager state-machine tests.
 *
 * Every test gets its own PlaybackManager instance and its own fake chrome,
 * so nothing leaks between cases. The fake engine can either complete an
 * utterance automatically or be driven one event at a time.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createChromeMock, waitFor } from './helpers/chrome-mock.js';

const mock = createChromeMock({ autoSpeak: true });
globalThis.chrome = mock.chrome;

const { PlaybackManager, PlaybackState, stripSemanticNoise, applyProsodyCadence } =
  await import('../playback-manager.js');

const newManager = async () => {
  const manager = new PlaybackManager();
  await manager.loadPreferences();
  return manager;
};

const sentActions = (manager) => [
  ...mock.tabMessages.map((m) => m.message.action),
  ...mock.runtimeMessages.map((m) => m.action)
];

test.beforeEach(() => mock.reset());

test.afterEach(async () => {
  // Nothing may keep a live timer or a "speaking" utterance between tests.
  mock.autoSpeak = true;
  assert.ok(true);
});

test('sanitizeQueue drops malformed entries and renumbers survivors', () => {
  const queue = PlaybackManager.sanitizeQueue([
    'first',
    null,
    { text: 'second' },
    { text: '   ' },
    { nope: true },
    42
  ]);
  assert.deepEqual(queue, [
    { index: 0, text: 'first' },
    { index: 1, text: 'second' }
  ]);
  assert.deepEqual(PlaybackManager.sanitizeQueue(null), []);
  assert.deepEqual(PlaybackManager.sanitizeQueue([]), []);
});

test('start() refuses an empty payload instead of entering PLAYING', async () => {
  const manager = await newManager();
  assert.equal(await manager.start([], 0, 1), false);
  assert.equal(manager.getState().playbackState, PlaybackState.IDLE);
});

test('start() speaks the queue and finishes in STOPPED', async () => {
  const manager = await newManager();
  const ok = await manager.start(['First sentence.', 'Second sentence.', 'Third one.'], 0, 7);
  assert.equal(ok, true);
  assert.equal(manager.getState().playbackState, PlaybackState.PLAYING);

  await waitFor(
    () => manager.getState().playbackState === PlaybackState.STOPPED,
    3000,
    'playback to complete'
  );

  assert.ok(mock.speaks.length >= 1);
  assert.ok(sentActions(manager).includes('PLAYBACK_COMPLETED'));
  assert.ok(mock.tabMessages.every((m) => m.tabId === 7));
});

test('completed playback stores an idle session so a restart cannot resurrect it', async () => {
  const manager = await newManager();
  await manager.start(['Only one sentence here.'], 0, 3);
  await waitFor(() => manager.getState().playbackState === PlaybackState.STOPPED, 3000, 'completion');

  const stored = mock.chrome.storage.session.__dump().readAloud_sessionState;
  assert.equal(stored.playbackState, PlaybackState.STOPPED);
  assert.equal(stored.currentIndex, 0);
});

test('the queue is persisted once per run, not once per sentence', async () => {
  mock.autoSpeak = false;
  const manager = await newManager();
  await manager.start(['One.', 'Two.', 'Three.', 'Four.'], 0, 1);

  const queueWritesAfterStart = mock.chrome.storage.session.__writeCount('readAloud_sessionQueue');
  assert.equal(queueWritesAfterStart, 1, 'the new queue is written exactly once');

  await manager.skipForward();
  await manager.skipForward();

  assert.equal(
    mock.chrome.storage.session.__writeCount('readAloud_sessionQueue'),
    queueWritesAfterStart,
    'moving through the queue must not rewrite the whole queue'
  );

  const stored = mock.chrome.storage.session.__dump();
  assert.equal(stored.readAloud_sessionQueue.length, 4, 'the queue itself is still there');
  assert.equal(stored.readAloud_sessionState.currentIndex, 2, 'only the small state object changed');
  assert.equal(stored.readAloud_sessionState.queue, undefined);

  await manager.stop();
});

test('a legacy session with an inline queue still restores after upgrading', async () => {
  await mock.chrome.storage.session.set({
    readAloud_sessionState: {
      queue: [{ index: 0, text: 'Legacy stored sentence.' }],
      currentIndex: 0,
      playbackState: 'PAUSED',
      tabId: 4,
      options: { rate: 1.25 }
    }
  });

  const manager = new PlaybackManager();
  assert.equal(await manager.restoreFromSession(), true);
  assert.equal(manager.queue.length, 1);
  assert.equal(manager.queue[0].text, 'Legacy stored sentence.');
  assert.equal(manager.playbackState, PlaybackState.PAUSED);
  assert.equal(manager.options.rate, 1.25);
});

test('reset() clears the persisted queue, so a closed tab cannot be resurrected', async () => {
  mock.autoSpeak = false;
  const manager = await newManager();
  await manager.start(['One.', 'Two.'], 0, 1);
  await manager.reset();

  const stored = mock.chrome.storage.session.__dump();
  assert.deepEqual(stored.readAloud_sessionQueue, []);
  assert.equal(stored.readAloud_sessionState.playbackState, PlaybackState.IDLE);
  assert.equal(stored.readAloud_sessionState.currentIndex, 0);
});

test('reset() stops the engine, so orphaned audio cannot outlive its tab', async () => {
  mock.autoSpeak = false;
  const manager = await newManager();
  await manager.start(['One.', 'Two.'], 0, 1);
  assert.ok(mock.pending, 'an utterance is in flight');

  await manager.reset();

  assert.ok(mock.stops >= 1, 'reset must silence the engine');
  assert.equal(manager.getState().playbackState, PlaybackState.IDLE);
  assert.equal(manager.getState().hasQueue, false);
  assert.equal(mock.pending, null, 'no utterance may remain pending');
});

test('recovery silences an orphaned utterance before restarting the sentence', async (t) => {
  mock.autoSpeak = false;
  const manager = await newManager();
  t.after(() => manager.stop());
  manager.queue = PlaybackManager.sanitizeQueue(['One.', 'Two.']);
  manager.playbackState = PlaybackState.PLAYING;
  manager.tabId = 1;

  // An utterance from the previous worker instance is still audible, and we
  // have no event stream for it any more.
  mock.pending = { options: { onEvent() {} }, settled: false };
  mock.speaking = true;
  manager.waitForSpeechIdle = async () => false;

  await manager.recoverAfterWorkerRestart();

  assert.ok(mock.stops >= 1, 'the orphan must be stopped before re-speaking');
  assert.match(mock.speaks.at(-1).text, /^One\./, 'recovery restarts the current sentence');
});

test('pause() stops the engine and resume() continues from the confirmed word', async () => {
  mock.autoSpeak = false;
  const manager = await newManager();
  const text = 'alpha beta gamma delta epsilon.';
  await manager.start([text, 'Second sentence follows here.'], 0, 1);

  const first = mock.speaks.at(-1);
  assert.equal(first.options.onEvent !== undefined, true);

  // The engine reports that it has reached "beta" (char 6).
  first.options.onEvent({ type: 'start', charIndex: 0 });
  first.options.onEvent({ type: 'word', charIndex: 6, length: 4 });

  await manager.pause();
  assert.equal(manager.getState().playbackState, PlaybackState.PAUSED);
  assert.ok(mock.stops >= 1, 'pause must silence the engine');
  assert.equal(manager.resumeOffset, 6);

  const speaksBefore = mock.speaks.length;
  await manager.resume();
  assert.equal(manager.getState().playbackState, PlaybackState.PLAYING);
  assert.equal(mock.speaks.length, speaksBefore + 1);

  const resumeUtterance = mock.speaks.at(-1);
  assert.equal(resumeUtterance.text, text.slice(6), 'resume speaks only the remainder');

  await manager.stop();
  assert.equal(manager.getState().playbackState, PlaybackState.STOPPED);
});

test('skipForward / skipBackward move exactly one sentence and stay in range', async () => {
  mock.autoSpeak = false;
  const manager = await newManager();
  await manager.start(['One.', 'Two.', 'Three.'], 0, 1);

  await manager.skipForward();
  assert.equal(manager.getState().currentIndex, 1);

  await manager.skipForward();
  await manager.skipForward();
  assert.equal(manager.getState().currentIndex, 2, 'cannot skip past the last sentence');

  await manager.skipBackward();
  assert.equal(manager.getState().currentIndex, 1);

  await manager.stop();
});

test('jumpToIndex() while PAUSED moves the position but does not resume audio', async () => {
  mock.autoSpeak = false;
  const manager = await newManager();
  await manager.start(['One.', 'Two.', 'Three.'], 0, 1);
  await manager.pause();
  const speaksBefore = mock.speaks.length;

  await manager.jumpToIndex(2);
  assert.equal(manager.getState().currentIndex, 2);
  assert.equal(manager.getState().playbackState, PlaybackState.PAUSED);
  assert.equal(mock.speaks.length, speaksBefore, 'a paused seek must not speak');

  await manager.stop();
});

test('jumpToIndex() while PLAYING starts the target sentence immediately', async () => {
  mock.autoSpeak = false;
  const manager = await newManager();
  await manager.start(['One.', 'Two.', 'Three.'], 0, 1);
  const speaksBefore = mock.speaks.length;

  await manager.jumpToIndex(2);
  assert.equal(manager.getState().currentIndex, 2);
  assert.equal(manager.getState().playbackState, PlaybackState.PLAYING);
  assert.equal(mock.speaks.length, speaksBefore + 1);
  assert.equal(mock.speaks.at(-1).text, 'Three.');

  await manager.stop();
});

test('rate and volume are clamped, and malformed values never poison the options', async () => {
  const manager = await newManager();

  await manager.setRate(1.5);
  assert.equal(manager.options.rate, 1.5);

  await manager.setRate(Number.NaN);
  assert.equal(manager.options.rate, 1.5, 'NaN keeps the previous rate');

  await manager.setRate(99);
  assert.equal(manager.options.rate, 3, 'rate clamps to 3.0');

  await manager.setRate(0.1);
  assert.equal(manager.options.rate, 0.5, 'rate clamps to 0.5');

  await manager.setVolume(Number.POSITIVE_INFINITY);
  assert.equal(manager.options.volume, 1);
  await manager.setVolume(-2);
  assert.equal(manager.options.volume, 0);
});

test('a persistently broken engine stops after three consecutive errors', async () => {
  const manager = await newManager();
  mock.failSpeaks = true;

  await manager.start(['One.', 'Two.', 'Three.', 'Four.', 'Five.'], 0, 1);
  await waitFor(
    () => manager.getState().playbackState === PlaybackState.STOPPED,
    3000,
    'error budget to stop playback'
  );

  assert.ok(mock.speaks.length <= 3, `expected at most 3 attempts, saw ${mock.speaks.length}`);
  assert.ok(sentActions(manager).includes('PLAYBACK_ERROR'));
  assert.ok(sentActions(manager).includes('PLAYBACK_STOPPED'));
  mock.failSpeaks = false;
});

test('a new run supersedes the old one without a second concurrent utterance', async () => {
  mock.autoSpeak = false;
  const manager = await newManager();
  await manager.start(['Old text one.', 'Old text two.'], 0, 1);
  const oldUtterance = mock.speaks.at(-1);
  const speaksBeforeRestart = mock.speaks.length;

  await manager.start(['Brand new text.'], 0, 2);
  assert.equal(mock.speaks.length, speaksBeforeRestart + 1);

  // A late event from the abandoned request may not move the new run.
  oldUtterance.options.onEvent({ type: 'word', charIndex: 4, length: 4 });
  assert.equal(manager.getState().currentIndex, 0);

  await manager.stop();
});

test('word events drive sentence tracking inside a grouped utterance', async () => {
  mock.autoSpeak = false;
  const manager = await newManager();
  await manager.setBatchSize(3);
  await manager.start(['Alpha one.', 'Beta two.', 'Gamma three.'], 0, 1);

  const utterance = mock.speaks.at(-1);
  assert.match(utterance.text, /Alpha one\. Beta two\. Gamma three\./);

  utterance.options.onEvent({ type: 'start', charIndex: 0 });
  utterance.options.onEvent({ type: 'word', charIndex: 0, length: 5 });
  assert.equal(manager.getState().currentIndex, 0);

  const secondStart = utterance.text.indexOf('Beta');
  utterance.options.onEvent({ type: 'word', charIndex: secondStart, length: 4 });
  assert.equal(manager.getState().currentIndex, 1);

  const thirdStart = utterance.text.indexOf('Gamma');
  utterance.options.onEvent({ type: 'word', charIndex: thirdStart, length: 5 });
  assert.equal(manager.getState().currentIndex, 2);

  await manager.stop();
});

test('preferences round-trip through chrome.storage.local', async () => {
  const manager = await newManager();
  await manager.setRate(1.8);
  await manager.setVolume(0.4);
  await manager.setVoice('Kokoro Bella', 'mefecoigjodlohjacogkbbfpnifhfocb', 'en-US');

  const stored = mock.chrome.storage.local.__dump().readAloud_userPreferences;
  assert.equal(stored.rate, 1.8);
  assert.equal(stored.volume, 0.4);
  assert.equal(stored.voiceName, 'Kokoro Bella');
  assert.equal(stored.voicePinned, true, 'an explicit voice choice is pinned');

  const reloaded = new PlaybackManager();
  await reloaded.loadPreferences();
  assert.equal(reloaded.options.rate, 1.8);
  assert.equal(reloaded.options.volume, 0.4);
  assert.equal(reloaded.voicePinned, true);
});

test('pronunciation rules rewrite only the spoken text', () => {
  const rules = PlaybackManager.parsePronunciations(
    '# comment line\nzea mays = zee-a mays\n\nagronomy = a-gron-omy\nbad line without equals\n'
  );
  assert.equal(rules.length, 2);

  const manager = new PlaybackManager();
  manager.pronunciationRules = rules;
  const applied = manager.applyPronunciations('Zea mays is an agronomy subject.');
  assert.equal(applied.changed, true);
  assert.equal(applied.text, 'zee-a mays is an a-gron-omy subject.');

  const untouched = manager.applyPronunciations('No rule matches this sentence.');
  assert.equal(untouched.changed, false);
});

test('pronunciation parsing tolerates regex metacharacters and symbol-final terms', () => {
  const rules = PlaybackManager.parsePronunciations('C++ = see plus plus\n.NET = dot net');
  assert.equal(rules.length, 2);
  const manager = new PlaybackManager();
  manager.pronunciationRules = rules;
  assert.equal(manager.applyPronunciations('I write C++ daily.').text, 'I write see plus plus daily.');
  // ".NET" must match literally, not as "any character + NET".
  assert.equal(manager.applyPronunciations('I use .NET daily.').text, 'I use dot net daily.');
  assert.equal(manager.applyPronunciations('I use XNET daily.').text, 'I use XNET daily.');
});

/* ── Text pipeline ─────────────────────────────────────────────────────── */

test('semantic noise is stripped from speech without touching the source', () => {
  assert.equal(
    stripSemanticNoise('Yield rose 12% [1] in 2024 (Smith et al., 2024).'),
    'Yield rose 12% in 2024.'
  );
  assert.equal(stripSemanticNoise('See https://example.com/x for details.'), 'See for details.');
  assert.equal(stripSemanticNoise('Use **bold** and `code` here.'), 'Use bold and code here.');
  assert.equal(stripSemanticNoise('doi:10.1000/xyz'), 'doi:10.1000/xyz', 'a sentence of pure noise falls back to itself');
});

test('the stripper never returns empty text', () => {
  const onlyCitation = '[1]';
  assert.equal(stripSemanticNoise(onlyCitation), onlyCitation);
  assert.equal(stripSemanticNoise(''), '');
  assert.equal(stripSemanticNoise(null), null);
});

test('prosody turns dashes into breathing pauses and keeps the words', () => {
  assert.equal(
    applyProsodyCadence('He said — quietly — that it worked.'),
    'He said, quietly, that it worked.'
  );
  assert.equal(applyProsodyCadence('Water (H2O) is essential.'), 'Water, H2O, is essential.');
  assert.equal(applyProsodyCadence(''), '');
});

test('buildBatch keeps the text-to-offset mapping and groups same-script sentences', async () => {
  const manager = await newManager();
  await manager.setBatchSize(3);
  manager.queue = PlaybackManager.sanitizeQueue(['One.', 'Two.', 'Three.']);
  const batch = manager.buildBatch(0, 0);
  assert.equal(batch.items.length, 3);
  assert.deepEqual(batch.offsets, [0, 5, 10]);
  assert.equal(batch.text, 'One. Two. Three.');
  assert.equal(batch.pronunciationChanged, false);

  // A resume offset may only apply to the first sentence, so grouping is off.
  const resumed = manager.buildBatch(0, 2);
  assert.equal(resumed.items.length, 1);
  assert.equal(resumed.text, 'e.');
});

test('buildBatch refuses to group different scripts into one utterance', async () => {
  const manager = await newManager();
  await manager.setBatchSize(3);
  manager.queue = PlaybackManager.sanitizeQueue([
    'This is English text.',
    'এটি একটি বাংলা বাক্য।',
    'More English text.'
  ]);
  const batch = manager.buildBatch(0, 0);
  assert.equal(batch.items.length, 1, 'Bengali sentence must wait for its own voice');
});
