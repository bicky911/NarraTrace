/**
 * Spoken-text vs page-text offsets.
 *
 * The speech pipeline is allowed to rewrite what the voice says
 * (`stripSemanticNoise`, `applyProsodyCadence`, `applyPronunciations`), but a
 * word event's `charIndex` always indexes the SPOKEN string. Applying it to the
 * original page sentence highlights the wrong word for the rest of any
 * rewritten sentence — and, worse, `pause()` stored that number and `resume()`
 * cut into the middle of a word with it.
 *
 * These tests pin the contract:
 *   1. `buildBatch()` records, per sentence, whether the spoken form is
 *      byte-for-byte the source form.
 *   2. Word events are only treated as page offsets for those sentences.
 *   3. Sentence-level tracking works for every sentence, rewritten or not.
 *   4. Pause/resume and option changes never reuse an unmappable offset.
 *
 * Regression for the 1.5.0 audit finding F1.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createChromeMock, waitFor } from './helpers/chrome-mock.js';

const mock = createChromeMock({ autoSpeak: false });
globalThis.chrome = mock.chrome;

const { PlaybackManager } = await import('../playback-manager.js');

// Every manager owns a live estimator interval. Left running, it broadcasts
// into the shared mock and corrupts the *next* test's "last word event".
let activeManager = null;

const newManager = async (batchSize = 1) => {
  const manager = new PlaybackManager();
  await manager.loadPreferences();
  await manager.setBatchSize(batchSize);
  activeManager = manager;
  return manager;
};

/** Every TTS_EVENT broadcast reaches both the tab and the runtime channel. */
const broadcastEvents = () =>
  mock.runtimeMessages.concat(mock.tabMessages)
    .map((entry) => (entry.message ? entry.message : entry))
    .filter((message) => message.action === 'TTS_EVENT');

const wordEvents = () => broadcastEvents().filter((message) => message.event?.type === 'word');

const lastUtterance = () => mock.speaks.at(-1);

/** Drive the pending utterance's event callback directly. */
const emit = (event) => lastUtterance().options.onEvent(event);

test.beforeEach(() => {
  mock.reset();
  // Drive every event explicitly: wall-clock auto-speech would race the
  // assertions below and hide exactly the offsets under test.
  mock.autoSpeak = false;
});

test.afterEach(async () => {
  if (activeManager) {
    await activeManager.stop();
    activeManager = null;
  }
});

/* ── 1. Per-sentence alignment is recorded by buildBatch ──────────────── */

test('a citation-stripped sentence is marked as not word-aligned', async () => {
  const manager = await newManager();
  const original = 'Yield rose 12% [1] in 2024.';
  manager.queue = PlaybackManager.sanitizeQueue([original]);

  const batch = manager.buildBatch(0, 0);

  assert.notEqual(batch.text, original, 'the spoken text must really differ from the source');
  assert.equal(batch.spokenTexts[0].length < original.length, true);
  assert.deepEqual(batch.wordAligned, [false]);
});

test('a URL-stripped sentence is marked as not word-aligned', async () => {
  const manager = await newManager();
  const original = 'See https://example.com/data for the figures.';
  manager.queue = PlaybackManager.sanitizeQueue([original]);

  const batch = manager.buildBatch(0, 0);

  assert.notEqual(batch.text, original);
  assert.deepEqual(batch.wordAligned, [false]);
});

test('an em-dash rewritten sentence is marked as not word-aligned', async () => {
  const manager = await newManager();
  const original = 'He said — quietly — that it worked.';
  manager.queue = PlaybackManager.sanitizeQueue([original]);

  const batch = manager.buildBatch(0, 0);

  assert.notEqual(batch.text, original);
  assert.deepEqual(batch.wordAligned, [false]);
});

test('a parenthetical rewritten sentence is marked as not word-aligned', async () => {
  const manager = await newManager();
  const original = 'Water (H2O) is essential.';
  manager.queue = PlaybackManager.sanitizeQueue([original]);

  const batch = manager.buildBatch(0, 0);

  assert.notEqual(batch.text, original);
  assert.deepEqual(batch.wordAligned, [false]);
});

test('a pronunciation-rewritten sentence is marked as not word-aligned', async () => {
  const manager = await newManager();
  manager.pronunciationRules = PlaybackManager.parsePronunciations('C++ = see plus plus');
  const original = 'I write C++ daily.';
  manager.queue = PlaybackManager.sanitizeQueue([original]);

  const batch = manager.buildBatch(0, 0);

  assert.notEqual(batch.text, original);
  assert.deepEqual(batch.wordAligned, [false]);
});

