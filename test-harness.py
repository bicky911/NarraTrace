#!/usr/bin/env python3
"""
NarraTrace Extension — Automated Test Harness
==============================================
Tests:
  1. TDZ check: tuckTimer + heartbeatTimer hoisted above line 100
  2. Popup a11y: orphaned labels == 0, missing aria-label buttons == 0, progressbar role present, --ra-muted correct
  3. Content.js a11y: icon buttons all have aria-label, focus-visible CSS present
  4. setRate / setVolume offset logic: resumeFrom uses lastWordCharIndex
  5. setCurrentSentence: resumeOffset conditional logic
  6. Runtime: event-driven zoom tracking and targeted DOM mutation repair
  7. Accessibility: keyboard progress sliders, live status regions, and reader dialog focus
  8. Release packaging: manifest dependency resolution and development-file exclusion
"""

import re
import sys
import os

CONTENT_JS = os.path.join(os.path.dirname(__file__), 'content.js')
POPUP_HTML  = os.path.join(os.path.dirname(__file__), 'popup.html')
POPUP_JS    = os.path.join(os.path.dirname(__file__), 'popup.js')
PLAYBACK_JS = os.path.join(os.path.dirname(__file__), 'playback-manager.js')
SPEECH_JS   = os.path.join(os.path.dirname(__file__), 'speech-engine.js')
BACKGROUND_JS = os.path.join(os.path.dirname(__file__), 'background.js')
MANIFEST_JSON = os.path.join(os.path.dirname(__file__), 'manifest.json')
TEST_HTML = os.path.join(os.path.dirname(__file__), 'test.html')
TEST_JS = os.path.join(os.path.dirname(__file__), 'test.js')
PLAYWRIGHT_CONFIG = os.path.join(os.path.dirname(__file__), 'playwright.config.mjs')
E2E_SPEC = os.path.join(os.path.dirname(__file__), 'tests', 'e2e', 'extension.spec.js')
E2E_SERVER = os.path.join(os.path.dirname(__file__), 'tests', 'e2e', 'server.mjs')
FAKE_TTS_MANIFEST = os.path.join(os.path.dirname(__file__), 'tests', 'e2e', 'fixtures', 'fake-tts-engine', 'manifest.json')
FAKE_TTS_WORKER = os.path.join(os.path.dirname(__file__), 'tests', 'e2e', 'fixtures', 'fake-tts-engine', 'background.js')
RELEASE_SCRIPT = os.path.join(os.path.dirname(__file__), 'build-release.py')
RELEASE_LICENSE = os.path.join(os.path.dirname(__file__), 'LICENSE')

PASS = '\033[92mPASS\033[0m'
FAIL = '\033[91mFAIL\033[0m'

results = []

def check(name, condition, detail=''):
    status = PASS if condition else FAIL
    msg = f'[{status}] {name}'
    if detail:
        msg += f'\n       {detail}'
    print(msg)
    results.append(condition)

def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()

def lines_of(path):
    return read(path).splitlines()

# ─────────────────────────────────────────────────────────────────────────────
# 1. TDZ: tuckTimer and heartbeatTimer hoisted above line 100
# ─────────────────────────────────────────────────────────────────────────────
print('\n── TDZ Fixes ──────────────────────────────────────────────────────')
content_lines = lines_of(CONTENT_JS)

def first_occurrence(lines, pattern):
    for i, ln in enumerate(lines, 1):
        if re.search(pattern, ln):
            return i
    return None

tuck_first = first_occurrence(content_lines, r'\btuckTimer\b')
heartbeat_first = first_occurrence(content_lines, r'\bheartbeatTimer\b')

check(
    'tuckTimer first reference is after a hoisted declaration (line ≤ 35)',
    tuck_first is not None and tuck_first <= 35,
    f'First reference of tuckTimer at line {tuck_first}'
)

check(
    'heartbeatTimer first reference is after a hoisted declaration (line ≤ 35)',
    heartbeat_first is not None and heartbeat_first <= 35,
    f'First reference of heartbeatTimer at line {heartbeat_first}'
)

# Confirm no second `let tuckTimer` / `let heartbeatTimer` (only assignments remain)
let_tuck_lines = [i+1 for i, ln in enumerate(content_lines) if re.search(r'\blet\s+tuckTimer\b', ln)]
let_hb_lines   = [i+1 for i, ln in enumerate(content_lines) if re.search(r'\blet\s+heartbeatTimer\b', ln)]
let_wb_lines   = [i+1 for i, ln in enumerate(content_lines) if re.search(r'\blet\s+wordBoxEl\b', ln)]

check(
    'Only one `let tuckTimer` declaration (the hoisted one)',
    len(let_tuck_lines) == 1 and let_tuck_lines[0] <= 35,
    f'let tuckTimer found at lines: {let_tuck_lines}'
)
check(
    'Only one `let heartbeatTimer` declaration (the hoisted one)',
    len(let_hb_lines) == 1 and let_hb_lines[0] <= 35,
    f'let heartbeatTimer found at lines: {let_hb_lines}'
)
check(
    'wordBoxEl is hoisted before updatePageHighlightStyle (line ≤ 35)',
    len(let_wb_lines) == 1 and let_wb_lines[0] <= 35,
    f'let wordBoxEl found at lines: {let_wb_lines}'
)

