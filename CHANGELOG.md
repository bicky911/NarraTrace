# NarraTrace — Changelog

## Unreleased

### Added — accessibility and release readiness

- The floating playback progress controls are keyboard-operable: Arrow keys move
  by one sentence, Page Up/Down move by ten, and Home/End jump to the beginning
  or end. Both controls expose sentence position to assistive technology.
- Focus Reader is exposed as a modal dialog with a managed focus loop and focus
  restoration when it closes. Theme and playback controls expose their state.
- The popup exposes its playback/voice status through polite live regions and
  reports selected speed-chip and theme state accessibly.
- Add a standard-library release packager that validates Manifest V3 metadata,
  resolves local module/resource references, includes the license and diagnostics
  page, and excludes tests/docs/build artifacts from the distribution ZIP.
- CI now validates the release file set, builds the ZIP, and uploads it as an
  artifact with a SHA-256 sidecar.

### Corrected

- Refresh README test-count badges and clarify that Playwright is a development
  dependency only; the extension has no runtime npm dependencies.
- Add the MIT license file already referenced by the repository's license badge.

Personal-use Chrome MV3 extension that narrates web pages aloud with a local
neural TTS engine (Kokoro, Supertonic) or the Windows system voices, tracing
every word on screen as it speaks.

---

## 1.4.0 — 2026-11-17

**The extension is now NarraTrace.** "Read Aloud" described a category;
**NarraTrace** names this extension's two signature acts — it **narra**tes
the page aloud and **trace**s every word as the voice reaches it. Tagline:
*Narrates the page. Traces every word.*

### Renamed — the full brand pass

- **Store & browser identity**: the extension is listed as
  **"NarraTrace — Narrates & Traces Every Word"**; the toolbar tooltip reads
  *"NarraTrace — narrate this page aloud"*; keyboard commands are prefixed
  `NarraTrace:` in `chrome://extensions/shortcuts`.
- **Popup**: header lockup is now **NARRATRACE // NT·1** (the device mark
  succeeds RA·1) over the tagline *"Narrates the page · Traces every word"*.
