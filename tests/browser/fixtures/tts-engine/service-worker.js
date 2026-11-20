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

  if (typeof utterance === 'string' && utterance.length > 0) {
    sendTtsEvent({ type: 'sentence', charIndex: 0, length: utterance.length });
    const firstWord = utterance.match(/\S+/);
    if (firstWord) {
      sendTtsEvent({
        type: 'word',
        charIndex: firstWord.index || 0,
        length: firstWord[0].length
      });
    }
  }

  const timer = setTimeout(() => {
    activeTimers.delete(timer);
    sendTtsEvent({ type: 'end', charIndex: utterance.length });
    void record({ type: 'end', text: utterance });
  }, SPEECH_DURATION_MS);
  activeTimers.add(timer);
});

chrome.ttsEngine.onStop.addListener(() => {
  for (const timer of activeTimers) clearTimeout(timer);
  activeTimers.clear();
  void record({ type: 'stop' });
});
