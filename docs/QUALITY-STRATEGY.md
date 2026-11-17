# NarraTrace — Quality Strategy

**Status:** adopted 1.5.0 (2026-11-17)
**Scope:** correctness, performance, accessibility, privacy, testability and
release discipline for a zero-dependency Manifest V3 extension.

---

## 1. What "world-class" means here

The phrase is only useful if it is measurable. For NarraTrace, a release is
world-class when all five of these are true:

1. **Nothing is announced before it is verified.** Every claim in the README —
   86 static checks, a test suite, a linter — runs offline and fails loudly.
2. **Failure is designed, not discovered.** Engine timeouts, dead service
   workers, closed tabs, DOM re-renders and missing `chrome.tts` namespaces
   each have a written recovery path.
3. **Audio is never doubled and never orphaned.** One utterance at a time, and
   a stop that really stops.
4. **Reading is accessible.** Keyboard-only operation, visible focus,
   `aria-*` state, reduced-motion support, and no motion that fights the page.
5. **The extension asks for the least it can.** Five permissions, no host
   permissions, no analytics, no remote code, no network access of its own.

Anything that cannot be checked mechanically gets a manual checklist item with
an observable expected result.

---

## 2. The six quality pillars

### 2.1 Correctness — fix the cause, not the symptom

**Practice:** every user-visible bug gets a minimal reproduction, a root-cause
note in the changelog, and a regression test at the lowest layer that can hold
it.

The 1.5.0 pass found and fixed eight defects this way, several of which had
survived earlier releases because the static harness only proved that *code
existed*, not that it *behaved*:

| Symptom | Root cause | Regression test |
|---|---|---|
| The voice stutters after "Dr." / "et al." / "U.S." | tokenizer split on abbreviations before a capital | `tests/tokenizer.test.js` |
| A stall became two voices at once | watchdog resolved without stopping the engine | `tests/speech-engine.test.js` |
| Reading stopped by itself in a SPA | `tabs.onUpdated` treated `changeInfo.url` as navigation | `tests/regression-pins.test.js` |
| Clicking the progress bar while paused resumed audio | `jumpToIndex()` forced `PLAYING` | `tests/playback-manager.test.js` |
| Audio outlived a closed tab | `reset()` cleared the queue without silencing TTS | `tests/playback-manager.test.js` |
| `C++ = see plus plus` did nothing | trailing `\b` cannot follow `+` | `tests/playback-manager.test.js` |
| English sentences with one Bangla word read in Bangla | "any native character wins" routing | `tests/speech-engine.test.js` |
| Word capsule disappeared after an in-place re-render | DOM repair re-applied only the sentence highlight | manual §8.9 + `npm run test:dom` |

**Rule:** a bug is not closed until the failing test exists and passes.

### 2.2 Performance — budget the main thread and the storage layer

- **Per-word work is O(1) after the first word.** The word capsule caches its
  Range→offset index per sentence instead of walking text nodes ~22 times a
  second.
- **Per-sentence persistence is O(1).** The queue lives in its own session key;
  only the small state object is rewritten as reading advances. (Previously a
  5,000-sentence paper rewrote ~500 KB into session storage every sentence.)
- **Idle cost is zero.** The spring loop parks when settled; the zoom poll
  skips hidden tabs and writes only on change; the keep-alive timer exists
  only while PLAYING.
- **Extraction is bounded.** Readability runs on a clone only below a 5 MB
  document cap, is attempted once per queue (`rangeMapAttempted`), and never
  re-runs per sentence.

**Budgets to hold:** tokenizing 4,000 sentences < 1 s (test enforces < 1,000 ms);
first spoken word is bounded by the engine, not by us; no measurable idle CPU
when stopped.

### 2.3 Accessibility — WCAG AA is a testable contract

- Every icon button has an `aria-label`; interactive state is reflected in
  `aria-pressed` / `aria-valuenow`.
- Focus rings use signal orange at 2 px with offset; reduced-motion users get
  instant positioning instead of springs and gaze scrolling.
- The reader and pill are keyboard reachable (Alt+R, Alt+←/→, Alt+P, Alt+X).
- The Focus Reader is a true modal dialog: named, `aria-modal`, hidden with
  `visibility` while closed (so it cannot be tabbed into or read behind the
  page), focus moved in and trapped, and focus returned on close.
