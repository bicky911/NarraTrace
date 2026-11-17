# NarraTrace — Narrates the Page. Traces Every Word.

> **Narra**te + **Trace**: NarraTrace narrates any web page aloud with local neural voices — and traces every word on screen as it speaks, so your eyes and ears never lose their place.

A world-class, privacy-first Manifest V3 Chrome Extension providing synchronized text-to-speech with spring-physics word tracking, Focus Reader mode, and multi-engine speech synthesis. *(Renamed from "Read Aloud" in 1.4.0 — same extension, same settings; existing preferences carry over untouched.)*

---

## 🏷️ The Brand

* **Name:** **NarraTrace** — the name *is* the feature list. **Narra-** = it narrates the page aloud. **-Trace** = it traces each word with a luminous capsule as the voice reaches it.
* **Tagline:** *Narrates the page. Traces every word.*
* **Device mark:** **NT·1** — the hardware-style model badge carried in the popup and Focus Reader, in the Teenage Engineering-inspired design language.
* **Icon:** a white **N** struck through by the signal-orange trace diagonal (`#FF5C00` on near-black `#0F0F0F`) — the path of the voice cutting across the letter, ending in the tracking dot.
* **Voice of the brand:** controls and menus say what NarraTrace does — *"NarraTrace: narrate selection"*, *"NarraTrace: narrate from here"* — never a generic "read".

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Manifest: V3](https://img.shields.io/badge/Manifest-V3-orange.svg)
![Static checks: 86](https://img.shields.io/badge/static%20checks-86-brightgreen.svg)
![Behavioural tests: 76](https://img.shields.io/badge/behavioural%20tests-76-brightgreen.svg)

---

## ✨ Key Features

* **Spring-Physics Word Capsule:** Hooke's Law damped harmonic oscillator engine ($k=220, d=24$) with kinetic velocity-based squish and zero idle CPU cost.
* **Focus Reader Mode:** Distraction-free reading overlay with curved inline sentence flow (`box-decoration-break: clone`), luminous word capsules, and a floating glassmorphic control bar.
* **Magnetic Edge-Docking Pill:** Draggable floating player pill with $20\text{px}$ boundary proximity detection. Snaps and animates into a sleek $24\text{px}$ vertical bead hugging the display bezel.
* **Golden Gaze Auto-Scroll:** Friction-damped critically stable viewport tracking that locks the active reading sentence at the natural biomechanical sight line ($38\%$ from viewport top).
* **Context-Aware Prosody Pauses:** Intelligent clause-boundary cadence detection that inserts natural human breathing pauses at em-dashes, semicolons, colons, ellipses, and lists.
* **Semantic Noise Stripper:** Cleans citations (`[1]`, `[citation needed]`), academic parentheticals (`(Smith et al., 2024)`), raw URLs, DOIs, and markdown symbols before TTS without mutating DOM highlights.
* **Multi-Engine Speech Support:** High-priority Piper local neural TTS extension integration, Supertonic, Kokoro, and native Chrome TTS voices.
* **Multilingual Script Routing:** Auto-detects Bangla (বাংলা), Hindi (हिन्दी), and Latin scripts, routing each to native neural voices.
* **100% Shadow DOM Encapsulated:** Complete style isolation guarantees the player never clashes with host website styles.

---

## 🚀 Installation & Local Development

1. Clone this repository:
   ```bash
   git clone https://github.com/bicky911/NarraTrace.git
   ```
2. Open Google Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in top-right corner).
4. Click **Load unpacked** and select this directory.
5. Pin the extension to your toolbar.

---

## 🧪 Quality Gates

Three independent gates, all runnable offline with no dependencies:

```bash
npm test          # 76 behavioural tests on Node's built-in runner
npm run lint      # package integrity: manifest, permissions, API allowlist, message wiring
python3 test-harness.py   # 86 static structural checks (calibration invariants)
npm run check     # all three gates in one command

# Optional: boot the real content script in a DOM (needs jsdom, not shipped)
npm install --no-save jsdom && npm run test:dom
```

* **Behavioural tests (`tests/`)** drive the real modules against a controllable
  fake `chrome.tts`: the tokenizer, the speech pipeline, voice resolution, the
  playback state machine, pause/resume offsets, error budgets, preference
  persistence and batch grouping. They catch regressions that string matching
  cannot see.
* **The linter (`tools/lint.js`)** proves the package is coherent: every file
  the manifest references exists, every declared permission is actually used,
  the content script stays inside its `runtime`/`storage` allowlist, no
  forbidden web-speech, `eval` or remote-code API appears, every runtime
  message has a handler, and the version agrees across manifest, package and
  changelog.
* **The optional DOM smoke test (`tools/dom-smoke.mjs`)** injects the exact
  manifest order into jsdom and asserts that the player, settings panel, voice
  picker, Focus Reader dialog and SPA handling all wire up without throwing.
* **The static harness (`test-harness.py`)** pins the measured calibrations
  (spring constants, gaze anchor, watchdog split, prosody rules) and the
  accessibility contract (labels, focus rings, progressbar state).

The engineering standard behind these gates — defect ledger, prioritised
backlog, definition of done and known limitations — is documented in
[`docs/QUALITY-STRATEGY.md`](docs/QUALITY-STRATEGY.md).

New contributors should run `npm run check` before opening a pull request.

---

## 📄 Architecture & Rules

* **Plain JavaScript MV3:** Zero bundlers, zero npm dependencies, and no node_modules.
* **Zero External Analytics or Trackers:** Runs 100% locally on your browser.
* **Accessible (WCAG AA Compliant):** Full keyboard focus rings (`#FF5C00`), ARIA attributes, and high-contrast color palettes.
* **Legacy internal identifiers:** Invisible plumbing (`readAloud_*` storage keys, `ra-*` element IDs, `--ra-*` CSS tokens) deliberately keeps its pre-rename names so upgrading users keep every saved voice, speed, and theme setting. Only what the user can see is branded NarraTrace.