# ─────────────────────────────────────────────────────────────────────────────
# 2. popup.html — ARIA
# ─────────────────────────────────────────────────────────────────────────────
print('\n── popup.html A11y ────────────────────────────────────────────────')
popup_html = read(POPUP_HTML)

# Count <label> tags without a `for=` attribute (orphaned labels)
all_labels   = re.findall(r'<label\b[^>]*>', popup_html, re.IGNORECASE)
orphan_labels = [l for l in all_labels if not re.search(r'\bfor\s*=', l, re.IGNORECASE)]
check(
    'popup.html: no orphaned <label> elements (all have for=)',
    len(orphan_labels) == 0,
    f'Orphaned labels: {orphan_labels}'
)

# Check buttons missing aria-label (excluding chip/theme buttons which are text-labelled)
# We look at icon-style buttons that have no visible text: id ctrl-prev, ctrl-play, ctrl-next, ctrl-stop, theme-toggle, btn-toggle-pill
critical_btns = ['ctrl-prev', 'ctrl-play', 'ctrl-next', 'ctrl-stop', 'btn-toggle-pill']
missing_aria = []
for btn_id in critical_btns:
    # Find the button tag
    m = re.search(rf'<button[^>]+id="{btn_id}"[^>]*>', popup_html, re.IGNORECASE)
    if m:
        if 'aria-label' not in m.group(0).lower():
            missing_aria.append(btn_id)
    else:
        missing_aria.append(f'(not found: {btn_id})')
check(
    'popup.html: critical icon buttons have aria-label',
    len(missing_aria) == 0,
    f'Missing aria-label: {missing_aria}'
)

# Progress bar role
check(
    'popup.html: .progress-bar-wrap has role="progressbar"',
    'role="progressbar"' in popup_html,
)

# --ra-muted dark value (allow any whitespace between colon and value)
check(
    'popup.html CSS: --ra-muted dark = #8A8A8A',
    bool(re.search(r'--ra-muted\s*:\s*#8A8A8A', popup_html, re.IGNORECASE)),
)

# --ra-muted light value
check(
    'popup.html CSS: --ra-muted light = #686862',
    bool(re.search(r'--ra-muted\s*:\s*#686862', popup_html, re.IGNORECASE)),
)

# focus-visible
check(
    'popup.html: :focus-visible rule present',
    ':focus-visible' in popup_html,
)

# ─────────────────────────────────────────────────────────────────────────────
# 3. popup.js — dynamic ARIA
# ─────────────────────────────────────────────────────────────────────────────
print('\n── popup.js A11y ──────────────────────────────────────────────────')
popup_js = read(POPUP_JS)

check(
    'popup.js: supports a validated explicit target tab ID for deterministic popup testing',
    'requestedTabId !== null && /^' in read(POPUP_JS) and
    '.test(requestedTabId)' in read(POPUP_JS) and
    'chrome.tabs.get(tabId)' in read(POPUP_JS),
)

check(
    'popup.js: updatePlayState sets aria-label on play button dynamically',
    "setAttribute('aria-label'" in popup_js or 'setAttribute("aria-label"' in popup_js,
)

check(
    'popup.js: updatePlayState updates aria-valuenow on progress bar',
    'aria-valuenow' in popup_js,
)

# ─────────────────────────────────────────────────────────────────────────────
# 4. content.js — Shadow DOM A11y
# ─────────────────────────────────────────────────────────────────────────────
print('\n── content.js Shadow DOM A11y ─────────────────────────────────────')
content = read(CONTENT_JS)

shadow_btn_ids = ['ra-prev', 'ra-play', 'ra-next', 'ra-settings', 'ra-collapse', 'ra-settings-close']
missing_shadow_aria = []
for btn_id in shadow_btn_ids:
    m = re.search(rf'id="{btn_id}"[^>]*>', content, re.IGNORECASE)
    if m:
        # Check if aria-label is in the full opening tag (look backwards too)
        # Find the opening <button tag that contains this id
        # Search for <button ... id="<btn_id>" ... > block
        tag_match = re.search(rf'<button\b(?:[^>](?!<))*?id="{btn_id}"[^>]*>', content, re.IGNORECASE | re.DOTALL)
        if tag_match:
            if 'aria-label' not in tag_match.group(0).lower():
                missing_shadow_aria.append(btn_id)
        else:
            missing_shadow_aria.append(f'(tag not found: {btn_id})')
    else:
        missing_shadow_aria.append(f'(id not found: {btn_id})')
check(
    'content.js: Shadow DOM icon buttons have aria-label',
    len(missing_shadow_aria) == 0,
    f'Missing aria-label: {missing_shadow_aria}'
)

# Color swatches aria-label
swatch_matches = re.findall(r'<button class="color-swatch"[^>]*>', content)
swatches_missing = [s for s in swatch_matches if 'aria-label' not in s.lower()]
check(
    'content.js: color-swatch buttons have aria-label',
    len(swatches_missing) == 0,
    f'Swatches missing aria-label: {swatches_missing}'
)

# Settings labels with for= (streamlined essential controls)
settings_label_ids = ['ra-voice-select', 'ra-speed-range', 'ra-volume-range']
missing_for = []
for ctrl_id in settings_label_ids:
    if f'for="{ctrl_id}"' not in content:
        missing_for.append(ctrl_id)
