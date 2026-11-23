import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIR, '../..');
const ENGINE_DIR = path.join(TEST_DIR, 'fixtures', 'tts-engine');
const TEST_VOICE = 'NarraTrace Test Voice';

function articleHtml(paragraphCount = 240) {
  const paragraphs = Array.from({ length: paragraphCount }, (_, index) => (
    `<p>Observation ${index + 1} recorded soil moisture across the northern experimental plots during the morning survey. Technicians calibrated each sensor before collecting the next measurement at the monitoring station.</p>`
  )).join('');
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>NarraTrace runtime profile</title></head>
<body>
  <main><article>
    <h1>Annual watershed monitoring baseline across the northern experimental region during spring sampling</h1>
    <p>The following synthetic article is used to profile NarraTrace on a repeatable long document.</p>
    ${paragraphs}
  </article></main>
  <aside><p>Sponsored monitoring equipment and related products.</p></aside>
</body>
</html>`;
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function send(driver, message) {
  return withTimeout(
    driver.evaluate(payload => window.narraTraceTest.send(payload), message),
    8000,
    `Extension message ${message.action}`
  );
}

async function waitForTestVoice(driver, extensionId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await send(driver, { action: 'GET_VOICES' });
    if (last?.success && last.data?.allVoices?.some(voice =>
      voice.voiceName === TEST_VOICE && voice.extensionId === extensionId
    )) return last;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.fail(`Test TTS voice did not register: ${JSON.stringify(last)}`);
}

async function readEngineEvents(browser, engineId) {
  const target = await browser.waitForTarget(candidate =>
    candidate.type() === 'service_worker' &&
    candidate.url().startsWith(`chrome-extension://${engineId}/`)
  , { timeout: 10000 });
  const worker = await target.worker();
  return worker.evaluate(async () => {
    const stored = await chrome.storage.local.get('narraTraceTestEvents');
    return Array.isArray(stored.narraTraceTestEvents) ? stored.narraTraceTestEvents : [];
  });
}

async function waitForEngineSpeak(browser, engineId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let events = [];
  while (Date.now() < deadline) {
    const target = await browser.waitForTarget(candidate =>
      candidate.type() === 'service_worker' &&
      candidate.url().startsWith(`chrome-extension://${engineId}/`)
    , { timeout: 10000 });
    const worker = await target.worker();
    events = await worker.evaluate(async () => {
      const stored = await chrome.storage.local.get('narraTraceTestEvents');
      return Array.isArray(stored.narraTraceTestEvents) ? stored.narraTraceTestEvents : [];
    });
    if (events.some(event => event.type === 'speak')) return events;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.fail(`No deterministic TTS speak event. Events: ${JSON.stringify(events)}`);
}

function metric(metrics, name) {
  return metrics.metrics.find(item => item.name === name)?.value ?? null;
}

function delta(after, before, name) {
  const a = metric(after, name);
  const b = metric(before, name);
  return a === null || b === null ? null : Number(((a - b) * 1000).toFixed(2));
}

async function closeBrowser(browser) {
  if (!browser) return;
  const process = browser.process();
  await Promise.race([
    browser.close().catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 5000))
  ]);
  if (process && process.exitCode === null) process.kill('SIGKILL');
}

