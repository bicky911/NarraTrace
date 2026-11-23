import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function loadSpeechEngine(voices, options = {}) {
  const source = await readFile(new URL('../speech-engine.js', import.meta.url), 'utf8');
  const executable = source.replace(/\\bexport\\s+/g, '') + `
globalThis.__speechEngine = {
  PIPER_EXTENSION_ID,
  SUPERTONIC_EXTENSION_ID,
  TTS_ENGINES,
  getEngineSpec,
  detectAndSelectVoice,
  safeSpeak
};
`;

  const timers = new Map();
  const speakCalls = [];
  let nextTimerId = 0;
  let stopCalls = 0;
  const context = {
    chrome: {
      runtime: { lastError: null },
      tts: {
        speak(text, ttsOptions, callback) {
          speakCalls.push({ text, options: ttsOptions, callback });
          if (typeof options.onSpeak === 'function') options.onSpeak(text, ttsOptions, callback);
        },
        stop() {
          stopCalls++;
          if (typeof options.onStop === 'function') options.onStop();
        },
        getVoices(callback) {
          callback(voices);
        }
      }
    },
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    console
  };
  vm.runInNewContext(executable, context, { filename: 'speech-engine.js' });
  return {
    api: context.__speechEngine,
    timers,
    speakCalls,
    stopCallCount: () => stopCalls
  };
}

test('Piper is the first maintained profile and dynamic IDs retain canonical identity', async () => {
  const dynamicPiperId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const supertonicId = 'mdoplmghlkjcnegkdhocjbjcncocbdhk';
  const otherId = 'dddddddddddddddddddddddddddddddd';
  const voices = [
    { voiceName: 'Supertonic English', lang: 'en-US', extensionId: supertonicId },
    { voiceName: 'Third-party English', lang: 'en-US', extensionId: otherId },
    { voiceName: 'Piper Amber', lang: 'en-US', extensionId: dynamicPiperId },
    { voiceName: 'Windows English', lang: 'en-US' }
  ];
  const { api } = await loadSpeechEngine(voices);

  assert.deepEqual(
    Array.from(api.TTS_ENGINES, engine => engine.label),
    ['Piper', 'Supertonic']
  );

  const report = await api.detectAndSelectVoice();

  assert.equal(report.selectedVoice.voiceName, 'Piper Amber');
  assert.equal(report.selectedVoice.extensionId, dynamicPiperId);
  assert.equal(report.engineId, api.PIPER_EXTENSION_ID);
  assert.equal(report.engineBadge, 'PIPER');
  assert.equal(
    report.engines.map(engine => engine.id).join(','),
    [api.PIPER_EXTENSION_ID, supertonicId, otherId].join(',')
  );
  assert.equal(
    report.otherVoices.some(voice => voice.voiceName === 'Piper Amber'),
    false
  );
});

test('an explicitly pinned Supertonic voice stays selected when Piper is available', async () => {
  const piperId = 'ppnfahcipommelgaapjalhooaeeblmeg';
  const supertonicId = 'mdoplmghlkjcnegkdhocjbjcncocbdhk';
  const voices = [
    { voiceName: 'Piper Amber', lang: 'en-US', extensionId: piperId },
    { voiceName: 'Supertonic English', lang: 'en-US', extensionId: supertonicId }
  ];
  const { api } = await loadSpeechEngine(voices);

  const report = await api.detectAndSelectVoice({
    voiceName: 'Supertonic English',
    pinned: true
  });

  assert.equal(report.selectedVoice.voiceName, 'Supertonic English');
  assert.equal(report.selectedVoice.extensionId, supertonicId);
  assert.equal(report.engineId, supertonicId);
  assert.equal(report.engineBadge, 'SUPERTONIC');
});

test('unrecognized Chrome TTS providers remain selectable as generic engines', async () => {
  const otherId = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const { api } = await loadSpeechEngine([
    { voiceName: 'Independent TTS', lang: 'en-US', extensionId: otherId }
  ]);

  const report = await api.detectAndSelectVoice();

  assert.equal(report.selectedVoice.voiceName, 'Independent TTS');
  assert.equal(report.engineId, otherId);
  assert.equal(report.engineLabel, 'Other engine');
  assert.equal(report.engineBadge, 'OTHER');
});

test('watchdog stops a stalled utterance and ignores late provider events', async () => {
  const loaded = await loadSpeechEngine([]);
  const events = [];
  const pending = loaded.api.safeSpeak('A deliberately stalled utterance.', {}, event => events.push(event));

  assert.equal(loaded.speakCalls.length, 1);
  assert.equal(loaded.timers.size, 1, 'one preparation watchdog should be armed');
  const [timerId, timer] = [...loaded.timers.entries()][0];
  assert.ok(timer.delay >= 60000, 'preparation receives the long watchdog budget');

  timer.callback();
  const result = await pending;

  assert.equal(result.type, 'timeout');
  assert.equal(loaded.stopCallCount(), 1, 'the stalled Chrome TTS request must be stopped');
  assert.equal(loaded.timers.size, 0, 'settling clears the watchdog timer');

  const lateEvent = loaded.speakCalls[0].options.onEvent;
  lateEvent({ type: 'word', charIndex: 4, length: 5 });
  lateEvent({ type: 'end' });
  assert.deepEqual(events, [], 'late callbacks must not reach the playback manager');
  assert.equal(loaded.stopCallCount(), 1, 'late callbacks must not trigger additional cleanup');
});

test('a completed utterance clears its watchdog and ignores duplicate terminal events', async () => {
  const loaded = await loadSpeechEngine([]);
  const events = [];
  const pending = loaded.api.safeSpeak('A short utterance.', {}, event => events.push(event));
  const speak = loaded.speakCalls[0];

  speak.options.onEvent({ type: 'start' });
  speak.options.onEvent({ type: 'end' });
  const result = await pending;

  assert.equal(result.type, 'end');
  assert.equal(loaded.timers.size, 0);
  speak.options.onEvent({ type: 'word', charIndex: 0, length: 1 });
  assert.deepEqual(events.map(event => event.type), ['start']);
});