- Colour is never the only signal: the status LED changes shape/animation, and
  the progress bar exposes a numeric value.

The static harness enforces the label/focus/role contract; the manual checklist
covers screen-reader announcements, which no headless test can judge.

### 2.4 Privacy & security — least privilege

- No analytics, no telemetry, no remote code, no `eval`, no network calls.
- Content script API allowlist: `chrome.runtime` and `chrome.storage` only —
  enforced by the linter, not by convention.
- No `host_permissions`; the declarative content script already covers
  `<all_urls>`. The unused `scripting` permission was removed in 1.5.0.
- TTS text never leaves the browser: it goes to `chrome.tts`, which routes to
  a locally installed engine extension.

### 2.5 Testability — three layers, each answering a different question

| Layer | Question it answers | Command |
|---|---|---|
| Behavioural suite (`tests/`) | Does the state machine do what we claim? | `npm test` |
| Package linter (`tools/lint.js`) | Is the package coherent and minimal? | `npm run lint` |
| Static harness (`test-harness.py`) | Are the measured calibrations still present? | `python3 test-harness.py` |
| DOM smoke test (`tools/dom-smoke.mjs`) | Does the real content script boot and wire its UI? | `npm install --no-save jsdom && npm run test:dom` |

The DOM smoke test is **optional on purpose**: shipping remains zero-dependency,
but a maintainer can boot the exact manifest injection order in jsdom and check
18 assertions about shadow-DOM construction, accessibility wiring, queue
building, the Focus Reader dialog and SPA navigation. It has already earned its
keep: it caught a missing null guard in the voice-picker response and a focus
restoration that landed on a hidden element.

The behavioural suite runs on Node's built-in runner with a fake `chrome.tts`
that can complete an utterance automatically or emit every event by hand. It
covers the tokenizer, speech engine, voice resolution, playback state machine,
error budgets, pause/resume offsets, storage migration and batch grouping —
76 tests in under a second, no dependencies, no browser.

### 2.6 Release discipline

- **Version agreement:** manifest = package.json = top CHANGELOG heading; the
  linter fails the build otherwise.
- **Changelog explains "why":** each entry names the symptom, the cause and the
  fix, because the next maintainer is usually future-you.
- **Compatibility first:** legacy storage keys (`readAloud_*`), element ids
  (`ra-*`) and session layouts are migrated, never renamed. 1.5.0 still reads a
  1.4.x inline session queue.
- **Every release has a manual listening pass.** Audio quality and "feel" are
  not provable in CI.

---

## 3. What changed in 1.5.0

Implemented and verified in this release:

- Tokenizer: titles, Latin markers, dotted acronyms, ellipses, closing quotes.
- Speech engine: single-settle promises, watchdog that stops before resolving,
  guarded `chrome.tts` access, event suppression after settle.
- Playback: stale-batch event guard, estimator armed at request time, paused
  seek stays paused, numeric option guards, orphan-safe reset/recovery,
  split session storage, legacy session migration.
- Content script: TDZ-safe shadow root, hover button geometry, cached range
  index, change-only zoom writes, context-menu selections now highlight,
  keyboard-complete Focus Reader dialog.
- Background: same-document navigation no longer stops playback.
- Popup: rebuilds the voice list when the engine changes; surfaces speech
  errors instead of leaving a stale sentence.
- Package: unused permission removed, `minimum_chrome_version` declared,
  zero-dependency `package.json`, linter, behavioural suite, this document.

---

## 4. Prioritised backlog

Ordered by user impact ÷ risk. Each item has an observable acceptance test.

### P0 — decision required

0. **Reconcile the settings UI with its wiring.**
   `ra-pitch-range`, `ra-batch-select`, `ra-pron-textarea`, `ra-scale-range`
   and `ra-opacity-range` are fully wired in `content.js` (and the worker
   implements `SET_PITCH`, `SET_BATCH_SIZE`, `SET_PRONUNCIATIONS`), but the
   controls were deliberately removed from the streamlined settings panel —
   the static harness pins their absence. The result is that sentence
   grouping, pronunciation overrides, pitch, player size and opacity are
   unreachable in the UI, while their storage keys still load and apply.
   *Options:* (a) expose them behind a collapsed **Advanced** disclosure and
   relax the harness check, or (b) delete the wiring and the storage keys.
   *Recommendation:* (a) — the backend is already tested and users who want a
   longer run between gaps currently have no way to ask for it.

