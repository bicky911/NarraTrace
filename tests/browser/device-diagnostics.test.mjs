import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIR, '../..');
const ENGINE_DIR = path.join(TEST_DIR, 'fixtures', 'tts-engine');
const TEST_VOICE = 'NarraTrace Test Voice';
const SAMPLE = 'CONFIDENTIAL DIAGNOSTIC SAMPLE MUST NOT LEAK. Check Chrome TTS timing.';

async function closeBrowser(browser) {
  if (!browser) return;
  const process = browser.process();
  await Promise.race([
    browser.close().catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 5000))
  ]);
  if (process && process.exitCode === null) process.kill('SIGKILL');
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
  return withTimeout(
    page.evaluate((payload) => chrome.runtime.sendMessage(payload), message),
    10000,
    `Extension message ${message.action}`
  );
}

async function waitForState(page, expected, timeout = 12000) {
  await page.waitForFunction(async (state) => {
    const response = await chrome.runtime.sendMessage({ action: 'GET_PLAYBACK_STATE' });
    return response?.success && response.state?.playbackState === state;
  }, { timeout }, expected);
}

test('bundled diagnostics are isolated, verify audibility, and never export sample text', {
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
    assert.fail(`Could not launch Chromium for diagnostics checks: ${error.message}`);
  }

  t.after(async () => closeBrowser(browser));

  console.log('[diagnostics-test] Installing extensions');
  const narraTraceId = await browser.installExtension(REPOSITORY_ROOT);
  const testEngineId = await browser.installExtension(ENGINE_DIR);

  const diagnostics = await browser.newPage();
  await diagnostics.goto(`chrome-extension://${narraTraceId}/test.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 10000
  });
  await diagnostics.waitForSelector('#btn-run-engine-diagnostic', { timeout: 10000 });
  diagnostics.setDefaultTimeout(10000);
  diagnostics.on('console', message => console.log('[diagnostics-page]', message.text()));
  diagnostics.on('pageerror', error => console.log('[diagnostics-page-error]', error.message));
  console.log('[diagnostics-test] Diagnostics page loaded');

  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${narraTraceId}/popup.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 10000
  });

  // Only the bundled diagnostics page may inspect the session or start a
  // diagnostic utterance. The popup must be rejected at the background boundary.
  const deniedDiagnostic = await send(popup, {
    action: 'RUN_TTS_DIAGNOSTIC',
    requestId: 'popup-must-not-run',
    text: 'This should never be spoken.',
    voiceName: TEST_VOICE,
    extensionId: testEngineId,
    lang: 'en-US',
    rate: 1
  });
  console.log('[diagnostics-test] Popup diagnostic request rejected');
  assert.equal(deniedDiagnostic?.success, false);
  assert.match(deniedDiagnostic?.error || '', /restricted to the bundled diagnostics page/i);

  const deniedSessionInspection = await send(popup, { action: 'GET_SESSION_STORAGE' });
  console.log('[diagnostics-test] Popup session inspection rejected');
  assert.equal(deniedSessionInspection?.success, false);
  assert.match(deniedSessionInspection?.error || '', /restricted to the bundled diagnostics page/i);

  // Wait for the deterministic Chrome TTS provider to register, then select
  // the exact voice that the diagnostic will validate against getVoices().
  await diagnostics.waitForFunction((voiceName, extensionId) => {
    const select = document.getElementById('voice-select');
    return Array.from(select?.options || []).some(option =>
      option.value === voiceName && option.dataset.extensionId === extensionId
    );
  }, { timeout: 20000, polling: 100 }, TEST_VOICE, testEngineId);
  await diagnostics.select('#voice-select', TEST_VOICE);
  console.log('[diagnostics-test] Test voice selected');

  const selected = await diagnostics.$eval('#voice-select option:checked', option => ({
    voiceName: option.value,
    extensionId: option.dataset.extensionId || null,
    lang: option.dataset.lang || null
  }));
  assert.deepEqual(selected, {
    voiceName: TEST_VOICE,
    extensionId: testEngineId,
    lang: 'en-US'
  });

  // First prove that diagnostics refuses to interrupt a normal narration.
  const started = await send(diagnostics, {
    action: 'START_PLAYBACK',
    sentences: ['Normal playback owns the speech channel until it is stopped.']
  });
  assert.equal(started?.success, true);
  await waitForState(diagnostics, 'PLAYING');
  console.log('[diagnostics-test] Normal queue entered PLAYING');

  const blockedByQueue = await send(diagnostics, {
    action: 'RUN_TTS_DIAGNOSTIC',
    requestId: 'blocked-during-queue',
    text: SAMPLE,
    voiceName: selected.voiceName,
    extensionId: selected.extensionId,
    lang: selected.lang,
    rate: 1
  });
  console.log('[diagnostics-test] Diagnostic correctly blocked during normal playback');
  assert.equal(blockedByQueue?.success, false);
  assert.match(blockedByQueue?.error || '', /stop normal narratrace playback/i);

  await send(diagnostics, { action: 'STOP_PLAYBACK' });
  await waitForState(diagnostics, 'STOPPED');
  console.log('[diagnostics-test] Normal queue stopped');

  // Run the actual diagnostics page workflow. The CI provider is deliberately
  // silent, so the report must not claim an audible pass without user marking.
  await withTimeout(diagnostics.evaluate((value) => {
    const element = document.getElementById('diagnostic-sample-text');
    if (!element) throw new Error('Diagnostic sample textarea is missing.');
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, SAMPLE), 8000, 'Populate diagnostic sample');
  console.log('[diagnostics-test] Diagnostic sample populated');

  await withTimeout(diagnostics.evaluate(() => {
    const button = document.getElementById('btn-run-engine-diagnostic');
    if (!button || button.disabled) throw new Error('Run Audible Test button is unavailable.');
    button.click();
  }), 8000, 'Activate Run Audible Test');
  console.log('[diagnostics-test] Diagnostic start clicked');
  await diagnostics.waitForFunction(() =>
    document.getElementById('btn-stop-engine-diagnostic')?.disabled === false,
    { timeout: 15000, polling: 100 }
  );

  console.log('[diagnostics-test] Diagnostic request accepted by background');

  // A second diagnostic and normal queue playback must both be rejected while
  // the isolated utterance owns Chrome TTS.
  const overlappingDiagnostic = await send(diagnostics, {
    action: 'RUN_TTS_DIAGNOSTIC',
    requestId: 'second-diagnostic',
    text: 'A second utterance must be refused.',
    voiceName: selected.voiceName,
    extensionId: selected.extensionId,
    lang: selected.lang,
    rate: 1
  });
  console.log('[diagnostics-test] Concurrent diagnostic rejected');
  assert.equal(overlappingDiagnostic?.success, false);
  assert.match(overlappingDiagnostic?.error || '', /already running/i);

  const blockedNormalPlayback = await send(diagnostics, {
    action: 'START_PLAYBACK',
    sentences: ['Normal playback must not overlap diagnostic speech.']
  });
  console.log('[diagnostics-test] Normal queue blocked during diagnostic');
  assert.equal(blockedNormalPlayback?.success, false);
  assert.match(blockedNormalPlayback?.error || '', /diagnostic is active/i);

  // Wait for a terminal diagnostic state, then inspect the exact outcome.
  // This distinguishes clean completion from interruption or a missing event.
  await diagnostics.waitForFunction(() => {
    const run = document.getElementById('btn-run-engine-diagnostic');
    const stop = document.getElementById('btn-stop-engine-diagnostic');
    const exportButton = document.getElementById('btn-export-engine-diagnostic');
    return run?.disabled === false && stop?.disabled === true && exportButton?.disabled === false;
  }, { timeout: 15000, polling: 100 });
  console.log('[diagnostics-test] Diagnostic reached a terminal state');

  console.log('[diagnostics-test] Diagnostic completed without audible mark');
  const result = await diagnostics.evaluate(() => ({
    log: document.getElementById('engine-diagnostic-log')?.textContent || '',
    status: document.getElementById('engine-diagnostic-status')?.textContent || '',
    exportEnabled: !document.getElementById('btn-export-engine-diagnostic')?.disabled,
    // test.js is a classic page script with a top-level lexical binding;
    // expose only its completed, text-free report through the explicit
    // diagnostics state snapshot for deterministic browser verification.
    report: window.__NARRATRACE_DIAGNOSTIC_STATE?.report || null
  }));

  console.log('[diagnostics-test] Terminal report summary', JSON.stringify({
    status: result.status,
    resultType: result.report?.resultType,
    eventTypes: result.report?.events?.map(entry => entry.event?.type)
  }));
  assert.match(result.log, /start/i);
  assert.match(result.log, /word/i);
  assert.match(result.log, /end/i);
  assert.equal(result.report?.resultType, 'end', 'silent test provider should still deliver a clean TTS end event');
  assert.equal(result.log.includes(SAMPLE), false, 'event log must never include the diagnostic sample');
  assert.equal(result.exportEnabled, true, 'a completed diagnostic report should be exportable');
  assert.equal(result.report?.test?.sampleTextIncluded, false);
  assert.equal(JSON.stringify(result.report).includes(SAMPLE), false, 'the diagnostic report must not contain the spoken sample text');
  assert.equal(result.report?.test?.sampleCharacterCount, SAMPLE.length);
  assert.equal(result.report?.success, false, 'silent CI output must not be reported as an audible pass');
  assert.equal(result.report?.test?.audibleStartMarkedMs, null, 'the test must not invent a human audible mark');
  console.log('[diagnostics-test] Report privacy and audibility assertions passed');

  // Adversarial failure case: a provider error deliberately echoes the sample.
  // The exported report and event log must still remain text-free.
  const engineTarget = await browser.waitForTarget(candidate =>
    candidate.type() === 'service_worker' &&
    candidate.url().startsWith(`chrome-extension://${testEngineId}/`)
  , { timeout: 10000 });
  const engineWorker = await engineTarget.worker();
  await engineWorker.evaluate(() => {
    globalThis.__NARRATRACE_TEST_ECHO_ERROR = true;
  });

  const ERROR_SAMPLE = 'PRIVATE-ERROR-ECHO-SAMPLE-DO-NOT-EXPORT';
  await withTimeout(diagnostics.evaluate((value) => {
    const element = document.getElementById('diagnostic-sample-text');
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-run-engine-diagnostic').click();
  }, ERROR_SAMPLE), 8000, 'Start provider error privacy test');

  await diagnostics.waitForFunction(() => {
    const run = document.getElementById('btn-run-engine-diagnostic');
    const stop = document.getElementById('btn-stop-engine-diagnostic');
    const exportButton = document.getElementById('btn-export-engine-diagnostic');
    return run?.disabled === false && stop?.disabled === true && exportButton?.disabled === false;
  }, { timeout: 15000, polling: 100 });

  const errorResult = await diagnostics.evaluate(() => ({
    log: document.getElementById('engine-diagnostic-log')?.textContent || '',
    report: window.__NARRATRACE_DIAGNOSTIC_STATE?.report || null
  }));
  assert.equal(errorResult.report?.resultType, 'error');
  assert.equal(errorResult.report?.error, 'The selected TTS provider could not complete the diagnostic request.');
  assert.ok(errorResult.report?.events?.some(entry =>
    entry.event?.errorMessage === 'The selected TTS provider returned an error.'
  ));
  assert.equal(errorResult.log.includes(ERROR_SAMPLE), false);
  assert.equal(JSON.stringify(errorResult.report).includes(ERROR_SAMPLE), false);
  console.log('[diagnostics-test] Provider error text was redacted from report');
});