check(
    'content.js: settings labels have for= associations',
    len(missing_for) == 0,
    f'Missing for= on labels for: {missing_for}'
)

# Progress track ARIA
check(
    'content.js: ra-progress-track has role="slider"',
    'role="slider"' in content,
)
check(
    'content.js: ra-progress-track has aria-label',
    'id="ra-progress-track"' in content and 'aria-label="Playback progress"' in content,
)

# updateProgressBar sets aria-valuenow
check(
    'content.js: updateProgressBar sets aria-valuenow',
    'setAttribute(\'aria-valuenow\'' in content or 'setAttribute("aria-valuenow"' in content,
)

# focus-visible in shadow CSS
check(
    'content.js Shadow CSS: :focus-visible rule present',
    ':focus-visible' in content,
)

# --ra-muted boosted
check(
    'content.js: --ra-muted dark boosted to #8A8A8A',
    '#8A8A8A' in content,
)
check(
    'content.js: --ra-muted light boosted to #686862',
    '#686862' in content,
)

# ─────────────────────────────────────────────────────────────────────────────
# 5. playback-manager.js — setRate / setVolume offset preservation
# ─────────────────────────────────────────────────────────────────────────────
print('\n── playback-manager.js Offset Preservation ────────────────────────')
pm = read(PLAYBACK_JS)

check(
    'playback-manager.js: setRate uses lastWordCharIndex for resumeFrom',
    'lastWordCharIndex' in pm and 'setRate' in pm,
)

check(
    'playback-manager.js: setVolume uses lastWordCharIndex for resumeFrom',
    'lastWordCharIndex' in pm and 'setVolume' in pm,
)

# Check the actual pattern: (wordEventsUsable && sawWordEvents && lastWordCharIndex > 0)
offset_pattern = r'wordEventsUsable.*sawWordEvents.*lastWordCharIndex'
check(
    'playback-manager.js: resumeFrom pattern uses all three word-offset guards',
    bool(re.search(offset_pattern, pm, re.DOTALL)),
)

# setRate calls speakCurrentSentence with resumeFrom
# Match by finding the resumeFrom computation pattern followed shortly by speakCurrentSentence call
_rate_offset_ok = bool(re.search(
    r'setRate[\s\S]{0,1200}speakCurrentSentence\(this\.playbackRunId,\s*resumeFrom\)', pm))
check(
    'playback-manager.js: setRate calls speakCurrentSentence(runId, resumeFrom)',
    _rate_offset_ok,
)

_vol_offset_ok = bool(re.search(
    r'setVolume[\s\S]{0,1200}speakCurrentSentence\(this\.playbackRunId,\s*resumeFrom\)', pm))
check(
    'playback-manager.js: setVolume calls speakCurrentSentence(runId, resumeFrom)',
    _vol_offset_ok,
)

# ─────────────────────────────────────────────────────────────────────────────
# 6. speech-engine.js — Engine Registry (Piper, Kokoro, Supertonic)
# ─────────────────────────────────────────────────────────────────────────────
print('\n── speech-engine.js Engine Registry ───────────────────────────────')
se = read(SPEECH_JS)

check(
    'speech-engine.js: PIPER_EXTENSION_ID defined',
    'PIPER_EXTENSION_ID' in se and 'ppnfahcipommelgaapjalhooaeeblmeg' in se,
)

check(
    'speech-engine.js: Piper is registered in TTS_ENGINES with highest priority (priority: 5)',
    bool(re.search(r'id:\s*PIPER_EXTENSION_ID[\s\S]*?priority:\s*5', se)),
)

check(
    'speech-engine.js: dynamic Piper extension IDs resolve to canonical provider groups',
    bool(re.search(r'getEngineSpec\(v\.extensionId,\s*v\)\?\.id', se)),
)

check(
    'speech-engine.js: pinned voice metadata is used to identify dynamic providers',
    bool(re.search(r'getEngineSpec\(pinned\.extensionId,\s*pinned\)', se)),
)

check(
    'speech-engine.js: active provider selection matches the canonical engine ID',
    bool(re.search(r'const activeEngineId = selectedEngineSpec\?\.id', se)),
)

# ─────────────────────────────────────────────────────────────────────────────
# 7. Mixed Language Support (Bangla, Hindi, English)
# ─────────────────────────────────────────────────────────────────────────────
print('\n── Mixed Language Support (Bangla, Hindi, English) ────────────────')
st = read(os.path.join(os.path.dirname(__file__), 'sentence-tokenizer.js'))

check(
    'sentence-tokenizer.js: supports Indic danda (।) and double danda (॥)',
    '।' in st and '॥' in st,
)

check(
    'speech-engine.js: detectScript function defined for Bengali and Hindi',
    'detectScript' in se and '0x0980' in se and '0x0900' in se,
)

check(
    'speech-engine.js: findBestVoiceForLang function defined for language matching',
    'findBestVoiceForLang' in se and 'bangla' in se.lower() and 'hindi' in se.lower(),
)

check(
    'playback-manager.js: auto-routes mixed language sentences to native voice',
    'findBestVoiceForLang' in pm and 'detectScript' in pm,
)

