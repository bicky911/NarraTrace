import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIR, '../..');
const FIXTURE = path.join(TEST_DIR, 'fixtures', 'articles', 'structured-article.html');

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

  const result = await page.evaluate(() => {
    const parsed = new window.Readability(document.cloneNode(true), {
      charThreshold: 100,
      keepClasses: false
    }).parse();
    if (!parsed) return null;
    return {
      title: parsed.title,
      byline: parsed.byline,
      textContent: parsed.textContent,
      queue: window.ReadAloudTokenizer.splitIntoChunks(parsed.textContent),
      length: parsed.length
    };
  });

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
});
