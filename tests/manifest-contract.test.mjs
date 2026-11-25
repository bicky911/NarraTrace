import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = file => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const manifest = JSON.parse(await read('manifest.json'));
const readme = await read('README.md');
const privacy = await read('docs/PRIVACY-DATA-FLOW.md');
const runtimeSources = await Promise.all([
  'background.js',
  'content.js',
  'popup.js',
  'playback-manager.js',
  'speech-engine.js'
].map(read));
const runtime = runtimeSources.join('\n');

test('declared Chrome API permissions match the APIs actually used', () => {
  const declared = new Set(manifest.permissions);
  const apiPermissions = new Map([
    ['tts', /\bchrome\.tts\b/],
    ['storage', /\bchrome\.storage\b/],
    ['alarms', /\bchrome\.alarms\b/],
    ['contextMenus', /\bchrome\.contextMenus\b/]
  ]);

  for (const [permission, pattern] of apiPermissions) {
    assert.ok(declared.has(permission), `manifest must declare ${permission}`);
    assert.match(runtime, pattern, `runtime source should use ${permission}`);
  }

  assert.equal(declared.has('scripting'), false,
    'scripting is unnecessary until chrome.scripting is actually used');
  assert.equal(declared.has('activeTab'), false,
    'activeTab is unnecessary while all-page content scripts provide the required host access');
  assert.doesNotMatch(runtime, /\bchrome\.scripting\b/);
  assert.doesNotMatch(runtime, /\bchrome\.permissions\.request\b/);
});

test('broad content-script access is explicit and documented', () => {
  assert.ok(
    manifest.content_scripts.some(script => script.matches?.includes('<all_urls>')),
    'NarraTrace must inject on the supported web-page URL set'
  );
  assert.match(privacy, /content scripts on pages matching `<all_urls>`/i);
  assert.match(privacy, /broad website access/i);
});

test('privacy wording distinguishes NarraTrace from the selected TTS provider', () => {
  assert.match(readme, /network processing depends on that provider/i);
  assert.match(privacy, /selected TTS provider is a separate component/i);
  assert.match(privacy, /chrome\.storage\.session/);
  assert.match(privacy, /chrome\.storage\.local/);
  assert.doesNotMatch(readme, /Runs 100% locally/);
  assert.doesNotMatch(readme, /with local neural voices/);
});

test('minimum Chrome version covers the playback recovery APIs', () => {
  const minimumChromeVersion = Number(manifest.minimum_chrome_version);

  assert.ok(
    Number.isInteger(minimumChromeVersion) && minimumChromeVersion >= 120,
    'manifest must require Chrome 120+ for chrome.storage.session and 30-second alarms'
  );
  assert.match(readme, /Browser requirement:\*\* Chrome 120 or later/i);
  assert.match(runtime, /chrome\\.storage\\.session/);
  assert.match(runtime, /periodInMinutes:\\s*0\\.5/);
});
