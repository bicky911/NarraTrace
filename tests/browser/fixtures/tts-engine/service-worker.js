const SPEECH_DURATION_MS = 4500;
const activeTimers = new Set();

async function record(event) {
  try {
    const stored = await chrome.storage.local.get('narraTraceTestEvents');
    const events = Array.isArray(stored.narraTraceTestEvents)
      ? stored.narraTraceTestEvents
      : [];
    events.push({ ...event, at: Date.now() });
    await chrome.storage.local.set({ narraTraceTestEvents: events });
  } catch (_) {
    // Test telemetry must never disrupt the TTS callback contract.
  }
}

chrome.ttsEngine.onSpeak.addListener((utterance, options, sendTtsEvent) => {
  void record({ type: 'speak', text: utterance });
  sendTtsEvent({ type: 'start', charIndex: 0 });
  let wordEventsSent = 0;

  if (typeof utterance === 'string' && utterance.length > 0) {
    sendTtsEvent({ type: 'sentence', charIndex: 0, length: utterance.length });
    const words = [...utterance.matchAll(/\S+/g)];
    if (words.length > 0) {
      sendTtsEvent({
        type: 'word',
        charIndex: words[0].index || 0,
        length: words[0][0].length
      });
      wordEventsSent++;

      // Emit deterministic word-boundary events throughout the utterance so
      // renderer profiling includes actual highlight updates, not only start/end.
      let nextWord = 1;
      const wordTimer = setInterval(() => {
        if (nextWord >= words.length) {
          clearInterval(wordTimer);
          activeTimers.delete(wordTimer);
          return;
        }
        const word = words[nextWord++];
        sendTtsEvent({
          type: 'word',
          charIndex: word.index || 0,
          length: word[0].length
        });
        wordEventsSent++;
      }, Math.max(75, SPEECH_DURATION_MS / Math.max(words.length, 1)));
      activeTimers.add(wordTimer);
    }
  }

  const timer = setTimeout(() => {
    activeTimers.delete(timer);
    sendTtsEvent({ type: 'end', charIndex: utterance.length });
    void record({ type: 'end', text: utterance, wordEventsSent });
  }, SPEECH_DURATION_MS);
  activeTimers.add(timer);
});

chrome.ttsEngine.onStop.addListener(() => {
  for (const timer of activeTimers) clearTimeout(timer);
  activeTimers.clear();
  void record({ type: 'stop' });
});
