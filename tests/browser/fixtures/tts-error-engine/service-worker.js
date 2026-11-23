// Deliberately adversarial test engine: echo the utterance in its raw
// provider error. NarraTrace must redact it before showing or exporting it.
chrome.ttsEngine.onSpeak.addListener((utterance, options, sendTtsEvent) => {
  console.info('[NarraTrace echo-error fixture] onSpeak invoked');
  sendTtsEvent({ type: 'start', charIndex: 0 });
  console.info('[NarraTrace echo-error fixture] start event sent');
  sendTtsEvent({
    type: 'error',
    errorMessage: String(utterance)
  });
  console.info('[NarraTrace echo-error fixture] error event sent');
});

chrome.ttsEngine.onStop.addListener(() => {});
