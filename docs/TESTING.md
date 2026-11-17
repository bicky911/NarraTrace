# NarraTrace testing

NarraTrace has three dependency-free automated test layers.

## Requirements

- Node.js 22 or newer
- Python 3.10 or newer

No npm packages are installed. package.json only declares the module format, scripts, and minimum Node version; the tests use Node's built-in test runner.

## Run the tests

JavaScript syntax validation: npm run test:syntax

Focused runtime/unit tests: npm test

Existing source-structure checks: npm run test:static

All three layers: npm run test:all

## Coverage

The unit suite currently exercises:

- Sentence whitespace normalization, decimal punctuation, Indic terminators, and chunk limits
- Bengali/Hindi script detection and voice matching
- Playback queue sanitation and pronunciation rules
- Pitch-change resume offsets
- Service-worker recovery when an orphaned utterance is still active
- Persistence of deferred recovery state across session save/restore
- Mapping spoken-word offsets back to original text after punctuation/prosody changes
- Safe sentence-level fallback when semantic cleanup or pronunciation rules change word tokens
- Per-engine lead-in calibration for Supertonic, Kokoro, and system voices

The Python source harness also guards the content-script runtime: zoom updates are
event-driven rather than continuously polled, unchanged zoom values do not cause
repeated style writes, and DOM mutation repair is scheduled only when the active
highlight range is detached or its text is changed.

The architecture/security checks also cover a narrow playback-options allow-list,
finite numeric ranges, bounded voice metadata, defensive session restoration,
and a capped pronunciation dictionary (32 KiB / 128 rules). Full session-storage
inspection is restricted to the extension's bundled `test.html` diagnostics page;
the unused direct `SPEAK_TEXT` route has been removed from the production router.

The Python harness remains useful for source-level invariants and markup checks. It is not a substitute for running the extension in Chrome.

## Browser and real-engine verification

The automated tests do not prove that Chrome's TTS providers behave correctly on a particular device, nor do source checks measure page-level CPU cost. Before a release, also follow docs/MANUAL-TEST-CHECKLIST.md with each supported engine. Include the dynamic-page and browser-zoom checks, and record the Chrome version, operating system, engine version, and result when reporting an engine-specific defect.


## Word-alignment behavior

Word-level highlighting is used only when every spoken word can be mapped one-to-one to the original sentence. Punctuation and spacing changes are mapped by word spans. If cleanup removes words (for example, citations or URLs) or a pronunciation rule replaces words, NarraTrace deliberately falls back to sentence-level highlighting for that utterance rather than drawing an incorrect word capsule.