test('profiles real extension renderer idle versus active playback workload', {
  timeout: 60000
}, async (t) => {
  const html = articleHtml();
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      pipe: true,
      timeout: 20000,
      enableExtensions: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-precise-memory-info']
    });
  } catch (error) {
    await new Promise(resolve => server.close(resolve));
    assert.fail(`Could not launch Chromium: ${error.message}`);
  }

  t.after(async () => {
    await closeBrowser(browser);
    await new Promise(resolve => server.close(() => resolve()));
  });

  const narraTraceId = await browser.installExtension(REPOSITORY_ROOT);
  const engineId = await browser.installExtension(ENGINE_DIR);
  const driver = await browser.newPage();
  await driver.goto(`chrome-extension://${narraTraceId}/tests/browser/driver.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 10000
  });
  await waitForTestVoice(driver, engineId);

  const voice = await send(driver, {
    action: 'SET_VOICE',
    voiceName: TEST_VOICE,
    extensionId: engineId,
    lang: 'en-US'
  });
  assert.equal(voice?.success, true, 'the deterministic test voice should be pinned');
  const batch = await send(driver, { action: 'SET_BATCH_SIZE', size: 1 });
  assert.equal(batch?.success, true);

  // Keep this renderer benchmark short enough to observe its terminal event
  // inside the six-second playback window.
  const engineTarget = await browser.waitForTarget(candidate =>
    candidate.type() === 'service_worker' &&
    candidate.url().startsWith(`chrome-extension://${engineId}/`)
  , { timeout: 10000 });
  const engineWorker = await engineTarget.worker();
  await engineWorker.evaluate(() => {
    globalThis.__NARRATRACE_TEST_DELAY_MS = 4500;
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const cdp = await page.createCDPSession();
  await cdp.send('Performance.enable');
  await page.goto(`http://127.0.0.1:${address.port}/article`, {
    waitUntil: 'domcontentloaded',
    timeout: 10000
  });
  await page.waitForFunction(() => document.querySelectorAll('article p').length >= 200);
  await page.bringToFront();
  await new Promise(resolve => setTimeout(resolve, 1800));

  const idleStartedAt = Date.now();
  const idleBefore = await cdp.send('Performance.getMetrics');
  await new Promise(resolve => setTimeout(resolve, 4000));
  const idleAfter = await cdp.send('Performance.getMetrics');
  const idleElapsedMs = Date.now() - idleStartedAt;

  const trigger = await send(driver, { action: 'TRIGGER_READ_PAGE' });
  assert.equal(trigger?.success, true, 'the background worker should forward the read-page request to the active article tab');
  const speakEvents = await waitForEngineSpeak(browser, engineId, 20000);
  assert.ok(speakEvents.some(event => event.type === 'speak'));

  const playbackStartedAt = Date.now();
  const playbackBefore = await cdp.send('Performance.getMetrics');
  await new Promise(resolve => setTimeout(resolve, 6000));
  const playbackAfter = await cdp.send('Performance.getMetrics');
  const playbackElapsedMs = Date.now() - playbackStartedAt;

  const heapDelta = (after, before) => {
    const a = metric(after, 'JSHeapUsedSize');
    const b = metric(before, 'JSHeapUsedSize');
    return a === null || b === null ? null : Number(((a - b) / (1024 * 1024)).toFixed(2));
  };
  const report = {
    articleParagraphs: 240,
    idle: {
      elapsedMs: idleElapsedMs,
      rendererScriptMs: delta(idleAfter, idleBefore, 'ScriptDuration'),
      rendererTaskMs: delta(idleAfter, idleBefore, 'TaskDuration'),
      heapDeltaMB: heapDelta(idleAfter, idleBefore)
    },
    activePlayback: {
      elapsedMs: playbackElapsedMs,
      rendererScriptMs: delta(playbackAfter, playbackBefore, 'ScriptDuration'),
      rendererTaskMs: delta(playbackAfter, playbackBefore, 'TaskDuration'),
      heapDeltaMB: heapDelta(playbackAfter, playbackBefore)
    },
    testVoiceUtterancesObserved: 0,
    testVoiceWordBoundariesObserved: 0
  };
  const finalEngineEvents = await readEngineEvents(browser, engineId);
  report.testVoiceUtterancesObserved = finalEngineEvents.filter(event => event.type === 'speak').length;
  report.testVoiceWordBoundariesObserved = finalEngineEvents
    .filter(event => event.type === 'end')
    .reduce((count, event) => count + (event.wordEventsSent || 0), 0);
  console.log('[NarraTrace renderer idle/playback profile]', JSON.stringify(report));

  assert.ok(report.idle.rendererScriptMs !== null, 'Chromium should report idle ScriptDuration');
  assert.ok(report.idle.rendererTaskMs !== null, 'Chromium should report idle TaskDuration');
  assert.ok(report.activePlayback.rendererScriptMs !== null, 'Chromium should report playback ScriptDuration');
  assert.ok(report.activePlayback.rendererTaskMs !== null, 'Chromium should report playback TaskDuration');
  assert.ok(report.testVoiceUtterancesObserved >= 1);
  assert.ok(report.testVoiceWordBoundariesObserved >= 5,
    'the active profile should exercise multiple word-highlight updates');

  await send(driver, { action: 'STOP_PLAYBACK' });
});
