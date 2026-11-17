/**
 * Speech engine tests.
 *
 * These cover the failure modes that are invisible in a static scan but very
 * audible in use: an abandoned utterance that keeps talking over the
 * continuation, events arriving after an utterance is over, and a TTS
 * namespace that has disappeared with the extension context.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createChromeMock, DEFAULT_VOICES } from './helpers/chrome-mock.js';

const mock = createChromeMock({ autoSpeak: false });
globalThis.chrome = mock.chrome;

const {
  safeSpeak,
  stopSpeech,
  stopSpeechAndWait,
  isSpeaking,
  detectScript,
  findBestVoiceForLang,
  detectAndSelectVoice,
  getEngineSpec,
  waitForTtsApi
} = await import('../speech-engine.js');

/**
 * Capture timers so a test can fire the engine watchdog (45–60 s) instantly
 * without waiting or mocking Node's clock globally for the whole file.
 */
function captureTimers(run) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (callback, ms) => {
    const timer = { callback, ms, cleared: false };
    timers.push(timer);
    return timers.length;
  };
  globalThis.clearTimeout = (id) => {
    const timer = timers[id - 1];
    if (timer) timer.cleared = true;
  };
  try {
    return run(timers);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

const activeTimers = (timers) => timers.filter((t) => !t.cleared);

test.beforeEach(() => mock.reset());

test('safeSpeak resolves on the engine end event', async () => {
  const events = [];
  const promise = safeSpeak('Hello world.', { voiceName: 'Kokoro Heart' }, (e) => events.push(e.type));
  mock.emit({ type: 'start', charIndex: 0 });
  mock.emit({ type: 'sentence', charIndex: 0 });
  mock.emit({ type: 'end', charIndex: 12 });

  const result = await promise;
  assert.equal(result.type, 'end');
  assert.deepEqual(events, ['start', 'sentence', 'end']);
});

test('safeSpeak resolves on interruption and cancellation', async () => {
  const interrupted = safeSpeak('Interrupted text.', {});
  mock.emit({ type: 'cancelled', charIndex: 0 });
  assert.equal((await interrupted).type, 'cancelled');

  const cancelled = safeSpeak('Second utterance.', {});
  mock.emit({ type: 'interrupted', charIndex: 0 });
  assert.equal((await cancelled).type, 'interrupted');
});

test('safeSpeak rejects on an engine error event', async () => {
  const promise = safeSpeak('Broken utterance.', {});
  mock.emit({ type: 'error', errorMessage: 'voice unavailable' });
  await assert.rejects(promise, /voice unavailable/);
});

test('safeSpeak rejects when chrome.tts.speak reports lastError', async () => {
  mock.failSpeaks = true;
  await assert.rejects(safeSpeak('Will not start.', {}), /refused the utterance/);
});

test('safeSpeak rejects when chrome.tts.speak throws synchronously', async () => {
  const original = chrome.tts.speak;
  chrome.tts.speak = () => { throw new Error('tts namespace gone'); };
  try {
    await captureTimers(async (timers) => {
      await assert.rejects(safeSpeak('Throwing utterance.', {}), /tts namespace gone/);
      assert.equal(activeTimers(timers).length, 0, 'watchdog must be cleared on the throw path');
    });
  } finally {
    chrome.tts.speak = original;
  }
});

test('events emitted after the utterance ended are ignored', async () => {
  const seen = [];
  const promise = safeSpeak('Already finished.', {}, (e) => seen.push(e.type));
  const utterance = mock.speaks.at(-1);
  mock.emit({ type: 'end', charIndex: 16 });
  await promise;

  // The engine can still trickle boundaries for a moment; they must not reach
  // the playback manager, which has already moved on to the next utterance.
  assert.doesNotThrow(() => utterance.options.onEvent({ type: 'word', charIndex: 3 }));
  assert.deepEqual(seen, ['end']);
});

test('watchdog stops the engine before resolving, so audio cannot overlap', async () => {
  mock.autoSpeak = false;
  const outcome = await captureTimers(async (timers) => {
    const promise = safeSpeak('A very long utterance.', {});
    const prepareTimer = timers.find((t) => t.ms >= 60000);
    assert.ok(prepareTimer, 'a preparation watchdog must be armed');
    prepareTimer.callback();
    return promise;
  });

  assert.equal(outcome.type, 'timeout');
  assert.equal(outcome.stopped, true);
  assert.equal(mock.stops, 1, 'chrome.tts.stop() must be called on timeout');
});

test('empty text resolves without touching the engine', async () => {
  const result = await safeSpeak('   ', {});
  assert.equal(result.type, 'empty');
  assert.equal(mock.speaks.length, 0);
});

test('optional speak options are only forwarded when they hold real values', async () => {
  const promise = safeSpeak('Options check.', {
    voiceName: '  ',
    extensionId: '',
    lang: null,
    rate: 1.25,
    pitch: Number.NaN
  });
  const utterance = mock.speaks.at(-1);
  assert.equal(utterance.options.rate, 1.25);
  assert.equal(utterance.options.pitch, 1.0, 'NaN pitch falls back to 1.0');
  assert.equal('voiceName' in utterance.options, false);
  assert.equal('extensionId' in utterance.options, false);
  assert.equal('lang' in utterance.options, false);

  mock.emit({ type: 'end', charIndex: 14 });
  await promise;
});

test('stop / isSpeaking survive a missing chrome.tts namespace', async () => {
  const original = chrome.tts;
  delete chrome.tts;
  try {
    assert.doesNotThrow(() => stopSpeech());
    await assert.doesNotReject(stopSpeechAndWait(50));
    assert.equal(await isSpeaking(), false);
    assert.equal(await waitForTtsApi(10), false);
  } finally {
    chrome.tts = original;
  }
});

test('detectScript requires a real share of the text, not one stray character', () => {
  assert.equal(detectScript('Hello world, this is English.'), 'en');
  assert.equal(detectScript('আমি বাংলায় লিখি'), 'bn');
  assert.equal(detectScript('यह हिन्दी है'), 'hi');
  assert.equal(
    detectScript('The Bengali word for water is পানি in this example sentence.'),
    'en',
    'one quoted foreign word must not route the whole sentence to a native voice'
  );
  assert.equal(detectScript('আমি Bengali এবং English মিশ্রিত করি এখানে'), 'bn');
  assert.equal(detectScript(''), 'en');
  assert.equal(detectScript(null), 'en');
});

test('findBestVoiceForLang prefers a language match, then a known voice name', () => {
  const voices = [
    { voiceName: 'Microsoft David', lang: 'en-US' },
    { voiceName: 'Microsoft Hemant', lang: 'hi-IN' },
    { voiceName: 'Bangla Natural', lang: 'bn-BD' }
  ];
  assert.equal(findBestVoiceForLang(voices, 'bn').voiceName, 'Bangla Natural');
  assert.equal(findBestVoiceForLang(voices, 'hi').voiceName, 'Microsoft Hemant');
  const fallback = voices[0];
  assert.equal(findBestVoiceForLang(voices, 'en', fallback), fallback);
  assert.equal(findBestVoiceForLang([], 'bn', fallback), fallback);
});

test('voice resolution prefers the highest-priority engine and its default voice', async () => {
  const report = await detectAndSelectVoice({ voiceName: null, pinned: false });
  assert.equal(report.selectedVoice.voiceName, 'Kokoro Heart');
  assert.equal(report.engineLabel, 'Kokoro');
  assert.equal(report.engines.length, 1);
  assert.ok(report.engineVoices.length >= 2);
});

test('a pinned voice always wins over engine priority', async () => {
  const report = await detectAndSelectVoice({
    voiceName: 'Microsoft David - English (United States)',
    pinned: true
  });
  assert.equal(report.selectedVoice.voiceName, 'Microsoft David - English (United States)');
  assert.equal(report.engineLabel, 'System');
});

test('with no engine extension installed the system voice is used', async () => {
  mock.voices = DEFAULT_VOICES.filter((v) => !v.extensionId);
  try {
    const report = await detectAndSelectVoice({ voiceName: null, pinned: false });
    assert.match(report.selectedVoice.lang, /^en/);
    assert.match(report.statusMessage, /No TTS engine extension found/i);
    assert.equal(report.engineBadge, 'SYSTEM');
  } finally {
    mock.voices = structuredClone(DEFAULT_VOICES);
  }
});

test('engine specs are resolved by id and by Piper voice name', () => {
  assert.equal(getEngineSpec('mefecoigjodlohjacogkbbfpnifhfocb').label, 'Kokoro');
  assert.equal(getEngineSpec(null, { voiceName: 'Piper Amy' }).label, 'Piper');
  assert.equal(getEngineSpec('unknown-id'), null);
});
