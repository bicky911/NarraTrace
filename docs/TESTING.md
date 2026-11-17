# NarraTrace testing

NarraTrace has four automated verification layers. The Node and Python layers use standard-library tooling; the browser layer uses a pinned development-only Playwright dependency.

## Requirements

- Node.js 22 or newer
- Python 3.10 or newer
- Playwright Chromium for browser integration tests

The extension has no runtime npm dependencies. The only npm development dependency is Playwright, used to load the unpacked MV3 extension in Chromium during CI and local end-to-end testing.

## Run the tests

JavaScript syntax validation: npm run test:syntax

Focused runtime/unit tests: npm test

Existing source-structure checks: npm run test:static

All syntax, unit, and source-check layers: npm run test:all

Validate required extension files and imports: npm run package:check

Build a clean release ZIP and SHA-256 sidecar: npm run package:build

## Browser integration tests

Playwright runs the unpacked extension in its own Chromium persistent context.
The suite uses a local-only article server and a separate silent TTS-engine
fixture that emits deterministic Chrome word events; it does not produce audio,
call a speech API, or contact an external website.

Install the pinned browser-test dependency and Chromium once:

```sh
npm install
npx playwright install chromium
```

Run the browser tests:

```sh
npm run test:e2e
```

The integration suite verifies content-script injection, popup-to-tab messaging,
the session-inspection and real-engine diagnostics permission boundaries, active-playback exclusion in both directions, diagnostic event collection/export, invalid playback-control rejection,
Chrome TTS word-event delivery and word-capsule rendering, active sentence-range
recovery after the containing paragraph is replaced, and extraction of a large
local article.

The large-article test records queue size, extraction latency, JavaScript heap
usage, and browser task duration in the CI log. Its thresholds are smoke-test
guardrails, not a cross-machine performance benchmark. A synthetic TTS engine
proves the browser event pipeline; it does not replace audible tests with the
real Kokoro, Supertonic, Piper, and system engines.

## Real-device TTS diagnostics

Open the bundled page at `chrome-extension://YOUR_EXTENSION_ID/test.html` in the Chrome profile where the unpacked extension is loaded. The page records browser/provider metadata and the Chrome TTS event timeline, supports a manual first-audio mark, and exports a JSON report without storing the sample text. The report is an actual audible pass only when Chrome returns an `end` event and the tester clicks **I Hear Audio** during speech. See docs/DEVICE-DIAGNOSTICS.md for the exact Windows procedure.

The diagnostic action is restricted to the bundled extension page, validates the voice against Chrome's current voice list, and refuses to overlap active playback. The Playwright fake engine verifies event collection/export and the security guards; it remains silent and cannot verify real audio.

## Coverage

The unit suite currently exercises:

- Sentence whitespace normalization, decimal punctuation, Indic terminators, and chunk limits
- Bengali/Hindi script detection and voice matching
- Playback queue sanitation and pronunciation rules
- Piper/Kokoro/Supertonic priority, dynamic Piper IDs, unknown-provider grouping, and system-voice fallback
- Chrome TTS request options, provider error events, API callback errors, and empty-text handling
- Pitch-change resume offsets
- Service-worker recovery when an orphaned utterance is still active
- Persistence of deferred recovery state across session save/restore
- Mapping spoken-word offsets back to original text after punctuation/prosody changes
- Safe sentence-level fallback when semantic cleanup or pronunciation rules change word tokens
- Per-engine lead-in calibration for Supertonic, Kokoro, and system voices

The Python source harness also guards the content-script runtime: zoom updates are
event-driven rather than continuously polled, unchanged zoom values do not cause
repeated style writes, and DOM mutation repair is scheduled only when the active
highlight range or its owning block is invalidated, or its text is changed. The
observer also detects removal of a descendant block containing the active
sentence when a live Range has been auto-adjusted to an attached ancestor.

The architecture/security checks also cover a narrow playback-options allow-list,
finite numeric ranges, bounded voice metadata, defensive session restoration,
and a capped pronunciation dictionary (32 KiB / 128 rules). Full session-storage
inspection is restricted to the extension's bundled `test.html` diagnostics page;
the unused direct `SPEAK_TEXT` route has been removed from the production router.

The manifest no longer requests the unused `scripting` permission. Static content
scripts already provide the page integration, while the `<all_urls>` match remains
necessary for the stated “read any webpage” behavior.

The Python harness remains useful for source-level invariants and markup checks. It is not a substitute for running the extension in Chrome.

## Browser and real-engine verification

The release builder discovers the manifest's entry points, follows local JavaScript imports and HTML/CSS resources, verifies every referenced file exists, includes the diagnostics page and license, and excludes development-only files. The ZIP and SHA-256 sidecar are generated under `dist/`.

The automated tests do not prove that Chrome's TTS providers behave correctly on a particular device, nor do source checks measure page-level CPU cost. Before a release, follow both docs/MANUAL-TEST-CHECKLIST.md and docs/REAL-ENGINE-VALIDATION.md with each supported engine. Include the dynamic-page and browser-zoom checks, and record the Chrome version, operating system, engine version, selected voice/model, and result when reporting an engine-specific defect. The real-engine matrix is a manual release gate because CI's synthetic TTS provider does not produce audio.


## Word-alignment behavior

Word-level highlighting is used only when every spoken word can be mapped one-to-one to the original sentence. Punctuation and spacing changes are mapped by word spans. If cleanup removes words (for example, citations or URLs) or a pronunciation rule replaces words, NarraTrace deliberately falls back to sentence-level highlighting for that utterance rather than drawing an incorrect word capsule.