test('an untouched sentence stays aligned and byte-identical', async () => {
  const manager = await newManager();
  const original = 'Plain sentence without rewrites.';
  manager.queue = PlaybackManager.sanitizeQueue([original]);

  const batch = manager.buildBatch(0, 0);

  assert.equal(batch.text, original);
  assert.deepEqual(batch.wordAligned, [true]);
});

test('a grouped batch records alignment per sentence', async () => {
  const manager = await newManager(3);
  manager.queue = PlaybackManager.sanitizeQueue([
    'Plain opener here.',
    'An aside with (parentheses) inside.',
    'Another plain sentence.'
  ]);

  const batch = manager.buildBatch(0, 0);

  assert.equal(batch.items.length, 3);
  assert.deepEqual(batch.wordAligned, [true, false, true]);
  assert.equal(batch.spokenTexts[0], batch.items[0].text, 'plain sentence is spoken verbatim');
  assert.notEqual(batch.spokenTexts[1], batch.items[1].text, 'parenthetical sentence was rewritten');
  assert.equal(batch.spokenTexts[2], batch.items[2].text, 'plain sentence is spoken verbatim');
});

test('a resumed batch is aligned only if the spoken remainder matches', async () => {
  const manager = await newManager();
  manager.queue = PlaybackManager.sanitizeQueue([
    'Plain sentence without rewrites.',
    'Yield rose 12% [1] in 2024.'
  ]);

  const plain = manager.buildBatch(0, 8);
  assert.equal(plain.text, manager.queue[0].text.slice(8));
  assert.deepEqual(plain.wordAligned, [true]);

  const rewritten = manager.buildBatch(1, 4);
  assert.deepEqual(rewritten.wordAligned, [false]);
});

/* ── 2. Word events from rewritten speech never become page offsets ────── */

test('a word event from rewritten speech is broadcast unaligned and stores no offset', async () => {
  const manager = await newManager();
  await manager.start(['Yield rose 12% [1] in 2024.'], 0, 1);
  manager.stopEstimator();

  emit({ type: 'start', charIndex: 0 });
  const spokenIndex = lastUtterance().text.indexOf('2024');
  assert.ok(spokenIndex > 0);
  emit({ type: 'word', charIndex: spokenIndex, length: 4 });

  const word = wordEvents().at(-1);
  assert.equal(word.aligned, false, 'the page must not be told this offset is usable');
  assert.equal(word.index, 0, 'sentence tracking must still be correct');
  assert.equal(manager.getState().currentIndex, 0);
  assert.equal(manager.sawWordEvents, false, 'no resume offset may be derived from it');
  assert.equal(manager.lastWordCharIndex, 0);
});

test('a word event from untouched speech still maps to the page', async () => {
  const manager = await newManager();
  const original = 'Plain sentence without rewrites.';
  await manager.start([original], 0, 1);
  manager.stopEstimator();

  emit({ type: 'start', charIndex: 0 });
  emit({ type: 'word', charIndex: 6, length: 8 });

  const word = wordEvents().at(-1);
  assert.equal(word.aligned, true);
  assert.equal(word.event.charIndex, 6);
  assert.equal(word.index, 0);
  assert.equal(manager.lastWordCharIndex, 6);
  assert.equal(manager.lastWordSentence, 0);
});

test('sentence tracking survives rewritten sentences inside a grouped batch', async () => {
  const manager = await newManager(3);
  await manager.start([
    'Plain opener here.',
    'An aside with (parentheses) inside.',
    'Another plain sentence.'
  ], 0, 1);
  manager.stopEstimator();

  const utterance = lastUtterance();
  emit({ type: 'start', charIndex: 0 });

  const secondStart = utterance.text.indexOf('An aside');
  emit({ type: 'word', charIndex: secondStart + 3, length: 5 });
  assert.equal(manager.getState().currentIndex, 1, 'the rewritten sentence is still tracked');
  assert.equal(wordEvents().at(-1).aligned, false);
  assert.equal(manager.sawWordEvents, false);

  const thirdStart = utterance.text.indexOf('Another');
  emit({ type: 'word', charIndex: thirdStart + 2, length: 7 });
  assert.equal(manager.getState().currentIndex, 2);
  assert.equal(wordEvents().at(-1).aligned, true);
  assert.equal(manager.lastWordCharIndex, 2, 'offset is relative to its own sentence');
  assert.equal(manager.lastWordSentence, 2);
});

/* ── 3. Pause/resume never reuses an unmappable offset ─────────────────── */

test('pausing inside a rewritten sentence resumes at the sentence start', async () => {
  const manager = await newManager();
  await manager.start(['Yield rose 12% [1] in 2024.'], 0, 1);
  manager.stopEstimator();

  emit({ type: 'start', charIndex: 0 });
  emit({ type: 'word', charIndex: lastUtterance().text.indexOf('2024'), length: 4 });

  await manager.pause();
  assert.equal(manager.resumeOffset, 0, 'an offset into the spoken rewrite must not be kept');

  await manager.resume();
  assert.equal(lastUtterance().text, 'Yield rose 12% in 2024.', 'the whole sentence is re-spoken');
  await manager.stop();
});