- **On-page surfaces**: the Focus Reader brand line, update toast, and
  right-click menus (*"NarraTrace: narrate selection"*, *"NarraTrace:
  narrate from here"*) all carry the new name and its verbs.
- **New icon**: the generic purple speaker is replaced by the NarraTrace
  mark — a white **N** on near-black, struck through by the signal-orange
  (`#FF5C00`) trace diagonal ending in the tracking dot (16/48/128 px).
- **Docs & tooling**: README (with a brand section), manual test checklist,
  test pages, design preview (now NT·1), and helper scripts rebranded.

### Compatibility — nothing breaks on upgrade

- **Settings carry over**: invisible internal identifiers (`readAloud_*`
  storage keys, context-menu/alarm IDs, `ra-*` element IDs, `--ra-*` CSS
  tokens) intentionally keep their legacy names, so every saved voice,
  speed, theme, and pill preference survives the rename untouched.
- Entries below this one keep the name "Read Aloud" — they are the
  historical record of releases that shipped under it.

---

## 1.3.0 — 2026-11-09

**Kokoro TTS engine support**, a working page-zoom counter-scale, a resting
player that is a 6 px edge handle, and a position estimator that measures the
engine instead of guessing.

### Added — Kokoro TTS engine

- **The engine is no longer hard-coded to Supertonic.** `speech-engine.js` now
  carries a small table of known engines (`TTS_ENGINES`) and works with any
  extension that registers voices through `chrome.tts`. Kokoro
  (`mefecoigjodlohjacogkbbfpnifhfocb`) is preferred, Supertonic
  (`mdoplmghlkjcnegkdhocjbjcncocbdhk`) is the fallback, the Windows voices are
  the last resort.
- **28 Kokoro voices, grouped per engine.** The voice dropdown now shows one
  group per engine (`★ Kokoro (local neural)`, `★ Supertonic (local neural)`,
  `Windows System Voices`) and the popup badge names the engine that is
  actually speaking (`KOKORO`, `SUPERTONIC`, `SYSTEM`).
- **Kokoro Heart is the default voice.**
- **A legacy voice preference migrates.** Preferences saved before this change
  carried a Supertonic voice that was merely the old automatic default; they
  now move over to Kokoro. A voice the user picks explicitly is remembered
  (`voicePinned`) and never overridden — that is what keeps Supertonic usable
  as a deliberate fallback.
- **The voice is re-resolved when the engine registers.** An engine extension
  publishes its voices a moment after Chrome starts it, so the list is still
  empty when the service worker boots. `refreshVoice()` re-resolves on
  `chrome.tts.onVoicesChanged` and again right before the first utterance.

### Added — the group size follows the engine's real setup cost

- **Measured against the real Kokoro engine**: it rebuilds its ONNX model and
  its offscreen document for *every* utterance, which costs ~10 s on a
  CPU-only machine and ~24 s the very first time (while its 92 MB model
  downloads). One sentence per utterance would put that gap between every
  sentence.
- `resolveBatchSize()` now derives the group size from the engine's *measured*
  preparation time: the setup may cost at most ~15 % of the speech it
  precedes. A fast engine (Kokoro with WebGPU) gets short groups and stays
  responsive for skipping; a slow one gets long groups and reads almost
  seamlessly. `MAX_BATCH_SENTENCES` rose from 4 to 12, and the settings panel
  offers `8 — FEWEST GAPS` and `12 — LONGEST RUN` next to the existing choices.

### Fixed — long utterances were cut off and re-spoken

- **The watchdog measured the wrong thing.** It counted from the moment the
  request was accepted, so an engine that spends 10–32 s preparing its
  synthesis ate the speaking budget of a perfectly healthy utterance: the
  watchdog fired mid-sentence and the reader re-spoke the remainder, which
  sounds exactly like a stutter. The preparation now has its own (much
  longer) budget, and the speaking budget starts only once the engine has
  produced a real boundary.

### Fixed — the word highlight could drift away from the voice
- **The reading rate is learned from the *fastest* boundary interval.** A
  lead-in can only make an interval slower, never faster, so the fastest
  interval observed is the cleanest measurement. The `end` event contributes a
  sample too — for Kokoro the stretch from the last sentence boundary to the
  end is pure playback, which recovers the true reading speed even when its
  synthesis lags behind its own playback.
- **The lead-in correction is applied only where it exists.** Supertonic
  announces `start` and the first sentence boundary at the same instant and
  only becomes audible ~3.2 s later, so its first interval needs the
  correction. Kokoro announces the boundary when the sentence actually starts
  playing (~10 s after `start`), so the correction must *not* be applied —
  applying it made the highlight lag behind the voice.
- **The rate is stored per engine and relative to the rate slider.** The
  previous code kept one absolute rate, so changing the speed silently broke
  the highlight.
- **The estimator parks at the start of the utterance until the engine
  actually starts speaking**, instead of extrapolating from `start`.
- **The estimate never leaves the sentence the voice is in.** An engine that
  cannot synthesise as fast as it plays goes *silent* between sentences (the
  case on a CPU-only machine, where Kokoro's synthesis runs at ~5 chars/s
  while its audio plays at ~14 chars/s). The estimate used to run straight
  through that silence into the next sentence — measured 119 characters ahead
  at the boundary that followed such a gap. It now stops at the end of the
  current sentence until the engine reports the next one.

### Fixed — the floating bar grew with the page zoom

- **`getPageZoom()` was dead code.** It read `svg.currentScale` and
  `visualViewport.scale`; measured on Chrome 156/157 desktop, *neither follows
  browser page zoom* — both always return 1, so `--ra-page-zoom` was always 1
  and the counter-scale never fired.
- The page zoom now comes from Chrome itself: the background asks
  `chrome.tabs.getZoom()` (no extra permission required — verified) and the
  page derives the display scaling from `devicePixelRatio`, so the pill keeps
  the same physical size at any zoom level and on any display scaling.
  *Measured: the pill's physical width changes by 0.0 % between 100 % and
  150 % page zoom.*

### Changed — the player takes up almost no room

- **The resting state is the 6 px edge handle.** The collapsed player is now
  the default: a 6 px × 72 px vertical bar docked flush against the screen
  edge, exactly like the Samsung Galaxy S26 Ultra edge panel, with a glowing
  status LED. Click it to open the player.
- **The opened player is 48 × 34 px.** The `mini` layout is the new default:
  the status LED and the play button only. Hovering it unfolds the full
  control row (previous, play, next, speed, settings, collapse) exactly as
  before. The expanded bar went from 251 px to 48 px wide.
- The collapsed handle no longer inherits the "tucked into the screen border"
  transform, which would have pushed it off-screen.

### Fixed — the voice could stay on the wrong engine after a cold start

- **`chrome.tts` can be missing for the first moments of the worker's life.**
  Chrome creates the namespace shortly after it starts the service worker, so
  code that runs at module scope can see `chrome.tts === undefined` on a cold
  boot. The `onVoicesChanged` listener was registered inside a `try/catch`,
  which swallowed that error — and the listener was then never attached for the
  whole life of the worker. The consequence: the engine that registers late
  (Kokoro) never took over, and the reader silently stayed on the old voice.
- The worker now waits for the namespace (`waitForTtsApi()`) before attaching
  the listener, and `getAllVoices()` waits instead of throwing. An engine that
  registers late now reliably takes over, and the first voice resolution after
  a cold boot no longer comes back empty.

---

## 1.2.0 — 2026-11-06

Word-audio sync calibration, website zoom counter-scaling, Samsung Galaxy S26 Ultra Edge handle collapsed mode, and streamlined floating player.

### Fixed — Speech and word highlighting synchronization
- **Single-sentence utterance batching default**: Default batch size set to 1 sentence per TTS utterance, eliminating inter-sentence offset drift and acoustic desynchronization.
- **Chrome TTS API event length**: TTS event broadcasting in `playback-manager.js` now reads `event.length` (Chrome official property) and falls back to `event.charLength`.
- **Dynamic synthetic estimator grace delay**: Latency calibrated with voice-type awareness (1400ms delay for network/neural synthesis, 400ms for local speech engines) to ensure synthetic estimators do not advance before audio playback actually begins.
- **Punctuation isolation in DOM ranges**: `createSubRangeFromSentence()` trims leading opening quotes/brackets (`"'“‘([<«`) and trailing punctuation (`.,!?:;"'”’)]}»`) to isolate clean spoken words.

### Fixed — Website zoom scaling
- **CSS zoom counter-scaling**: Integrated SVG `currentScale` and `visualViewport.scale` inspection to expose `--ra-page-zoom`.
- **Hardware-accelerated inverse scaling**: Replaced native CSS `zoom` with `transform: scale(calc(var(--pill-scale, 1) / var(--ra-page-zoom, 1)))` so the floating pill and settings panel maintain consistent 1:1 physical pixel size across all browser zoom levels (e.g. 50% to 300%).

### Fixed — Samsung Galaxy S26 Ultra Edge handle (Collapsed state)
- **Ultra-thin 6px vertical edge bar**: Collapsed player now transforms into a 6px wide, 72px tall vertical edge panel docked flush against the screen margin.
- **Backdrop blur & glowing status LED**: Glassmorphic dark styling with subtle glowing vertical LED indicator.
- **Hover expansion & click-to-expand**: Expands to 18px on hover displaying directional chevron (`‹` / `›`), and restores smoothly to previous floating location on click.

### Fixed — Streamlined expanded player
- **Decluttered horizontal pill**: Removed redundant branding ("RA·1"), engine status labels, and secondary tools from the primary floating pill, reducing bar width by >45%.
- **Settings panel integration**: Moved Focus Reader and Stop actions into the settings panel while keeping playback controls (Previous, Play/Pause, Next, Speed, Settings, Collapse, and Progress scrub track) easily accessible.

Reliability hardening, word-by-word highlighting, and the removal of the
mid-reading pauses. Merges the Codex "gapmeter" and GLM "v4" work into the
canonical Desktop build.

### Fixed — the mid-reading pauses

- **`sentence-tokenizer.js` — a hard-wrapped paragraph was shredded into one
  "sentence" per HTML source line.** The tokenizer treated `\n` as a sentence
  terminator, so a paragraph that renders as one flowing block was queued as
  6-10 separate utterances, each one its own `chrome.tts.speak()` request with
  its own intonation restart. This is the single largest source of uneven
  pacing. Newlines are now ordinary whitespace, and all whitespace runs are
  collapsed to a single space before tokenizing.

- **`sentence-tokenizer.js` — dotted identifiers split sentences.**
  `"chrome.tts"` and `"chrome.storage.session"` were split at the dot. A dot
  between two word characters is no longer a boundary.

- **`speech-engine.js` — the watchdog could abandon a legitimate utterance.**
  A grouped utterance carries up to four sentences; measured against the real
  engine, a 499-character group took 34.5 s to speak, against a fixed 45 s
  cutoff. The watchdog now scales with both the reading rate *and* the
  utterance length (floor: 8 chars/s, the slowest sustained rate observed).

### Fixed — the context menu never appeared

- **`background.js` — `chrome.contextMenus.getAll()` does not exist.** The
  API surface is `create` / `update` / `remove` / `removeAll` only, so
  `setupContextMenu()` threw `TypeError: chrome.contextMenus.getAll is not a
  function` on every service-worker start, and the extension lost its
  right-click entries entirely. The menu is now created idempotently and the
  duplicate-id error is swallowed in the callback.

### Fixed — the highlights drifted

- **`content.js` — sentence and word ranges were computed against the raw DOM
  text while the spoken text was normalised.** With whitespace collapsed in
  the tokenizer, every newline and double space inside a sentence shifted the
  word offsets by one position, and a hard-wrapped paragraph failed to
  re-locate itself after a DOM mutation. The DOM mapper now indexes the same
  canonical text and maps every normalised offset back to its exact
  `(text node, offset)` pair.

- **`content.js` — the sentence-level fallback matched only the first 24
  characters**, producing a range that stopped in the middle of the sentence.
  It now matches the sentence word-by-word, tolerating any whitespace
  variation, and returns the full match.

### Added

- **Word-by-word highlighting.** A position estimator synthesises word events
  for engines that report none (Supertonic reports `start` / `sentence` /
  `end` only), driven by a measured characters-per-second rate. Native `word`
  events always take precedence when an engine provides them.

- **Sentence grouping.** A voice provided by another extension needs a fresh
  synthesis round-trip per utterance, so one sentence per utterance left dead
  air at every boundary. Consecutive sentences now share one request. New
  setting: **SENTENCE GROUPING** — `AUTO` (3 for network voices, 1 for local
  Windows voices), `1 — INSTANT`, `3 — SMOOTH`, `4 — SMOOTHEST`. Grouping is
  disabled automatically when a resume offset or a pronunciation rewrite would
  break the text↔offset mapping.

- **Service-worker keep-alive.** While playback is `PLAYING`, the worker pings
  a cheap extension API every 15 s. Extension-API calls reset the idle timer,
  and worker-side timers are never throttled the way hidden-tab timers are —
  this stops "the reading pauses a few moments after I switch tabs".

- **Tab pre-emption sync.** Starting playback in another tab tells the
  previous tab to reset its pill, so it no longer sits showing `PLAYING` while
  a different tab is the one speaking.

- **Update toast.** After the extension is reloaded, open pages show
  "Read Aloud was updated — refresh this page (F5) to reactivate it."

### Fixed — the hover-to-play button only worked on some pages

- **`content.js` — the hover button required a `<p>` or `<blockquote>`.**
  Social apps and many modern documentation sites (Medium, Reddit, X, Notion,
  most web apps) put body copy in plain `<div>` / `<span>` blocks, so the
  button never appeared there. Detection now has a second path: it climbs from
  the hovered node to the deepest ancestor holding 40–3000 characters of
  prose — the block a human perceives as "a paragraph" even when the site
  never uses `<p>`. The substance floor moved from 60 chars / 8 words to
  40 / 6, because a social post is shorter than an article paragraph.

- **`content.js` — the button fled the pointer on nested markup.** The block
  lookup ran from a different child node on every mouse move, so it kept
  returning a narrower inner block or a wider outer one and the button hopped
  between them; on a comment thread it could never be clicked. It is now
  sticky: once it is showing for a block it stays parked while the cursor
  moves inside that block, and across the same reading unit at a different
  nesting depth.

- **`content.js` — the button vanished mid-paragraph.** Moving between child
  nodes of the shown block fired `mouseout` and started the hide timer, so the
  button disappeared about 300 ms after you stopped moving — right before you
  tried to click it. Departures that stay inside the shown block are now
  ignored.

- **`content.js` — the button could pop up directly under the cursor,** which
  steals the hover (the page sees `mouseout` → shadow host) and produced a
  hide/re-show flicker loop. If a placement would land under the pointer it is
  nudged one line away once, at placement time.

### Changed

- **The hover button now sits inside the paragraph's left edge**, vertically
  aligned with the line you are actually hovering, instead of in the left
  gutter. It renders at 45 % opacity and goes solid when the pointer is on it,
  so the characters it overlaps stay readable. Click-to-start, the 350 ms
  dwell and the Teenage Engineering square are unchanged.

- **Speed, volume and pitch sliders are debounced (200 ms).** Every change
  restarts the current utterance; an un-debounced drag restarted it dozens of
  times per drag. The readout still updates live.
- **Hover-play button 22 → 26 px** — a 22 px hit target was hard to click.
- **`desiredEventTypes` now includes `sentence`.** Without it Chrome never
  delivers the engine's sentence boundaries, which the grouped-utterance
  mapping needs.
- Manifest version `1.0.0` → `1.1.0`.

### Notes on the Supertonic engine

Measured against the real engine (Chrome 156, Supertonic 2.0.0):

| Observation | Value |
|---|---|
| First utterance after the engine wakes | 2.3 – 4.5 s (model warm-up) |
| Every later utterance | **5 – 10 ms** |
| Boundary gap between grouped utterances | **1 – 2 ms** |
| Speaking rate | ~13.5 – 14.5 chars/s (8 chars/s while warming up) |

`chrome.tts.speak({ enqueue: true })` does **not** pre-warm the engine: Chrome
only calls the engine's `onSpeak` when the queued utterance is dequeued, so
queueing one utterance ahead changes nothing. The dead air was never the
request pattern — it was the tokenizer shredding paragraphs into one request
per source line, plus the engine's own cold start.
