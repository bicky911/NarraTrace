import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIR, '../..');
const ENGINE_DIR = path.join(TEST_DIR, 'fixtures', 'tts-engine');
const TEST_VOICE = 'NarraTrace Test Voice';
const FIRST_SENTENCE = 'First sentence survives a worker restart.';
const SECOND_SENTENCE = 'Second sentence must be reached after recovery.';

async function waitForNarraTraceWorker(browser, extensionId, previousTarget = null) {
  return browser.waitForTarget((target) =>
    target.type() === 'service_worker' &&
    target.url().startsWith(`chrome-extension://${extensionId}/`) &&
    target !== previousTarget
  , { timeout: 15000 });
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

async function send(page, message) {
  // The first GET_VOICES call can legitimately wait for Chrome to expose the
  // TTS namespace during a cold MV3 worker start. speech-engine.js allows up
  // to 10 seconds for that API, so the test must not cut the message off at 8.
  const timeoutMs = message.action === 'GET_VOICES' ? 15000 : 8000;
  return withTimeout(
    page.evaluate((payload) => window.narraTraceTest.send(payload), message),
    timeoutMs,
    `Extension message ${message.action}`
  );
}

async function readEngineEvents(browser, engineId) {
  const target = await browser.waitForTarget((candidate) =>
    candidate.type() === 'service_worker' &&
    candidate.url().startsWith(`chrome-extension://${engineId}/`)
  , { timeout: 10000 });
  const worker = await target.worker();
  return worker.evaluate(async () => {
    const stored = await chrome.storage.local.get('narraTraceTestEvents');
    return Array.isArray(stored.narraTraceTestEvents) ? stored.narraTraceTestEvents : [];
  });
}

async function waitForEngineEvent(browser, engineId, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastEvents = [];
  while (Date.now() < deadline) {
    lastEvents = await readEngineEvents(browser, engineId);
    if (predicate(lastEvents)) return lastEvents;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.fail(`Timed out waiting for test TTS event. Last events: ${JSON.stringify(lastEvents)}`);
}

async function waitForTestVoice(page, extensionId, voiceName, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastResponse = null;
  while (Date.now() < deadline) {
    lastResponse = await send(page, { action: 'GET_VOICES' });
    if (lastResponse?.success &&
        lastResponse.data?.allVoices?.some(voice =>
          voice.voiceName === voiceName && voice.extensionId === extensionId
        )) {
      return lastResponse;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.fail(
    `Chrome did not register the deterministic test voice in time. Last response: ${JSON.stringify(lastResponse)}`
  );
}

async function waitForPlaybackState(page, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastResponse = null;
  while (Date.now() < deadline) {
    lastResponse = await send(page, { action: 'GET_PLAYBACK_STATE' });
    if (lastResponse?.success && predicate(lastResponse.state)) return lastResponse.state;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.fail(`Timed out waiting for playback state. Last response: ${JSON.stringify(lastResponse)}`);
}

test('playback advances after the NarraTrace MV3 worker is forcibly terminated mid-utterance', {
  timeout: 60000
}, async (t) => {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      pipe: true,
      timeout: 20000,
      enableExtensions: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  } catch (error) {
    assert.fail(`Could not launch Chromium with the test extensions: ${error.message}`);
  }

  t.after(async () => {
    if (!browser) return;
    const process = browser.process();
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 5000))
    ]);
    // A wedged Chromium process must not hold the whole CI job open.
    if (process && process.exitCode === null) process.kill('SIGKILL');
  });

  console.log('[browser-test] Chromium launched with NarraTrace and the fixture TTS engine.');
  const narraTraceId = await browser.installExtension(REPOSITORY_ROOT);
  const testEngineId = await browser.installExtension(ENGINE_DIR);
  const extensions = await browser.extensions();
  const narraTrace = extensions.get(narraTraceId);
  const testEngine = extensions.get(testEngineId);
  console.log('[browser-test] Installed extensions:', [...extensions.values()].map((extension) =>
    `${extension.name} (${extension.id})`
  ).join(', '));
  assert.ok(narraTrace?.id, 'NarraTrace extension should be installed');
  assert.ok(testEngine?.id, 'deterministic TTS engine should be installed');
  console.log(`[browser-test] Extensions ready: NarraTrace=${narraTrace.id}, test-engine=${testEngine.id}.`);

  const driver = await browser.newPage();
  driver.setDefaultTimeout(10000);
  await driver.goto(`chrome-extension://${narraTrace.id}/tests/browser/driver.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 10000
  });
  const initialWorker = await waitForNarraTraceWorker(browser, narraTrace.id);

  const voices = await waitForTestVoice(driver, testEngine.id, TEST_VOICE);
  console.log(`[browser-test] Deterministic test voice registered (${voices.data.allVoices.length} voices enumerated).`);

  // Pin the fixture voice explicitly. PlaybackManager intentionally re-resolves
  // unpinned automatic preferences on start, so merely passing voiceName in
  // START_PLAYBACK options is not sufficient for a deterministic engine test.
  const voice = await send(driver, {
    action: 'SET_VOICE',
    voiceName: TEST_VOICE,
    extensionId: testEngine.id,
    lang: 'en-US'
  });
  assert.equal(voice?.success, true, 'the deterministic test voice should be pinned');

  const batch = await send(driver, { action: 'SET_BATCH_SIZE', size: 1 });
  assert.equal(batch?.success, true, 'single-sentence utterances should be enabled');

  const start = await send(driver, {
    action: 'START_PLAYBACK',
    sentences: [FIRST_SENTENCE, SECOND_SENTENCE],
    options: { voiceName: TEST_VOICE, extensionId: testEngine.id, lang: 'en-US' }
  });
  assert.equal(start?.success, true, 'NarraTrace should start the deterministic TTS session');
  console.log('[browser-test] Playback session started.');

  const firstSpeakEvents = await waitForEngineEvent(
    browser,
    testEngine.id,
    (events) => events.some((event) => event.type === 'speak' && event.text.includes('First sentence'))
  );
  assert.equal(
    firstSpeakEvents.filter((event) => event.type === 'speak' && event.text.includes('First sentence')).length,
    1,
    'first sentence should be submitted once before worker termination'
  );

  // Chrome's documented termination test uses Puppeteer's worker.close().
  console.log('[browser-test] First utterance reached the deterministic engine.');
  const worker = await initialWorker.worker();
  await worker.close();

  // A stopped MV3 worker starts again when the extension receives an event.
  // Send a benign state query to wake the extension before waiting for its
  // replacement service-worker target.
  const wakeResponse = await send(driver, { action: 'GET_PLAYBACK_STATE' });
  assert.equal(wakeResponse?.success, true, 'a runtime message should wake the terminated service worker');

  const restartedWorker = await waitForNarraTraceWorker(browser, narraTrace.id, initialWorker);
  assert.ok(restartedWorker, 'Chrome should start a fresh NarraTrace service worker');
  console.log('[browser-test] NarraTrace service worker restarted.');

  const recoveredEvents = await waitForEngineEvent(
    browser,
    testEngine.id,
    (events) => events.some((event) => event.type === 'speak' && event.text.includes('Second sentence')),
    25000
  );
  assert.equal(
    recoveredEvents.filter((event) => event.type === 'speak' && event.text.includes('Second sentence')).length,
    1,
    'the second sentence should be submitted exactly once'
  );

  console.log('[browser-test] Second sentence submitted after worker recovery.');
  const recoveredState = await waitForPlaybackState(
    driver,
    (state) => state.currentSentence?.text === SECOND_SENTENCE || state.playbackState === 'STOPPED',
    10000
  );
  assert.ok(
    recoveredState.currentSentence?.text === SECOND_SENTENCE || recoveredState.playbackState === 'STOPPED',
    'the restored queue should reach the second sentence or finish cleanly'
  );

  await send(driver, { action: 'STOP_PLAYBACK' });
});