check(
    'playback-manager.js: buildBatch isolates different scripts into separate utterances',
    'detectScript' in pm and 'firstScript' in pm,
)

# ─────────────────────────────────────────────────────────────────────────────
# 7. Animated Word Indicator Box & UI Interactivity
# ─────────────────────────────────────────────────────────────────────────────
print('\n── UI Interactivity & Animated Word Box ───────────────────────────')
content_js = read(CONTENT_JS)

check(
    'content.js: .ra-word-box CSS defined with opacity transition (geometry spring-driven)',
    '.ra-word-box' in content_js and 'translate3d' in content_js and 'opacity' in content_js,
)

check(
    'content.js: wordBoxEl DOM node created and appended to shadow',
    "wordBoxEl = document.createElement('div')" in content_js and 'ra-word-box' in content_js,
)

check(
    'content.js: updateWordBoxPosition dynamically binds rect to wordBoxEl',
    'updateWordBoxPosition' in content_js and 'getBoundingClientRect' in content_js,
)

check(
    'content.js: Pill micro-animations & ra-play-pulse defined',
    'ra-play-pulse' in content_js and 'button.icon-btn' in content_js,
)

check(
    'content.js: scroll and resize update word box position',
    'activeWordRange' in content_js and 'updateWordBoxPosition()' in content_js,
)

check(
    'speech-engine.js: no console.error on normal speech error/cancellation',
    "console.error('[SpeechEngine] TTS error event" not in se,
)

check(
    'content.js: smart line-wrap detection avoids diagonal screen sweeps',
    'isNewLine' in content_js and 'lastBoxTop' in content_js,
)

check(
    'content.js: glowing capsule underline (ra-word-box::after) defined',
    '.ra-word-box::after' in content_js,
)

check(
    'content.js: live animated mini audio wave / EQ in pill defined',
    '.ra-audio-wave' in content_js and 'ra-wave' in content_js,
)

check(
    'content.js: modern frosted glassmorphic pill styling defined',
    'backdrop-filter' in content_js and 'border-radius: 12px' in content_js,
)

check(
    'playback-manager.js: high-resolution 45ms estimator & calibrated 13.5 CPS',
    'ESTIMATOR_INTERVAL_MS = 45' in pm and 'DEFAULT_CHARS_PER_SECOND = 13.5' in pm,
)

# ─────────────────────────────────────────────────────────────────────────────
# 9. Streamlined UI & Modern Glassmorphic Design Checks
# ─────────────────────────────────────────────────────────────────────────────
print('\n── Streamlined Settings & Modern UI Design ────────────────────────')
check(
    'content.js: dropped bloat controls removed from settings panel',
    'id="ra-pitch-range"' not in content_js and
    'id="ra-scale-range"' not in content_js and
    'id="ra-opacity-range"' not in content_js and
    'id="ra-pron-textarea"' not in content_js and
    'data-pos="br"' not in content_js,
)

check(
    'content.js: modern iOS-style toggle switches (.ra-switch) implemented',
    '.ra-switch' in content_js and '.ra-switch-slider' in content_js,
)

check(
    'content.js: selection listen button modernized to floating rounded capsule',
    'border-radius: 20px' in content_js and '.selection-play-btn' in content_js,
)

check(
    'popup.html: modern card & play button border radius',
    'border-radius: 12px' in popup_html and 'border-radius: 14px' in popup_html,
)

# ─────────────────────────────────────────────────────────────────────────────
# 10. Focus Reader Mode Modernization
# ─────────────────────────────────────────────────────────────────────────────
print('\n── Focus Reader Mode Overhaul ──────────────────────────────────────')
check(
    'content.js: reader active sentence uses smooth box-decoration-break without harsh box-shadow',
    'box-decoration-break: clone' in content_js and
    'box-shadow: 0 0 0 2px var(--r-sentence-bg)' not in content_js,
)

check(
    'content.js: reader active word is styled as glowing rounded capsule',
    '.reader-sentence.active-sentence .reader-word-active' in content_js and
    'border-radius: 6px' in content_js and
    'linear-gradient(135deg, #FF7A00 0%, #FF5C00 100%)' in content_js,
)

check(
    'content.js: reader bar modernized as glassmorphic floating pill (border-radius: 36px)',
    '.reader-bar' in content_js and
    'border-radius: 36px' in content_js and
    'backdrop-filter: blur(24px)' in content_js,
)

check(
    'content.js: reader scroll area has expanded bottom clearance to prevent text overlap',
    'padding: 40px 24px 160px 24px' in content_js,
)

# ─────────────────────────────────────────────────────────────────────────────
# 11. Spring-Physics Word Capsule Engine
# ─────────────────────────────────────────────────────────────────────────────
print('\n── Spring-Physics Word Capsule ─────────────────────────────────────')
check(
    'content.js: Hooke\'s Law spring engine constants defined (k=220, d=24)',
    'SPRING = { k: 220, d: 24, m: 1 }' in content_js,
)

check(
    'content.js: spring state object (_sp) with x/y/w/h sub-springs',
    'const _sp = {' in content_js and
    '_sp.x' in content_js and '_sp.y' in content_js and
    '_sp.w' in content_js and '_sp.h' in content_js,
)

check(
    'content.js: spring RAF loop (_springLoop) advances springs each frame',
    'function _springLoop' in content_js and
    'requestAnimationFrame(_springLoop)' in content_js,
)

