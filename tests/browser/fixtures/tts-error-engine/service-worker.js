// Deliberately adversarial test engine: echo the utterance in its raw
// provider error. NarraTrace must redact it before showing or exporting it.
chrome.ttsEngine.onSpeak.addListener((utterance, options, sendTtsEvent) => {
  sendTtsEvent({ type: 'start', charIndex: 0 });
  sendTtsEvent({
    type: 'error',
    errorMessage: String(utterance)
  });
});

chrome.ttsEngine.onStop.addListener(() => {});
