// Deterministic, silent Chrome TTS engine for end-to-end testing.
// This is a separate test-only extension; it is never included in NarraTrace.
let activeRun = 0;
let activeTimer = null;

chrome.ttsEngine.onSpeak.addListener((utterance, options, sendTtsEvent) => {
  activeRun += 1;
  const runId = activeRun;
  if (activeTimer !== null) clearTimeout(activeTimer);
  activeTimer = null;

  sendTtsEvent({ type: 'start', charIndex: 0 });

  const words = Array.from(utterance.matchAll(/\\S+/gu));
  let cursor = 0;

  const emitNext = () => {
    if (runId !== activeRun) return;

    if (cursor >= words.length) {
      sendTtsEvent({ type: 'end', charIndex: utterance.length });
      activeTimer = null;
      return;
    }

    const match = words[cursor++];
    sendTtsEvent({
      type: 'word',
      charIndex: match.index,
      length: match[0].length
    });

    const delay = Number.isFinite(globalThis.__NARRATRACE_TEST_DELAY_MS)
      ? Math.max(5, Math.min(1000, globalThis.__NARRATRACE_TEST_DELAY_MS))
      : 70;
    activeTimer = setTimeout(emitNext, delay);
  };

  emitNext();
});

chrome.ttsEngine.onStop.addListener(() => {
  activeRun += 1;
  if (activeTimer !== null) clearTimeout(activeTimer);
  activeTimer = null;
});