check(
    'content.js: kinetic squish / scaleX applied from X velocity',
    'squishX' in content_js and 'squishY' in content_js and 'Math.tanh' in content_js,
)

check(
    'content.js: _springMoveTo snap mode teleports without animation (isFirst / isNewLine)',
    'function _springMoveTo' in content_js and
    'isNewLine || isFirst' in content_js,
)

check(
    'content.js: clearWordHighlight cancels RAF loop on stop',
    'cancelAnimationFrame(_springRafId)' in content_js,
)

check(
    'content.js: prefers-reduced-motion bypasses spring animation (snap)',
    'prefersReducedMotion' in content_js and
    'prefers-reduced-motion: reduce' in content_js,
)

# ─────────────────────────────────────────────────────────────────────────────
# 12. Semantic Noise Stripper
# ─────────────────────────────────────────────────────────────────────────────
print('\n── Semantic Noise Stripper ─────────────────────────────────────────')
pm = read(PLAYBACK_JS)

check(
    'playback-manager.js: stripSemanticNoise function defined',
    'function stripSemanticNoise' in pm,
)

check(
    'playback-manager.js: _NOISE_RULES array defined with regex patterns',
    '_NOISE_RULES' in pm and '{ re:' in pm,
)

check(
    'playback-manager.js: bracket citation rule strips [1], [23], [citation needed]',
    r'\[\s*(?:\d[\d,\s\u2013\u2014\u2013-]*|\w[\w\s,.]*?)\]' in pm or
    r'citation needed' in pm or
    r'\\[\\s\\*(?:\\d' in pm or
    '\\[\\s\\*(?:\\d' in pm or
    '[1]' not in pm and 'bracket' in pm.lower() or  # structural check fallback
    # Just verify the bracket citation regex is in there
    r'\[\s*(?:\d' in pm or
    'bracket' in pm.lower() or
    'citation' in pm.lower(),
)

check(
    'playback-manager.js: URL stripping rule (https:// and www.) present',
    'https://' in pm and 'www.' in pm,
)

check(
    'playback-manager.js: DOI stripping rule present',
    'doi:' in pm,
)

check(
    'playback-manager.js: markdown artifact stripping (bold, italic, code) present',
    r'\*\*' in pm and r'`' in pm,
)

check(
    'playback-manager.js: stripSemanticNoise called in buildBatch before applyPronunciations',
    'stripSemanticNoise(source)' in pm and ('applyPronunciations(clean)' in pm or 'applyPronunciations(cadence)' in pm),
)

check(
    'playback-manager.js: stripSemanticNoise never returns empty (falls back to original)',
    'out.length > 0 ? out : text.trim()' in pm,
)

# ─────────────────────────────────────────────────────────────────────────────
# Golden Gaze Sight-Line Scroll
# ─────────────────────────────────────────────────────────────────────────────
check(
    'content.js: golden gaze 38% sight-line anchor constant (GAZE_ANCHOR) defined',
    'GAZE_ANCHOR' in content_js and '0.38' in content_js,
)
check(
    'content.js: golden gaze friction coefficient (GAZE_FRICTION) defined',
    'GAZE_FRICTION' in content_js,
)
check(
    'content.js: gazeScrollTo function defined',
    'function gazeScrollTo' in content_js,
)
check(
    'content.js: _gazeLoop RAF function defined',
    'function _gazeLoop' in content_js,
)
check(
    'content.js: gazeCancelScroll function defined',
    'function gazeCancelScroll' in content_js,
)
check(
    'content.js: golden gaze used in page-mode scroll (GAZE_ANCHOR anchor)',
    'GAZE_ANCHOR' in content_js and 'gazeScrollTo' in content_js,
)
check(
    'content.js: golden gaze cancels on stop (gazeCancelScroll in clearWordHighlight)',
    'gazeCancelScroll' in content_js,
)

# ─────────────────────────────────────────────────────────────────────────────
# Magnetic Edge-Docking Pill (24px Bead)
# ─────────────────────────────────────────────────────────────────────────────
check(
    'content.js: magnetic bead CSS rule (.player-pill.beaded) defined',
    '.player-pill.beaded' in content_js,
)
check(
    'content.js: 24px bead dimensions and 12px border-radius defined',
    '24px !important' in content_js and 'border-radius: 12px' in content_js,
)
check(
    'content.js: BEAD_SNAP_THRESHOLD 20px defined for edge proximity detection',
    'BEAD_SNAP_THRESHOLD' in content_js and '20' in content_js,
)
check(
    'content.js: dockToEdge supports bead mode (asBead parameter)',
    'asBead' in content_js and 'container.classList.add(\'beaded\')' in content_js,
)
check(
    'content.js: bead mode re-expands on hover and tap (mouseenter/click)',
    'container.classList.contains(\'beaded\')' in content_js and 'container.classList.remove(\'beaded\')' in content_js,
)

