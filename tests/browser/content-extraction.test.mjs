import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIR, '../..');
const FIXTURE = path.join(TEST_DIR, 'fixtures', 'articles', 'structured-article.html');
const CONTENT_SOURCE = await readFile(path.join(REPOSITORY_ROOT, 'content.js'), 'utf8');

function extractSource(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Expected production source markers: ${startMarker}`);
  return source.slice(start, end).trim();
}

const contentFunctions = {
  getContentElements: extractSource(
    CONTENT_SOURCE,
    '  function getContentElements(container) {',
    '  /**\\n   * Find the best set of article elements'
  ),
  cutAtReferences: extractSource(
    CONTENT_SOURCE,
    '  function cutAtReferences(elements) {',
    '  /**\\n   * Build the sentence queue'
  ),
  findRangesInElement: extractSource(
    CONTENT_SOURCE,
    '  function buildTextIndex(element) {',
    '  /**\\n   * Build a whitespace-normalised view of a DOM Range'
  ),
  createSubRangeFromSentence: extractSource(
    CONTENT_SOURCE,
    '  function buildRangeIndex(baseRange) {',
    '  function updateWordBoxPosition()'
  )
};

test('Readability extracts structured article content without site chrome', {
  timeout: 30000
}, async (t) => {
  const html = await readFile(FIXTURE, 'utf8');
  const browser = await puppeteer.launch({
    headless: true,
    pipe: true,
    timeout: 20000,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  t.after(async () => {
    const process = browser.process();
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 4000))
    ]);
    if (process && process.exitCode === null) process.kill('SIGKILL');
  });

  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ path: path.join(REPOSITORY_ROOT, 'readability.js') });
  await page.addScriptTag({ path: path.join(REPOSITORY_ROOT, 'sentence-tokenizer.js') });

  const result = await page.evaluate((functions) => {
    const parsed = new window.Readability(document.cloneNode(true), {
      charThreshold: 100,
      keepClasses: false
    }).parse();
    if (!parsed) return null;

    // Execute the exact production helper functions extracted from content.js
    // in this real DOM, with their closure dependencies supplied.
    const host = document.createElement('div');
    const getContentElements = new Function('host', 'window',
      functions.getContentElements + '\\nreturn getContentElements;'
    )(host, window);
    const cutAtReferences = new Function(
      functions.cutAtReferences + '\\nreturn cutAtReferences;'
    )();
    const findRangesInElement = new Function('document', 'NodeFilter',
      functions.findRangesInElement + '\\nreturn findRangesInElement;'
    )(document, NodeFilter);
    const createSubRangeFromSentence = new Function('document', 'NodeFilter',
      functions.createSubRangeFromSentence + '\\nreturn createSubRangeFromSentence;'
    )(document, NodeFilter);

    const selectedBlocks = getContentElements(document.body);
    const blocksBeforeReferences = selectedBlocks.map(el => ({
      tag: el.tagName.toLowerCase(),
      text: el.textContent.trim()
    }));
    const blocksAfterReferences = cutAtReferences(selectedBlocks).map(el => ({
      tag: el.tagName.toLowerCase(),
      text: el.textContent.trim()
    }));

    const paragraph = document.getElementById('mapped-paragraph');
    const sentences = window.ReadAloudTokenizer.splitIntoSentences(paragraph.textContent);
    const ranges = findRangesInElement(paragraph, sentences.map(item => item.text));
    const mappedSentences = ranges.map((item, index) => ({
      sentence: sentences[index]?.text || item.text,
      normalizedRangeText: window.ReadAloudTokenizer.normalizeWhitespace(item.range.toString()),
      range: item.range,
      text: item.text
    }));
    const firstSentence = mappedSentences[0];
    const wordOffset = firstSentence.sentence.indexOf('depths');
    const wordRange = createSubRangeFromSentence(firstSentence, wordOffset, 'depths'.length);

    return {
      title: parsed.title,
      byline: parsed.byline,
      textContent: parsed.textContent,
      queue: window.ReadAloudTokenizer.splitIntoChunks(parsed.textContent),
      length: parsed.length,
      blocksBeforeReferences,
      blocksAfterReferences,
      mappedSentences: mappedSentences.map(({ sentence, normalizedRangeText }) => ({ sentence, normalizedRangeText })),
      wordRangeText: wordRange ? window.ReadAloudTokenizer.normalizeWhitespace(wordRange.toString()) : null
    };
  }, contentFunctions);

  assert.ok(result, 'Readability should return a parsed article');
  assert.match(result.title, /Crop response under managed irrigation/i);
  assert.match(result.textContent, /Experimental design/);
  assert.match(result.textContent, /Full irrigation maintained soil moisture/);
  assert.match(result.textContent, /Figure 1: Soil moisture observations/);
  assert.match(result.textContent, /420 millimeters/);
  assert.match(result.textContent, /site-specific management/);
  assert.doesNotMatch(result.textContent, /Subscribe to our newsletter/);
  assert.doesNotMatch(result.textContent, /Recommended stories/);
  assert.doesNotMatch(result.textContent, /Related products/);
  assert.doesNotMatch(result.textContent, /Copyright 2025/);

  assert.ok(result.queue.length >= 8);
  assert.ok(result.queue.every(item => item.text.trim().length > 0));
  assert.ok(result.queue.every(item => item.text.length <= 400));
  assert.deepEqual(result.queue.map(item => item.index), result.queue.map((_, index) => index));
  assert.equal(result.length, result.textContent.length);

  assert.ok(result.blocksBeforeReferences.some(block => block.tag === 'h2' && block.text === 'References'),
    'short structural headings should survive content block selection');
  assert.ok(!result.blocksAfterReferences.some(block => block.text === 'References'),
    'reference cutoff should remove the references heading');
  assert.ok(!result.blocksAfterReferences.some(block => block.text.startsWith('Smith, A. and Jones')),
    'reference entries should not be queued after the references heading');

  assert.ok(result.mappedSentences.length >= 2, 'the multi-node paragraph should map every sentence to a DOM range');
  for (const mapped of result.mappedSentences) {
    assert.equal(mapped.normalizedRangeText, mapped.sentence,
      'each DOM range should map back to the complete normalized sentence');
  }
  assert.equal(result.wordRangeText, 'depths',
    'word-level subranges should remain accurate across inline elements and source newlines');
});
