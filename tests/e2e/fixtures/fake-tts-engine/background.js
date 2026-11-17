// Deterministic, silent Chrome TTS engine for end-to-end testing.
// This is a separate test-only extension; it is never included in NarraTrace.
let activeRun = 0;
let activeTimer = null;

globalThis.__NARRATRACE_TEST_METRICS = {
  speakCount: 0,
  wordCount: 0,
  stopCount: 0,
  lastUtterance: '',
  lastOptions: null,
  lastError: null
};

chrome.ttsEngine.onSpeak.addListener((utterance, options, sendTtsEvent) => {
  globalThis.__NARRATRACE_TEST_METRICS.speakCount += 1;
  globalThis.__NARRATRACE_TEST_METRICS.lastUtterance = utterance;
  globalThis.__NARRATRACE_TEST_METRICS.lastOptions = {
    voiceName: options.voiceName || null,
    extensionId: options.extensionId || null,
    lang: options.lang || null
  };
  activeRun += 1;
  const runId = activeRun;
  if (activeTimer !== null) clearTimeout(activeTimer);
  activeTimer = null;

  try {
    sendTtsEvent({ type: 'start', charIndex: 0 });
  } catch (error) {
    globalThis.__NARRATRACE_TEST_METRICS.lastError = String(error?.message || error);
    throw error;
  }

  const words = Array.from(utterance.matchAll(/\S+/gu));
  let cursor = 0;

  const emitNext = () => {
    if (runId !== activeRun) return;

    if (cursor >= words.length) {
      sendTtsEvent({ type: 'end', charIndex: utterance.length });
      activeTimer = null;
      return;
    }

    const match = words[cursor++];
    globalThis.__NARRATRACE_TEST_METRICS.wordCount += 1;
    try {
      sendTtsEvent({
        type: 'word',
        charIndex: match.index,
        length: match[0].length
      });
    } catch (error) {
      globalThis.__NARRATRACE_TEST_METRICS.lastError = String(error?.message || error);
      throw error;
    }

    const delay = Number.isFinite(globalThis.__NARRATRACE_TEST_DELAY_MS)
      ? Math.max(5, Math.min(1000, globalThis.__NARRATRACE_TEST_DELAY_MS))
      : 70;
    activeTimer = setTimeout(emitNext, delay);
  };

  emitNext();
});

chrome.ttsEngine.onStop.addListener(() => {
  globalThis.__NARRATRACE_TEST_METRICS.stopCount += 1;
  activeRun += 1;
  if (activeTimer !== null) clearTimeout(activeTimer);
  activeTimer = null;
});