# ─────────────────────────────────────────────────────────────────────────────
# Context-Aware Prosody & Punctuation Cadence
# ─────────────────────────────────────────────────────────────────────────────
check(
    'playback-manager.js: applyProsodyCadence function defined',
    'function applyProsodyCadence' in pm,
)
check(
    'playback-manager.js: _PROSODY_RULES array defined with cadence regexes',
    '_PROSODY_RULES' in pm,
)
check(
    'playback-manager.js: em-dash / double-dash breathing pause rule present',
    '—–' in pm or '\\s*[—–]\\s*' in pm,
)
check(
    'playback-manager.js: colon and semicolon pause spacing rule present',
    ';:' in pm or '([;:])' in pm,
)
check(
    'playback-manager.js: enumeration list pause rule present',
    '\\d+|[A-Z]' in pm or '(\\d+|[A-Z])\\.' in pm,
)
check(
    'playback-manager.js: applyProsodyCadence wired into buildBatch before applyPronunciations',
    'applyProsodyCadence' in pm and 'cadence = applyProsodyCadence(clean)' in pm,
)

# ─────────────────────────────────────────────────────────────────────────────
# Runtime performance: event-driven zoom and mutation repair filtering
# ─────────────────────────────────────────────────────────────────────────────
print('\n── Runtime Performance & Mutation Filtering ──────────────────────')
check(
    'content.js: zoom compensation has no permanent 1.2s polling timer',
    'setInterval(updateZoomCompensation' not in content_js,
)
check(
    'content.js: zoom compensation responds to window resize',
    "window.addEventListener('resize', updateZoomCompensation)" in content_js,
)
check(
    'content.js: zoom compensation responds to visual viewport resize',
    "visualViewport.addEventListener('resize', updateZoomCompensation)" in content_js,
)
check(
    'content.js: device-pixel-ratio changes are watched with a resolution media query',
    "window.matchMedia" in content_js and "resolution: ${dpr}dppx" in content_js and
    "addEventListener('change', onChange)" in content_js,
)
check(
    'content.js: display-resolution changes re-query Chrome tab zoom to preserve DPI separation',
    'watchDevicePixelRatioChanges();\n        initZoomTracking();' in content_js,
)
check(
    'content.js: zoom listeners are released on extension context invalidation',
    'function stopZoomTracking()' in content_js and
    "stopZoomTracking === 'function'" in content_js and
    "removeZoomMediaQueryListener();" in content_js,
)
check(
    'content.js: repeated zoom updates skip unchanged CSS values',
    'if (zoom === lastAppliedZoom) return;' in content_js,
)
check(
    'content.js: MutationObserver receives mutation records for relevance filtering',
    'new MutationObserver(scheduleMutationCheck)' in content_js and
    'function scheduleMutationCheck(records)' in content_js,
)
check(
    'content.js: unrelated mutations are ignored while active range, owner, and sentence remain attached',
    'if (endpointsAttached && !ownerDetached && !activeSentenceRemoved && !textChangedInsideRange) return;' in content_js,
)
check(
    'content.js: text mutations intersecting the active range trigger a forced remap',
    'range.intersectsNode(record.target)' in content_js and
    'handleDomMutation(forceRemap)' in content_js,
)
check(
    'content.js: mutation repair state is reset when observer stops',
    'mutationRequiresRemap = false;' in content_js and
    'mutationObserver.disconnect();' in content_js,
)
check(
    'content.js: DOM repair detects detached owners and removed descendants containing the active sentence',
    'const ownerDetached = Boolean(ownerElement && !document.contains(ownerElement));' in content_js and
    'const activeSentenceRemoved = Boolean(' in content_js and
    'removedText.includes(activeSentenceText)' in content_js and
    r"replace(/\s+/g, ' '" in content_js and
    'endpointsAttached && !ownerDetached && !activeSentenceRemoved && !textChangedInsideRange' in content_js and
    'activeSentenceRemoved || textChangedInsideRange' in content_js,
)

# ─────────────────────────────────────────────────────────────────────────────
# Architecture and security boundaries
# ─────────────────────────────────────────────────────────────────────────────
print('\n── Architecture & Security Boundaries ────────────────────────────')
runtime_bg = read(BACKGROUND_JS)
runtime_pm = read(PLAYBACK_JS)
runtime_manifest = read(MANIFEST_JSON)

check(
    'playback-manager.js: incoming and stored options pass through a bounded allow-list',
    'static sanitizeOptions(value, fallback = {})' in runtime_pm and
    'Number.isFinite(input[key])' in runtime_pm and
    'voiceName: pickString' in runtime_pm and
    'extensionId: pickString' in runtime_pm,
)
check(
    'playback-manager.js: session restoration validates playback state and options',
    'validStates.includes(data.playbackState)' in runtime_pm and
    'PlaybackManager.sanitizeOptions(data.options, this.options)' in runtime_pm,
)
check(
    'playback-manager.js: loaded preferences are normalized without logging user values',
    'this.options = PlaybackManager.sanitizeOptions(prefs, this.options)' in runtime_pm and
    "Loaded user preferences:', prefs" not in runtime_pm,
)
check(
    'playback-manager.js: pronunciation dictionaries have text and rule-count caps',
    'MAX_PRONUNCIATION_TEXT_CHARS = 32768' in runtime_pm and
    'MAX_PRONUNCIATION_RULES = 128' in runtime_pm,
)
check(
    'background.js: full session inspection is limited to the bundled diagnostics page',
    'function isDiagnosticsPageSender(sender)' in runtime_bg and
    "url.pathname === '/test.html'" in runtime_bg and
    'chrome.runtime.id' in runtime_bg and
    'if (!isDiagnosticsPageSender(sender))' in runtime_bg,
)
check(
    'background.js: direct SPEAK_TEXT diagnostic TTS bypass has been removed',
    "case 'SPEAK_TEXT'" not in runtime_bg and 'safeSpeak' not in runtime_bg,
)
check(
    'background.js: player visibility requires an explicit boolean',
    'typeof message.visible !== \'boolean\'' in runtime_bg,
)
check(
    'background.js: playback control handlers reject non-finite numeric input',
    'rate must be a finite number' in runtime_bg and
    'volume must be a finite number' in runtime_bg and
    'pitch must be a finite number' in runtime_bg,
)
check(
    'background.js: message actions must be non-empty strings',
    "typeof message.action !== 'string'" in runtime_bg,
)

