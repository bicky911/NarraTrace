import test from "node:test";
import assert from "node:assert/strict";
import "../../sentence-tokenizer.js";

const tokenizer = globalThis.ReadAloudTokenizer;

test("tokenizer is exposed for both browser and module consumers", () => {
  assert.ok(tokenizer);
  assert.equal(typeof tokenizer.splitIntoSentences, "function");
  assert.equal(typeof tokenizer.splitIntoChunks, "function");
});

test("normalizes repeated whitespace without changing the words", () => {
  assert.equal(
    tokenizer.normalizeWhitespace("  First\tline\n second   line  "),
    "First line second line"
  );
});

test("does not split decimal numbers into separate sentences", () => {
  const sentences = tokenizer.splitIntoSentences("The result is 3.14159. The next result is 2.5.");
  assert.deepEqual(sentences.map((item) => item.text), [
    "The result is 3.14159.",
    "The next result is 2.5."
  ]);
});

test("recognizes Indic sentence terminators", () => {
  const sentences = tokenizer.splitIntoSentences("এটি প্রথম বাক্য। এটি দ্বিতীয় বাক্য॥");
  assert.deepEqual(sentences.map((item) => item.text), [
    "এটি প্রথম বাক্য।",
    "এটি দ্বিতীয় বাক্য॥"
  ]);
});

test("splits oversized text into bounded chunks while preserving its words and order", () => {
  const source = Array.from({ length: 260 }, (_, index) => "word" + index).join(" ");
  const chunks = tokenizer.splitIntoChunks(source);

  assert.ok(chunks.length > 1, "expected more than one chunk");
  assert.ok(chunks.every((chunk) => chunk.text.length <= tokenizer.MAX_SENTENCE_CHARS));
  assert.deepEqual(
    chunks.map((chunk) => chunk.index),
    chunks.map((_, index) => index)
  );
  assert.equal(chunks.map((chunk) => chunk.text).join(" "), source);
});

test("returns an empty queue for empty or non-string input", () => {
  assert.deepEqual(tokenizer.splitIntoChunks("   "), []);
  assert.deepEqual(tokenizer.splitIntoChunks(null), []);
});
