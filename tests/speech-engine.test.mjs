import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function loadSpeechEngine(voices) {
  const source = await readFile(new URL('../speech-engine.js', import.meta.url), 'utf8');
  const executable = source.replace(/\bexport\s+/g, '') + `
globalThis.__speechEngine = {
  PIPER_EXTENSION_ID,
  SUPERTONIC_EXTENSION_ID,
  TTS_ENGINES,
  getEngineSpec,
  detectAndSelectVoice
};
`;
  const context = {
    chrome: {
      runtime: { lastError: null },
      tts: {
        speak() {},
        getVoices(callback) {
          callback(voices);
        }
      }
    },
    console
  };
  vm.runInNewContext(executable, context, { filename: 'speech-engine.js' });
  return context.__speechEngine;
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
  const api = await loadSpeechEngine(voices);

  assert.equal(
    api.TTS_ENGINES.map(engine => engine.label).join(','),
    'Piper,Supertonic'
  );
  assert.equal(api.TTS_ENGINES.some(engine => /kokoro/i.test(engine.label)), false);

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
  const api = await loadSpeechEngine(voices);

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
  const api = await loadSpeechEngine([
    { voiceName: 'Independent TTS', lang: 'en-US', extensionId: otherId }
  ]);

  const report = await api.detectAndSelectVoice();

  assert.equal(report.selectedVoice.voiceName, 'Independent TTS');
  assert.equal(report.engineId, otherId);
  assert.equal(report.engineLabel, 'Other engine');
  assert.equal(report.engineBadge, 'OTHER');
});