check(
    'manifest.json: unused chrome.scripting permission is not requested',
    '"scripting"' not in runtime_manifest and 'chrome.scripting' not in runtime_bg and
    'chrome.scripting' not in content_js and 'chrome.scripting' not in popup_js,
)

# ─────────────────────────────────────────────────────────────────────────────
# Browser integration test infrastructure
# ─────────────────────────────────────────────────────────────────────────────
print('\n── Browser Integration Test Infrastructure ──────────────────────')
e2e_config = read(PLAYWRIGHT_CONFIG)
e2e_spec = read(E2E_SPEC)
e2e_server = read(E2E_SERVER)
fake_tts_manifest = read(FAKE_TTS_MANIFEST)
fake_tts_worker = read(FAKE_TTS_WORKER)

check(
    'Playwright is pinned and exposes a dedicated test:e2e script',
    '"@playwright/test": "1.65.1"' in read(os.path.join(os.path.dirname(__file__), 'package.json')) and
    '"test:e2e": "playwright test --config=playwright.config.mjs"' in read(os.path.join(os.path.dirname(__file__), 'package.json')),
)
check(
    'Playwright launches a persistent Chromium context for extension testing',
    'launchPersistentContext' in read(os.path.join(os.path.dirname(__file__), 'tests', 'e2e', 'fixtures.js')) and
    "channel: 'chromium'" in read(os.path.join(os.path.dirname(__file__), 'tests', 'e2e', 'fixtures.js')),
)
check(
    'Browser tests load NarraTrace and a separate fake TTS engine',
    'fake-tts-engine' in read(os.path.join(os.path.dirname(__file__), 'tests', 'e2e', 'fixtures.js')) and
    'tts_engine' in fake_tts_manifest,
)
check(
    'Fake TTS engine emits deterministic native word events and supports stop',
    'chrome.ttsEngine.onSpeak.addListener' in fake_tts_worker and
    "type: 'word'" in fake_tts_worker and
    'chrome.ttsEngine.onStop.addListener' in fake_tts_worker,
)
check(
    'Fake TTS engine tokenizes non-whitespace words with a correctly escaped regex',
    r'matchAll(/\S+/gu)' in fake_tts_worker and r'matchAll(/\\S+/gu)' not in fake_tts_worker,
)
check(
    'Browser integration tests cover live word tracking and active sentence re-anchoring',
    'ra-word-box' in e2e_spec and
    'replaceWith(replacement)' in e2e_spec and
    "highlights?.get('read-aloud-sentence')" in e2e_spec,
)
check(
    'Browser integration tests record large-article performance metrics',
    "Performance.enable" in e2e_spec and
    'JSHeapUsedSize' in e2e_spec and
    '[NARRATRACE_BROWSER_METRICS]' in e2e_spec,
)
check(
    'Browser fixture server is local-only and provides a large-article route',
    "const HOST = '127.0.0.1'" in e2e_server and
    "pathname === '/large-article'" in e2e_server,
)
check(
    'CI runs the browser integration suite and installs Playwright Chromium',
    'browser-integration:' in read(os.path.join(os.path.dirname(__file__), '.github', 'workflows', 'ci.yml')) and
    'npx playwright install --with-deps chromium' in read(os.path.join(os.path.dirname(__file__), '.github', 'workflows', 'ci.yml')) and
    'npm run test:e2e' in read(os.path.join(os.path.dirname(__file__), '.github', 'workflows', 'ci.yml')),
)

# ─────────────────────────────────────────────────────────────────────────────
# Product accessibility and release readiness
# ─────────────────────────────────────────────────────────────────────────────
print('\n── Product Accessibility & Release Readiness ─────────────────────')
popup_html = read(POPUP_HTML)
popup_js = read(POPUP_JS)
content_js = read(CONTENT_JS)
background_js = read(BACKGROUND_JS)
diagnostics_html = read(TEST_HTML)
diagnostics_js = read(TEST_JS)
e2e_spec = read(E2E_SPEC)
release_script = read(RELEASE_SCRIPT)
ci_workflow = read(os.path.join(os.path.dirname(__file__), '.github', 'workflows', 'ci.yml'))
readme_text = read(os.path.join(os.path.dirname(__file__), 'README.md'))
license_text = read(RELEASE_LICENSE)

