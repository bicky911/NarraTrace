import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIR, '../..');
const CONTENT_SOURCE = await readFile(path.join(REPOSITORY_ROOT, 'content.js'), 'utf8');
const TOKENIZER = path.join(REPOSITORY_ROOT, 'sentence-tokenizer.js');

function extractSource(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Expected production helper source: ${startMarker}`);
  return source.slice(start, end).trim();
}

const helpers = {
  getContentElements: extractSource(
    CONTENT_SOURCE,
    '  function getContentElements(container) {',
    '  /**\n   * Find the best set of article elements'
  ),
  textIndexAndRanges: extractSource(
    CONTENT_SOURCE,
    '  function buildTextIndex(element) {',
    '  /**\n   * Build a whitespace-normalised view of a DOM Range'
  )
};

test('profiles production extraction and DOM range mapping on a large article', {
  timeout: 45000
}, async (t) => {
  const browser = await puppeteer.launch({
    headless: true,
    pipe: true,
    timeout: 20000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-precise-memory-info']
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
  await page.addScriptTag({ path: TOKENIZER });
  const cdp = await page.createCDPSession();
  await cdp.send('Performance.enable');
  const beforeMetrics = await cdp.send('Performance.getMetrics');

  const profile = await page.evaluate((functions) => {
    const blockCount = 1200;
    const paragraphs = Array.from({ length: blockCount }, (_, index) => {
      const a = `Observation ${index + 1} recorded soil moisture across the northern experimental plots during the morning survey.`;
      const b = `Technicians calibrated each sensor before collecting the next measurement at the monitoring station.`;
      return `<p>${a} ${b}</p>`;
    }).join('');

    document.body.innerHTML =
      '<main><article><h1>Annual watershed monitoring baseline</h1>' +
      paragraphs +
      '</article><aside><p>Sponsored monitoring equipment and related products.</p></aside></main>';

    const host = document.createElement('div');
    const getContentElements = new Function('host', 'window',
      functions.getContentElements + '\nreturn getContentElements;'
    )(host, window);
    const findRangesInElement = new Function('document', 'NodeFilter',
      functions.textIndexAndRanges + '\nreturn findRangesInElement;'
    )(document, NodeFilter);

    const selectionStarted = performance.now();
    const blocks = getContentElements(document.body);
    const selectionMs = performance.now() - selectionStarted;

    const mappingStarted = performance.now();
    let sentenceCount = 0;
    let rangeCount = 0;
    let totalTextChars = 0;
    let firstRangeText = null;
    let lastRangeText = null;

    for (const block of blocks) {
      const text = block.textContent.trim();
      totalTextChars += text.length;
      const sentences = window.ReadAloudTokenizer.splitIntoSentences(text);
      const ranges = findRangesInElement(block, sentences.map(item => item.text));
      sentenceCount += sentences.length;
      rangeCount += ranges.length;

      if (!firstRangeText && ranges.length > 0) {
        firstRangeText = window.ReadAloudTokenizer.normalizeWhitespace(ranges[0].range.toString());
      }
      if (ranges.length > 0) {
        lastRangeText = window.ReadAloudTokenizer.normalizeWhitespace(ranges[ranges.length - 1].range.toString());
      }
    }
    const mappingMs = performance.now() - mappingStarted;

    return {
      expectedParagraphs: blockCount,
      selectedBlocks: blocks.length,
      sentenceCount,
      rangeCount,
      totalTextChars,
      selectionMs,
      mappingMs,
      totalMs: selectionMs + mappingMs,
      firstRangeText,
      lastRangeText,
      excludedSidebar: !blocks.some(block => block.textContent.includes('Sponsored monitoring equipment'))
    };
  }, helpers);

  const afterMetrics = await cdp.send('Performance.getMetrics');
  const metricValue = (metrics, name) =>
    metrics.metrics.find(metric => metric.name === name)?.value ?? null;
  const heapBefore = metricValue(beforeMetrics, 'JSHeapUsedSize');
  const heapAfter = metricValue(afterMetrics, 'JSHeapUsedSize');
  const scriptBefore = metricValue(beforeMetrics, 'ScriptDuration');
  const scriptAfter = metricValue(afterMetrics, 'ScriptDuration');

  const report = {
    ...profile,
    rendererHeapDeltaMB: heapBefore !== null && heapAfter !== null
      ? Number(((heapAfter - heapBefore) / (1024 * 1024)).toFixed(2))
      : null,
    rendererScriptDurationDeltaMs: scriptBefore !== null && scriptAfter !== null
      ? Number(((scriptAfter - scriptBefore) * 1000).toFixed(2))
      : null
  };
  console.log('[NarraTrace performance baseline]', JSON.stringify(report));

  assert.equal(profile.selectedBlocks, profile.expectedParagraphs + 1,
    'all article paragraphs and the title should be selected');
  assert.equal(profile.sentenceCount, profile.rangeCount,
    'every tokenized sentence should map to one DOM range');
  assert.ok(profile.sentenceCount >= 2400);
  assert.ok(profile.totalTextChars > 150000);
  assert.equal(profile.excludedSidebar, true);
  assert.ok(profile.firstRangeText?.startsWith('Annual watershed'));
  assert.ok(profile.lastRangeText?.includes('monitoring station'));
});
