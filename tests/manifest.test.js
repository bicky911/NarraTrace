/**
 * Package integrity tests.
 *
 * These protect the promises the README makes — MV3, zero dependencies, no
 * remote code, minimal permissions — so a future change cannot quietly break
 * them. The deeper static analysis lives in tools/lint.js and is executed here
 * as one test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runLint, formatLintReport } from '../tools/lint.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(ROOT, file));

const manifest = JSON.parse(read('manifest.json'));
const pkg = JSON.parse(read('package.json'));

test('manifest is a valid Manifest V3 declaration', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.name.includes('NarraTrace'));
  assert.equal(manifest.background.type, 'module');
  assert.ok(Array.isArray(manifest.permissions));
  assert.ok(manifest.action.default_popup);
  assert.ok(manifest.minimum_chrome_version, 'declare the oldest supported Chrome');
  assert.ok(Number(manifest.minimum_chrome_version) >= 105,
    'the CSS Custom Highlight API needs Chrome 105+');
});

test('the version is identical in manifest, package.json and CHANGELOG', () => {
  assert.equal(pkg.version, manifest.version);
  assert.ok(read('CHANGELOG.md').includes(`## ${manifest.version} `));
});

test('every file the manifest references is present', () => {
  const files = new Set([
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon)
  ]);
  for (const entry of manifest.content_scripts) {
    for (const file of [...entry.js, ...(entry.css || [])]) files.add(file);
  }
  for (const file of files) {
    assert.ok(exists(file), `missing referenced file: ${file}`);
  }
});

test('permissions stay minimal: no scripting, no host_permissions', () => {
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'alarms', 'contextMenus', 'storage', 'tts']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.externally_connectable, undefined);
});

test('the content script loads its shared tokenizer before content.js', () => {
  const js = manifest.content_scripts[0].js;
  assert.ok(js.indexOf('sentence-tokenizer.js') < js.indexOf('content.js'));
  assert.ok(js.indexOf('readability.js') < js.indexOf('content.js'));
  assert.equal(manifest.content_scripts[0].run_at, 'document_idle');
});

test('the extension has no runtime dependencies and no build step', () => {
  assert.equal(pkg.dependencies, undefined, 'no runtime dependencies may be declared');
  assert.equal(pkg.devDependencies, undefined, 'the behavioural suite must run on Node built-ins alone');

  // Optional local tooling (jsdom for tools/dom-smoke.mjs) may create these on
  // disk, so the invariant is "not tracked by git", not "never present".
  let tracked = [];
  try {
    tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n');
  } catch (_) {
    tracked = [];
  }
  const forbidden = ['node_modules/', 'package-lock.json', 'webpack.config.js', 'vite.config.js', 'rollup.config.js'];
  for (const artifact of forbidden) {
    assert.equal(
      tracked.some((file) => file === artifact || file.startsWith(artifact)),
      false,
      `${artifact} must not be committed`
    );
  }
});

test('keyboard commands are namespaced and unique', () => {
  const commands = manifest.commands;
  const names = Object.keys(commands);
  assert.ok(names.length >= 4);
  assert.equal(new Set(names).size, names.length);
  for (const [name, command] of Object.entries(commands)) {
    assert.match(name, /^[a-z][a-z0-9-]*$/);
    assert.ok(command.description.startsWith('NarraTrace:'), `${name} description is branded`);
    assert.match(command.suggested_key.default, /^(Alt|Ctrl|MacCtrl)\+/);
  }
});

test('the package linter reports zero errors', () => {
  const report = runLint();
  assert.equal(
    report.errors.length,
    0,
    `lint errors:\n${formatLintReport(report)}`
  );
});

test('the README documents both test entry points', () => {
  const readme = read('README.md');
  assert.ok(readme.includes('npm test'), 'README must document the behavioural suite');
  assert.ok(readme.includes('npm run lint'), 'README must document the linter');
});