### P1 — next release

1. **Persist engine profiles across worker restarts.**
   `prepareMs`, `baseCharsPerSecond`, `leadInMs` and `starving` currently live
   in memory, so a worker restart re-learns them (and can re-introduce a
   highlight lag for the first utterance). Store per-extension-id profiles in
   `chrome.storage.local`.
   *Acceptance:* after a forced worker restart, the first utterance does not
   extrapolate the highlight before the engine's measured preparation window.

2. **Accurate pause offsets through rewritten text.**
   Pause/resume uses the last word's char index, but noise stripping and
   prosody change the spoken length. Build a spoken→source offset map per
   sentence and clamp the resume point to a word boundary in the source text.
   *Acceptance:* pausing a sentence containing `[1]` and parentheses resumes on
   the same word, not one or two words later.

3. **Observe same-document navigation from the worker.**
   The content script relies on `popstate`, the Navigation API and a
   `pushState` wrapper that an isolated world cannot guarantee to intercept.
   Add a low-frequency URL check while a queue is live (or `webNavigation`
   with `--filter`-style scoping) so stale ranges are always dropped.
   *Acceptance:* on a router that only calls `history.pushState`, the old
   highlight disappears within 500 ms.

4. **Popup/side-panel continuity.**
   Closing the popup does not stop playback (correct), but the popup loses the
   current sentence until reopened. A `chrome.storage.session` read on open
   fixes the flash of "Ready to read".

### P2 — quality hardening

5. **Screen-reader pass for the reader overlay.** Add `aria-live="polite"` to
   the reader's current-sentence region behind a setting, and verify with NVDA
   and VoiceOver that announcements do not double with TTS.
6. **Speaker-level highlight drift telemetry (local only).** Count
   `|estimate - boundary|` samples in memory and expose them in the settings
   panel as a calibration readout. No network, no persistence by default.
7. **Per-engine voice lists in the settings panel.** The panel shows a single
   `<select>`; grouping by engine (as the popup does) removes a class of
   "wrong engine" confusion.
8. **`chrome.storage.session` quota guard.** If the persisted queue exceeds a
   threshold, store a head slice plus a re-extraction hint instead of silently
   dropping sentences.

### P3 — product expansion

9. **Full keyboard remapping** through `chrome.commands` (user-visible in
   `chrome://extensions/shortcuts`) and a "skip to heading" command.
10. **Reading modes by content type** (code blocks, tables) with extraction
    rules per mode rather than one cascade.
11. **TTS preview button** in the settings panel so a voice choice can be
    auditioned without starting a page read.
12. **Localisation scaffolding** (`_locales`) for the UI strings while keeping
    the multilingual TTS routing unchanged.

---

## 5. Definition of done

A change is complete when:

- [ ] The behaviour is described by a failing test that now passes (or a
      regression pin when a DOM harness is disproportionate).
- [ ] `npm run check` is green: 76 behavioural tests, 86 static checks, zero
      lint errors.
- [ ] The changelog entry names the symptom and the cause, not just the diff.
- [ ] No new permission, remote code, dependency or `chrome.*` namespace was
      added without a line in this document explaining why.
- [ ] Accessibility invariants still hold: labels, focus rings, reduced motion,
      ARIA state.
- [ ] The manual checklist item with an observable expected result exists.
- [ ] Version numbers agree across manifest, package and changelog.

---

## 6. Known limitations (deliberate, documented)

- **Pause offsets through rewritten text** (P1-2 above) can drift by the number
  of characters noise stripping removed earlier in the sentence.
- **Engine timing profiles are per worker lifetime**, so a cold start can show
  a brief highlight lag on slow engines.
- **Kokoro ignores `pitch`**; the UI still offers it because other engines
  honour it.
- **Pause/resume is implemented as stop + re-speak from an offset**, because
  the Kokoro and Supertonic engines implement neither `onPause` nor `onResume`.
- **The extension cannot read `chrome://` pages or the Chrome Web Store**;
  those tabs fall back to the popup's error path by design.
- **Five implemented features have no UI** (P0 above): pitch, sentence
  grouping, pronunciation overrides, player size and player opacity. They are
  reachable only through storage and are therefore listed as a product gap,
  not a hidden feature.
- **Engine profiles are learned per worker lifetime** and reset on a cold
  start; the first utterance after a restart can briefly trail the voice.