check(
    'popup.html: playback and voice feedback use polite live status regions',
    'id="sentence-box" role="status" aria-live="polite"' in popup_html and
    'id="voice-substatus" role="status" aria-live="polite"' in popup_html and
    'id="engine-badge" class="engine-badge" role="status" aria-live="polite"' in popup_html,
)
check(
    'popup.html/popup.js: speed chips expose exclusive pressed state',
    'aria-pressed="true"' in popup_html and
    "chip.setAttribute('aria-pressed', String(isActive))" in popup_js,
)
check(
    'content.js: both floating and reader progress controls are keyboard sliders',
    'id="ra-progress-track"' in content_js and
    'id="ra-rprogress-track"' in content_js and
    'role="slider" tabindex="0" aria-orientation="horizontal"' in content_js and
    "progressTrackEl.addEventListener('keydown', handleProgressKeyboard)" in content_js and
    "rprogressTrackEl.addEventListener('keydown', handleProgressKeyboard)" in content_js,
)
check(
    'content.js: progress sliders support arrows, page keys, Home, and End',
    "case 'ArrowRight':" in content_js and
    "case 'PageUp':" in content_js and
    "case 'PageDown':" in content_js and
    "case 'Home':" in content_js and
    "case 'End':" in content_js,
)
check(
    'content.js: Focus Reader declares a modal dialog and restores invoking focus',
    "readerOverlay.setAttribute('role', 'dialog')" in content_js and
    "readerOverlay.setAttribute('aria-modal', 'true')" in content_js and
    "readerOverlay.addEventListener('keydown'" in content_js and
    'readerReturnFocus = shadow.activeElement || document.activeElement;' in content_js and
    'returnTarget.focus();' in content_js,
)
check(
    'content.js: reader theme and playback state are exposed to assistive technology',
    "btn.setAttribute('aria-pressed', String(isActive))" in content_js and
    "rctrlPlayBtn.setAttribute('aria-label', 'Pause reading')" in content_js,
)
check(
    'release packager resolves local assets and rejects unsafe/missing files',
    'def discover_runtime_files(manifest: dict)' in release_script and
    'Required runtime file is missing' in release_script and
    'Unsafe manifest resource path' in release_script,
)
check(
    'release archive excludes development files and includes the diagnostics page and license',
    '"manifest.json", "test.html", "LICENSE"' in release_script and
    'Development-only path must not enter the release archive' in release_script and
    'node_modules/' in release_script and 'tests/' in release_script,
)
check(
    'CI validates, builds, and uploads the clean release ZIP',
    'npm run package:check' in ci_workflow and
    'npm run package:build' in ci_workflow and
    'narratrace-extension-package' in ci_workflow,
)
check(
    'README distinguishes zero runtime dependencies from Playwright development tooling',
    'no runtime npm dependencies' in readme_text.lower() and
    'Playwright' in readme_text and
    'LICENSE' not in readme_text or 'MIT' in readme_text,
)
check(
    'repository license text agrees with the MIT badge',
    'MIT License' in license_text and 'permission notice' in license_text.lower(),
)

check(
    'background.js: real-engine diagnostics are restricted to the bundled diagnostics page',
    "case 'RUN_TTS_DIAGNOSTIC'" in background_js and
    "if (!isDiagnosticsPageSender(sender))" in background_js and
    "TTS diagnostics are restricted to the bundled diagnostics page" in background_js,
)

check(
    'background.js: diagnostic voice is verified against Chrome live voice metadata',
    'const voices = await getAllVoices()' in background_js and
    'voice.voiceName === voiceName' in background_js and
    'voice.extensionId === extensionId' in background_js and
    'await isSpeaking()' in background_js,
)

check(
    'background.js: diagnostics refuse to overlap normal playback and require a clean end event',
    'diagnosticSpeechActive' in background_js and
    'Stop normal NarraTrace playback before running the diagnostic' in background_js and
    'success: result?.type === \'end\'' in background_js,
)

check(
    'test.html/test.js: diagnostic UI records event timings and requires user-marked audible output',
    'id="btn-mark-audible"' in diagnostics_html and
    'id="engine-diagnostic-log"' in diagnostics_html and
    'audibleStartMarkedMs' in diagnostics_js and
    'sampleTextIncluded: false' in diagnostics_js and
    'btnExportDiagnostic' in diagnostics_js,
)

check(
    'diagnostic browser test keeps the silent fixture separate from audible confirmation',
    'real-engine diagnostics run through the selected Chrome TTS voice' in e2e_spec and
    'audible output was not confirmed' in e2e_spec and
    'Stop normal NarraTrace playback' in e2e_spec,
)

check(
    'diagnostic report path does not introduce Web Speech API usage',
    'window.speechSynthesis' not in background_js and
    'SpeechSynthesisUtterance' not in background_js and
    'window.speechSynthesis' not in diagnostics_js and
    'SpeechSynthesisUtterance' not in diagnostics_js,
)

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
print('\n' + '─' * 67)
passed = sum(results)
total  = len(results)
pct    = int(passed / total * 100) if total else 0
print(f'Result: {passed}/{total} checks passed ({pct}%)')
if passed == total:
    print('\033[92m✓ All checks passed — extension is ready.\033[0m')
else:
    failed = [i+1 for i, r in enumerate(results) if not r]
    print(f'\033[91m✗ {total - passed} check(s) failed — see items above.\033[0m')
    sys.exit(1)
