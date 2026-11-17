/**
 * Sentence tokenizer behavioural tests.
 *
 * The tokenizer decides how many chrome.tts utterances a page becomes, so a
 * bug here is directly audible: a bad split adds an intonation restart in the
 * middle of a sentence, and an over-eager split turns "Dr." into its own
 * spoken fragment. These tests pin the contract that calibration was tuned to.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

await import('../sentence-tokenizer.js');
const {
  splitIntoSentences,
  splitOversized,
  splitIntoChunks,
  normalizeWhitespace,
  MAX_SENTENCE_CHARS
} = globalThis.ReadAloudTokenizer;

const texts = (input) => splitIntoSentences(input).map((s) => s.text);

test('whitespace is collapsed, so hard-wrapped HTML stays one sentence', () => {
  assert.deepEqual(
    texts('The first line\nis wrapped   at eighty\ncolumns. It continues here.'),
    ['The first line is wrapped at eighty columns.', 'It continues here.']
  );
  assert.equal(normalizeWhitespace('  a \n\t b  '), 'a b');
});

test('plain sentences split after terminal punctuation', () => {
  assert.deepEqual(
    texts('One sentence. Two sentences! Three?'),
    ['One sentence.', 'Two sentences!', 'Three?']
  );
});

test('decimal numbers never split', () => {
  assert.deepEqual(texts('The dose was 3.14 mg. It was safe.'), [
    'The dose was 3.14 mg.',
    'It was safe.'
  ]);
  assert.deepEqual(texts('It costs $19.99 today. Cheap.'), ['It costs $19.99 today.', 'Cheap.']);
});

test('dotted identifiers and API names never split', () => {
  assert.deepEqual(texts('chrome.tts.speak works. It is fine.'), [
    'chrome.tts.speak works.',
    'It is fine.'
  ]);
  assert.deepEqual(texts('Version 1.2.3 is out. Try it.'), ['Version 1.2.3 is out.', 'Try it.']);
});

test('titles and honorifics joined to a capitalized name do not split (regression)', () => {
  // Before the fix these produced the fragments "Dr." / "Prof." / "Mr." as
  // separate utterances, each with its own intonation restart.
  assert.deepEqual(texts('Dr. Smith went home. He slept well.'), [
    'Dr. Smith went home.',
    'He slept well.'
  ]);
  assert.deepEqual(texts('Prof. Jones and Mr. Lee arrived. Then they left.'), [
    'Prof. Jones and Mr. Lee arrived.',
    'Then they left.'
  ]);
  assert.deepEqual(texts('St. Louis is nice. It is.'), ['St. Louis is nice.', 'It is.']);
});

test('Latin markers stay mid-sentence even before a capital', () => {
  assert.deepEqual(texts('The sample was taken (e.g. The control group). It worked.'), [
    'The sample was taken (e.g. The control group).',
    'It worked.'
  ]);
  assert.deepEqual(texts('Smith et al. (2020) reported the yield. It rose.'), [
    'Smith et al. (2020) reported the yield.',
    'It rose.'
  ]);
});

test('dotted acronyms stay whole (U.S. Army)', () => {
  assert.deepEqual(texts('U.S. Army troops moved. They were seen.'), [
    'U.S. Army troops moved.',
    'They were seen.'
  ]);
  assert.deepEqual(texts('The U.S. is large. It is.'), ['The U.S. is large.', 'It is.']);
});

test('genuine sentence-final abbreviations still split', () => {
  assert.deepEqual(texts('He said no. Then he left.'), ['He said no.', 'Then he left.']);
  assert.deepEqual(texts('Bring water, food, etc. Then go.'), ['Bring water, food, etc.', 'Then go.']);
});

test('ellipsis is a pause, not a hard stop', () => {
  assert.deepEqual(texts('One... two... three.'), ['One... two... three.']);
  assert.deepEqual(texts('Wait... What happened?'), ['Wait...', 'What happened?']);
  assert.deepEqual(texts('She paused… then continued. Fine.'), [
    'She paused… then continued.',
    'Fine.'
  ]);
});

test('closing quotes and brackets belong to the sentence that opened them', () => {
  assert.deepEqual(texts('He said “stop.” Then he ran.'), ['He said “stop.”', 'Then he ran.']);
  assert.deepEqual(texts('Ends with a quote.” Next one.'), ['Ends with a quote.”', 'Next one.']);
  assert.deepEqual(texts('(A complete aside.) Then more.'), ['(A complete aside.)', 'Then more.']);
});

test('Indic dandas terminate sentences (Bangla / Hindi)', () => {
  assert.deepEqual(texts('আমি বাংলায় লিখি। এটি একটি বাক্য।'), [
    'আমি বাংলায় লিখি।',
    'এটি একটি বাক্য।'
  ]);
  assert.deepEqual(texts('यह पहला वाक्य है। यह दूसरा है॥'), [
    'यह पहला वाक्य है।',
    'यह दूसरा है॥'
  ]);
});

test('empty and non-string input yields an empty queue', () => {
  assert.deepEqual(splitIntoSentences(''), []);
  assert.deepEqual(splitIntoSentences('   \n  '), []);
  assert.deepEqual(splitIntoSentences(null), []);
  assert.deepEqual(splitIntoSentences(42), []);
});

test('oversized text is split at clause boundaries, never mid-word', () => {
  const long = 'word '.repeat(300).trim();
  const chunks = splitOversized(long);
  assert.ok(chunks.length > 1, 'expected more than one chunk');
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= MAX_SENTENCE_CHARS);
    assert.ok(!chunk.text.startsWith(' '), 'chunks are trimmed at the front');
    assert.ok(!chunk.text.endsWith(' '), 'chunks are trimmed at the back');
  }
  assert.equal(chunks[0].startOffset, 0);
  // Offsets must stay usable as source positions in the original text.
  for (const chunk of chunks) {
    assert.equal(long.slice(chunk.startOffset, chunk.startOffset + chunk.length), chunk.text);
  }
});

test('splitIntoChunks renumbers the queue after capping long sentences', () => {
  const input = `${'Long clause, '.repeat(60)}end. Short one.`;
  const queue = splitIntoChunks(input);
  assert.ok(queue.length >= 2);
  queue.forEach((item, i) => {
    assert.equal(item.index, i);
    assert.ok(item.text.length <= MAX_SENTENCE_CHARS);
    assert.ok(item.text.length > 0);
  });
});

test('a 4000-sentence document is tokenized in reasonable time', () => {
  const doc = 'This is a normal sentence about irrigation. '.repeat(4000);
  const started = process.hrtime.bigint();
  const out = splitIntoSentences(doc);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(out.length, 4000);
  assert.ok(ms < 1000, `tokenizing took ${ms.toFixed(0)}ms`);
});
