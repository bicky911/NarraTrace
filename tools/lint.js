#!/usr/bin/env node
/**
 * NarraTrace static integrity checks — zero dependencies.
 *
 * `test-harness.py` proves that specific implementation details are present;
 * this tool proves the package is *coherent*: the manifest points at files
 * that exist, every permission is actually used, the content script obeys its
 * narrow API allowlist, no forbidden speech/browser API slipped in, and every
 * runtime message that is sent has a handler on the other side.
 *
 * Run: npm run lint  (or: node tools/lint.js)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PRODUCTION_JS = [
  'background.js',
  'content.js',
  'speech-engine.js',
  'playback-manager.js',
  'sentence-tokenizer.js',
  'popup.js'
];

// Namespaces each permission unlocks, used to detect permissions that are
// declared but never exercised (every unused permission is a needless warning
// on the install screen).
const PERMISSION_NAMESPACES = {
  tts: ['tts'],
  storage: ['storage'],
  alarms: ['alarms'],
  contextMenus: ['contextMenus'],
  scripting: ['scripting']
  // "tabs" is deliberately absent: sendMessage/get/getZoom/query do not
  // require it, and the popup gets url/title through activeTab instead.
};

const DANGEROUS_PERMISSIONS = new Set([
  'debugger',
  'management',
  'nativeMessaging',
  'proxy',
  'webRequest',
  'webRequestBlocking',
  'desktopCapture',
  'pageCapture',
  'tabCapture',
  'offscreen',
  'identity',
  'browsingData',
  'history',
  'downloads'
]);

// The content script runs inside arbitrary web pages. It may only talk to the
// extension's own messaging and storage; anything else belongs in the worker.
const CONTENT_SCRIPT_ALLOWED_NAMESPACES = new Set(['runtime', 'storage']);

const FORBIDDEN_PATTERNS = [
  { re: /\bwebkitSpeechSynthesis\b/, why: 'use chrome.tts only (manifest rule)' },
  { re: /\bSpeechSynthesisUtterance\b/, why: 'use chrome.tts only (manifest rule)' },
  { re: /\bspeechSynthesis\s*\./, why: 'use chrome.tts only (manifest rule)' },
  { re: /\bnew\s+Function\s*\(/, why: 'remote/dynamic code generation is not allowed in MV3' },
  { re: /(^|[^.\w])eval\s*\(/, why: 'remote/dynamic code generation is not allowed in MV3' },
  { re: /document\.write\s*\(/, why: 'document.write destroys the host page' },
  { re: /chrome\.scripting\.executeScript/, why: 'the extension injects its content script declaratively' }
];

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function exists(file) {
  return fs.existsSync(path.join(ROOT, file));
}

/**
 * Remove comments before scanning for API usage. The production code is
 * heavily commented — deliberately, so the "why" survives — and those
 * comments mention chrome.tts / chrome.tabs by name. Scanning raw source
 * therefore reported APIs the content script never calls.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

function matchAll(source, re) {
  return [...source.matchAll(re)].map((m) => m[1]);
}

export function runLint() {
  const errors = [];
  const warnings = [];
  const checks = [];
  const error = (check, detail) => errors.push({ check, detail });
  const warn = (check, detail) => warnings.push({ check, detail });
  const pass = (check) => checks.push(check);

  // ── Source parses ────────────────────────────────────────────────────
  for (const file of PRODUCTION_JS) {
    if (!exists(file)) {
      error('source-files', `${file} is missing`);
      continue;
    }
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' });
    } catch (err) {
      error('syntax', `${file} failed to parse: ${String(err.stderr || err.message).trim()}`);
    }
  }
  pass('all production scripts parse');

  // ── Manifest integrity ───────────────────────────────────────────────
  let manifest;
  try {
    manifest = JSON.parse(read('manifest.json'));
  } catch (err) {
    error('manifest', `manifest.json is not valid JSON: ${err.message}`);
    return { errors, warnings, checks };
  }

  if (manifest.manifest_version !== 3) error('manifest', 'manifest_version must be 3');
  else pass('manifest is V3');

  for (const field of ['name', 'version', 'description', 'action', 'icons']) {
    if (!manifest[field]) error('manifest', `manifest.${field} is required`);
  }

  if (!/^\d+\.\d+\.\d+$/.test(manifest.version || '')) {
    error('version', `manifest version "${manifest.version}" is not semver (x.y.z)`);
  }

  const packageVersion = JSON.parse(read('package.json')).version;
  if (packageVersion !== manifest.version) {
    error('version', `package.json (${packageVersion}) and manifest.json (${manifest.version}) disagree`);
  }

  const changelog = read('CHANGELOG.md');
  if (!changelog.includes(`## ${manifest.version} `)) {
    error('version', `CHANGELOG.md has no "## ${manifest.version}" release entry`);
  }
  pass('version is consistent across manifest, package and changelog');

  // ── Referenced files exist ───────────────────────────────────────────
  const referenced = [];
  if (manifest.background?.service_worker) referenced.push(manifest.background.service_worker);
  if (manifest.action?.default_popup) referenced.push(manifest.action.default_popup);
  for (const icon of Object.values(manifest.icons || {})) referenced.push(icon);
  for (const icon of Object.values(manifest.action?.default_icon || {})) referenced.push(icon);
  for (const entry of manifest.content_scripts || []) {
    for (const file of [...(entry.js || []), ...(entry.css || [])]) referenced.push(file);
  }
  for (const file of new Set(referenced)) {
    if (!exists(file)) error('file-references', `manifest references missing file: ${file}`);
  }
  pass('every manifest-referenced file exists');

  // ── Content script wiring ────────────────────────────────────────────
  const contentEntries = manifest.content_scripts || [];
  if (contentEntries.length === 0) error('content-scripts', 'no content_scripts declared');
  for (const entry of contentEntries) {
    if (!Array.isArray(entry.matches) || entry.matches.length === 0) {
      error('content-scripts', 'a content script entry has no matches');
    }
    if (entry.run_at && !['document_start', 'document_end', 'document_idle'].includes(entry.run_at)) {
      error('content-scripts', `invalid run_at: ${entry.run_at}`);
    }
    const js = entry.js || [];
    const tokenizer = js.indexOf('sentence-tokenizer.js');
    const content = js.indexOf('content.js');
    if (content !== -1 && tokenizer === -1) {
      error('content-scripts', 'content.js is loaded without sentence-tokenizer.js');
    } else if (tokenizer !== -1 && content !== -1 && tokenizer > content) {
      error('content-scripts', 'sentence-tokenizer.js must load before content.js');
    }
  }
  pass('content script load order is valid');

  // ── Permissions ──────────────────────────────────────────────────────
  const permissions = manifest.permissions || [];
  if (manifest.host_permissions?.includes('<all_urls>')) {
    error('permissions', 'host_permissions must not request <all_urls> when content_scripts already matches it');
  }
  for (const permission of permissions) {
    if (DANGEROUS_PERMISSIONS.has(permission)) {
      error('permissions', `over-broad permission requested: ${permission}`);
    }
  }

  const sources = Object.fromEntries(PRODUCTION_JS.filter(exists).map((f) => [f, read(f)]));
  const code = Object.fromEntries(Object.entries(sources).map(([f, src]) => [f, stripComments(src)]));
  const allSource = Object.values(code).join('\n');
  for (const [permission, namespaces] of Object.entries(PERMISSION_NAMESPACES)) {
    const declared = permissions.includes(permission);
    const used = namespaces.some((ns) => new RegExp(`chrome\\.${ns}\\b`).test(allSource));
    if (declared && !used) {
      error('permissions', `permission "${permission}" is declared but never used`);
    }
    if (!declared && used) {
      error('permissions', `chrome.${namespaces[0]} is used but "${permission}" is not declared`);
    }
  }
  pass('declared permissions match actual API use');

  // ── Content-script API allowlist ─────────────────────────────────────
  const contentSource = code['content.js'] || '';
  const namespacesUsed = new Set(matchAll(contentSource, /chrome\.([a-zA-Z]+)/g));
  for (const ns of namespacesUsed) {
    if (!CONTENT_SCRIPT_ALLOWED_NAMESPACES.has(ns)) {
      error('content-script-api', `content.js must not use chrome.${ns} — move it to the worker`);
    }
  }
  pass('content script only uses runtime/storage APIs');

  // ── Forbidden APIs / remote code ─────────────────────────────────────
  for (const [file, source] of Object.entries(code)) {
    for (const { re, why } of FORBIDDEN_PATTERNS) {
      if (re.test(source)) error('forbidden-api', `${file}: ${why}`);
    }
    if (/\bhttps?:\/\/[^\s'"`]+\.js\b/.test(source) && !/example\.com/.test(source)) {
      warn('remote-code', `${file} mentions a remote .js URL — MV3 forbids loading it`);
    }
  }
  pass('no forbidden speech, eval or remote-code APIs');

  // ── Runtime message wiring ───────────────────────────────────────────
  const sentActions = new Set();
  for (const source of Object.values(code)) {
    for (const action of matchAll(source, /action:\s*'([A-Z_]+)'/g)) sentActions.add(action);
  }
  const handledActions = new Set();
  for (const file of ['background.js', 'content.js', 'popup.js']) {
    for (const action of matchAll(code[file] || '', /case\s+'([A-Z_]+)'/g)) handledActions.add(action);
  }
  for (const action of sentActions) {
    if (!handledActions.has(action)) {
      error('message-wiring', `message "${action}" is sent but nothing handles it`);
    }
  }
  pass('every sent runtime message has a handler');

  // ── Manifest capabilities actually implemented ───────────────────────
  if (manifest.background?.type !== 'module') {
    warn('background', 'background service worker should be "type": "module"');
  }
  if (manifest.action?.default_popup && !code['popup.js']) {
    error('popup', 'a popup is declared but popup.js is missing');
  }
  pass('declared background/popup entry points are implemented');

  return { errors, warnings, checks };
}

export function formatLintReport({ errors, warnings, checks }) {
  const lines = [];
  for (const check of checks) lines.push(`  ✓ ${check}`);
  for (const warning of warnings) lines.push(`  ! ${warning.check}: ${warning.detail}`);
  for (const err of errors) lines.push(`  ✗ ${err.check}: ${err.detail}`);
  lines.push('');
  lines.push(`${checks.length} checks, ${warnings.length} warnings, ${errors.length} errors`);
  return lines.join('\n');
}

// Only run when invoked directly, not when imported by the test suite.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runLint();
  console.log(formatLintReport(report));
  process.exit(report.errors.length === 0 ? 0 : 1);
}
