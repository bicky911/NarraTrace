import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../sentence-tokenizer.js', import.meta.url), 'utf8');
const sandbox = {};
vm.runInNewContext(source, sandbox, { filename: 'sentence-tokenizer.js' });
const tokenizer = sandbox.ReadAloudTokenizer;

assert.ok(tokenizer, 'the tokenizer should expose its shared API');

test('normalizes hard-wrapped paragraphs and repeated whitespace', () => {
  const raw = 'A research paragraph is hard-wrapped\nacross source lines.\tIt must remain one\ncoherent reading block.';
  assert.equal(tokenizer.normalizeWhitespace(raw), 'A research paragraph is hard-wrapped across source lines. It must remain one coherent reading block.');
  assert.equal(tokenizer.splitIntoSentences(raw).length, 2);
});

test('keeps academic abbreviations, decimals, and dotted identifiers intact', () => {
  const raw = 'The method uses e.g. calibrated sensors and i.e. controlled inputs. Dr. Smith checked chrome.storage.session at 3.14 units. Fig. 2 shows the result. A second conclusion follows.';
  const sentences = tokenizer.splitIntoSentences(raw).map(item => item.text);
  assert.equal(sentences.length, 4);
  assert.equal(sentences[0], 'The method uses e.g. calibrated sensors and i.e. controlled inputs.');
  assert.match(sentences[1], /3\.14 units\.$/);
  assert.equal(sentences[2], 'Fig. 2 shows the result.');
  assert.equal(sentences[3], 'A second conclusion follows.');
});

test('does not split honorific titles from capitalized names', () => {
  const raw = 'The field report was reviewed by Dr. Smith before publication. Prof. A. Rahman approved the final analysis. The next trial begins in spring.';
  assert.equal(
    Array.from(tokenizer.splitIntoSentences(raw), item => item.text).join('\n'),
    [
      'The field report was reviewed by Dr. Smith before publication.',
      'Prof. A. Rahman approved the final analysis.',
      'The next trial begins in spring.'
    ].join('\n')
  );
});

test('preserves citation phrases and author initials without swallowing sentence boundaries', () => {
  const raw = 'T. aestivum was assessed by J. Smith et al. (2024), including Eq. (5) and No. 3. The follow-up experiment confirmed the trend.';
  const sentences = tokenizer.splitIntoSentences(raw).map(item => item.text);
  assert.equal(sentences.length, 2);
  assert.match(sentences[0], /^T\. aestivum/);
  assert.match(sentences[0], /J\. Smith et al\. \(2024\)/);
  assert.match(sentences[0], /Eq\. \(5\) and No\. 3\.$/);
});

test('recognizes Bengali and Hindi danda punctuation', () => {
  const bengali = tokenizer.splitIntoSentences('প্রথম বাক্যটি সম্পূর্ণ। দ্বিতীয় বাক্যটি এখানে।');
  const hindi = tokenizer.splitIntoSentences('पहला वाक्य पूरा है। दूसरा वाक्य यहाँ है॥');
  assert.equal(bengali.length, 2);
  assert.equal(hindi.length, 2);
  assert.equal(bengali[0].text, 'প্রথম বাক্যটি সম্পূর্ণ।');
  assert.equal(hindi[1].text, 'दूसरा वाक्य यहाँ है॥');
});

test('splits oversized unpunctuated blocks without losing or duplicating words', () => {
  const raw = Array.from({ length: 180 }, (_, index) => `field observation ${index + 1}`).join(' ');
  const chunks = tokenizer.splitIntoChunks(raw);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(item => item.text.length <= tokenizer.MAX_SENTENCE_CHARS));
  assert.deepEqual(chunks.map(item => item.index), chunks.map((_, index) => index));
  assert.equal(chunks.map(item => item.text).join(' '), raw);
});

test('oversized chunk offsets point back to original sentence text', () => {
  const raw = Array.from({ length: 130 }, (_, index) => `sample${index}`).join(', ');
  const chunks = tokenizer.splitOversized(raw, 80);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.equal(raw.slice(chunk.startOffset, chunk.startOffset + chunk.length), chunk.text);
  }
  for (let index = 1; index < chunks.length; index++) {
    assert.ok(chunks[index].startOffset > chunks[index - 1].startOffset);
  }
});

test('returns an empty queue for blank and non-string inputs', () => {
  assert.equal(tokenizer.splitIntoSentences('   \n\t ').length, 0);
  assert.equal(tokenizer.splitIntoSentences(null).length, 0);
  assert.equal(tokenizer.splitIntoChunks(42).length, 0);
});