test('an aligned sentence in a mixed batch still traces and resumes precisely', async () => {
  const manager = await newManager(2);
  await manager.start(['Plain opener here.', 'An aside with (parentheses) inside.'], 0, 1);
  manager.stopEstimator();

  emit({ type: 'start', charIndex: 0 });
  emit({ type: 'word', charIndex: 6, length: 8 });   // "opener", sentence 0 (aligned)

  assert.equal(manager.wordEventsUsable, false, 'the batch as a whole contains a rewrite');
  assert.equal(wordEvents().at(-1).aligned, true, 'this sentence is still traceable');
  assert.equal(manager.lastWordCharIndex, 6);

  await manager.pause();
  assert.equal(manager.resumeOffset, 6, 'a valid per-sentence offset is not thrown away');
  await manager.resume();
  assert.equal(lastUtterance().text, 'opener here.');
  await manager.stop();
});

test('pausing inside untouched speech keeps the exact word offset', async () => {
  const manager = await newManager();
  const original = 'Plain sentence without rewrites.';
  await manager.start([original], 0, 1);
  manager.stopEstimator();

  emit({ type: 'start', charIndex: 0 });
  emit({ type: 'word', charIndex: 6, length: 8 });

  await manager.pause();
  assert.equal(manager.resumeOffset, 6);

  await manager.resume();
  assert.equal(lastUtterance().text, original.slice(6));
  await manager.stop();
});

test('a stale offset from a previous sentence is not reused after a rewrite', async () => {
  const manager = await newManager(2);
  await manager.start(['Plain first sentence here.', 'Rewritten (aside) second.'], 0, 1);
  manager.stopEstimator();

  const utterance = lastUtterance();
  emit({ type: 'start', charIndex: 0 });
  emit({ type: 'word', charIndex: 6, length: 8 });          // aligned, sentence 0
  assert.equal(manager.lastWordSentence, 0);

  const secondStart = utterance.text.indexOf('Rewritten');
  emit({ type: 'word', charIndex: secondStart + 4, length: 8 }); // rewritten, sentence 1
  assert.equal(manager.getState().currentIndex, 1);

  await manager.pause();
  assert.equal(manager.resumeOffset, 0, 'sentence 0’s offset must not be applied to sentence 1');
  await manager.stop();
});

test('changing the rate mid-sentence does not restart inside a rewritten word', async () => {
  const manager = await newManager();
  await manager.start(['Yield rose 12% [1] in 2024.'], 0, 1);
  manager.stopEstimator();

  emit({ type: 'start', charIndex: 0 });
  emit({ type: 'word', charIndex: lastUtterance().text.indexOf('2024'), length: 4 });

  const speaksBefore = mock.speaks.length;
  await manager.setRate(1.2);
  await waitFor(() => mock.speaks.length === speaksBefore + 1, 1000, 'rate change to restart the sentence');
  assert.equal(lastUtterance().text, 'Yield rose 12% in 2024.');
  await manager.stop();
});

test('a resume offset on untouched speech is preserved and mapped', async () => {
  const manager = await newManager();
  const original = 'Plain sentence without rewrites.';
  manager.queue = PlaybackManager.sanitizeQueue([original]);
  manager.playbackState = 'PLAYING';
  manager.tabId = 1;

  manager.speakCurrentSentence(manager.playbackRunId, 6);
  await waitFor(() => mock.speaks.length === 1, 1000, 'resumed utterance');
  manager.stopEstimator();

  const utterance = lastUtterance();
  assert.equal(utterance.text, original.slice(6), 'speech starts at the resume offset');

  emit({ type: 'word', charIndex: 0, length: 8 });
  assert.equal(manager.lastWordCharIndex, 6, 'page offset adds the resume offset back');
  assert.equal(manager.lastWordSentence, 0);
  await manager.stop();
});

test('a stored resume offset into rewritten speech still cannot map words', async () => {
  const manager = await newManager();
  manager.queue = PlaybackManager.sanitizeQueue(['Yield rose 12% [1] in 2024.']);
  manager.playbackState = 'PLAYING';
  manager.tabId = 1;

  manager.speakCurrentSentence(manager.playbackRunId, 4);
  await waitFor(() => mock.speaks.length === 1, 1000, 'resumed utterance');
  manager.stopEstimator();

  emit({ type: 'word', charIndex: 2, length: 4 });
  assert.equal(manager.sawWordEvents, false);
  assert.equal(manager.lastWordCharIndex, 0);
  await manager.stop();
});
