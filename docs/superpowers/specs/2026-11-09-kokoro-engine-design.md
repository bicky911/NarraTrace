# Design — Kokoro TTS engine support

**Date:** 2026-11-09
**Status:** approved by user (default voice: Kokoro Heart; Supertonic kept as fallback; adaptive batching)

## Problem

The user installed the **Kokoro TTS Engine** extension (`mefecoigjodlohjacogkbbfpnifhfocb`, v0.1.0)
and wants Read Aloud to use it instead of Supertonic (`mdoplmghlkjcnegkdhocjbjcncocbdhk`).

Read Aloud was written against Supertonic specifically: `speech-engine.js` hard-codes
`SUPERTONIC_EXTENSION_ID`, the UIs group voices under a "★ Supertonic" heading, and the
position estimator in `playback-manager.js` was tuned to Supertonic's timing.

## Measured facts (real Chrome 156, real Kokoro 0.1.0)

Verified with `Documents/read-aloud-e2e/probe_kokoro.py`.

| Observation | Supertonic (2.0.0) | Kokoro (0.1.0) |
|---|---|---|
| Voices visible to another extension | only while its host tab is open | **always** — all 28, via `chrome.tts.getVoices()` |
| `chrome.tts.getVoices()` groups | Supertonic + Google component + system | Kokoro + Google component (system voices absent on this machine) |
| Events emitted | `start`, `sentence`, `end` | `start`, `sentence`, `end` — **no `word`** |
| `sentence` event `charIndex` | character offset into the utterance | character offset into the utterance (52, 108, 164, 211, 270 — exactly our own offsets) |
| Time from `start` to first audible word | ~3.2 s (network round-trip) | **~10 s per utterance** (re-creates its ONNX model + offscreen document every utterance) |
| Cold start | — | ~24 s (92 MB model download, once) |
| Speaking rate | ~15 chars/s | ~14 chars/s audio; synthesis on CPU-only wasm is *slower* than playback (~5 chars/s), which starves the audio and produces audible gaps |
| `rate` / `volume` | honoured | honoured (`audio.playbackRate`, `audio.volume`) |
| `pitch` | honoured | **ignored** — Kokoro's engine passes only rate and volume to the offscreen document |
| Pause / resume | engine supports `onPause`/`onResume` | engine implements neither — `chrome.tts.pause()` would be a no-op |

Two consequences drive the whole design:

1. **Kokoro's ~10 s per-utterance setup is the new source of dead air.** With one sentence
   per utterance the reader would hear a 10-second gap between every sentence — the exact
   symptom the Supertonic work was meant to remove.
2. **Kokoro's `sentence` event is a trustworthy anchor** (it fires at the start of that
   segment's playback), so the existing estimator architecture works — but the estimator's
   Supertonic-specific "lead-in" correction must not be applied to Kokoro, or the highlight
   would run behind the voice.

## Design

### 1. Engine registry (`speech-engine.js`)

Replace the Supertonic special-case with a table of known engines:

```js
export const TTS_ENGINES = [
  { id: 'mefecoigjodlohjacogkbbfpnifhfocb', label: 'Kokoro',
    fullLabel: 'Kokoro (local neural)', badge: 'KOKORO',
    defaultVoice: 'Kokoro Heart', priority: 10 },
  { id: 'mdoplmghlkjcnegkdhocjbjcncocbdhk', label: 'Supertonic',
    fullLabel: 'Supertonic (local neural)', badge: 'SUPERTONIC',
    defaultVoice: null, priority: 20 }
];
```

`detectAndSelectVoice()` becomes engine-agnostic and returns:

```
{ selectedVoice, statusMessage, engineId, engineLabel, engineBadge,
  engines: [{id,label,badge,voices}],   // every extension engine with voices
  engineVoices, localSystemVoices, otherVoices, allVoices }
```

**Selection rule — engine priority wins, the saved voice decides inside the winning engine:**

1. The best engine = the highest-priority engine that has voices.
2. If the saved preference belongs to *that* engine → keep it.
3. Otherwise → that engine's `defaultVoice` if it exists, else its first voice.
4. No extension engine at all → an English system voice, then any system voice, then any voice.

**Migration.** Preferences gain an `engineId` field. Legacy preferences (saved before this
change) have a `voiceName` + `extensionId` but no `engineId`; those are migrated once to the
best engine, because the old default was always Supertonic. Once `engineId` is stored the
user's explicit choice is respected forever — that is what keeps Supertonic usable as a
fallback.

`chrome.tts.speak` already receives `extensionId` from the selected voice, so routing to
Kokoro needs no new plumbing — but the value must be the **engine** id, not the voice's
`lang`.

### 2. Per-engine profile + adaptive batching (`playback-manager.js`)

A profile is kept per engine id (`Map`), so switching engines never mixes measurements:

```
{ prepareMs, baseCharsPerSecond, leadInMs, boundariesSeen, utterancesSeen }
```

**Adaptive batch size** (`resolveBatchSize`, used when the user has not set one):
`prepareMs` is the measured time from the engine's `start` event to its first boundary —
the engine's setup cost. The batch is sized so that setup costs at most ~15 % of the
speech time it precedes:

```
speechPerSentence ≈ 65 chars / baseCharsPerSecond
sentences ≈ (prepareMs / 0.15) / speechPerSentence      clamped to [1, 12]
```

With the measured CPU numbers (prepare 10 s, 14 chars/s) this yields 12 sentences per
utterance — one 10 s setup per ~55 s of speech instead of one per sentence. On a WebGPU
machine with a ~1 s setup it yields 2 sentences, i.e. the reader gets a responsive skip
without paying a setup per sentence. The user can still override the group size by hand.

`MAX_BATCH_SENTENCES` rises from 4 to 12.

### 3. Estimator corrections (`playback-manager.js`)

The estimator keeps its architecture (anchor on the engine's boundaries, extrapolate at the
measured rate) but three things change:

* **Rate is stored per engine and relative to the rate slider.** `baseCharsPerSecond` is the
  measured rate at 1.0×; the effective rate is `base × options.rate`. The previous code stored
  an absolute rate, so changing the speed slider silently broke the highlight.
* **The rate is learned from the *fastest* boundary interval.** A lead-in can only make an
  interval slower, never faster, so the fastest observed interval is the cleanest
  measurement. The `end` event contributes a sample too: for Kokoro the interval from the
  last `sentence` event to `end` is pure playback, which recovers the true speaking rate
  even when synthesis lags behind playback.
* **The lead-in correction is applied only when it exists.** The engine announces a boundary
  *before* the speech starts (Supertonic: `start` and `sentence(0)` arrive together, the
  voice starts ~3.2 s later). That is detected by measuring the delay between `start` and
  the first boundary: below 500 ms the correction applies, above it the boundary already
  marks audible speech (Kokoro: ~10 s) and no correction is made.

Until the first boundary arrives the highlight parks at the start of the utterance instead
of extrapolating — an engine that is still preparing has not spoken anything yet.

### 4. User interface (`popup.js`, `content.js`)

* The engine badge shows the active engine (`KOKORO`, `SUPERTONIC`, `SYSTEM`).
* The voice dropdown is grouped per engine: `★ Kokoro (local neural)`, `★ Supertonic
  (local neural)`, `Windows System Voices`. The ★ engine is the active one.
* The status line reports the active engine and voice.

### 5. Tests (`Documents/read-aloud-e2e/`)

* `probe_kokoro.py` — the measurement harness above (already written).
* `run_tests.py` — a new phase that loads Kokoro next to Supertonic and asserts:
  both engines' voices are listed and Kokoro is selected by default; the saved Supertonic
  preference migrates to Kokoro; a real Kokoro utterance drives the highlight with the
  boundary error at 0 characters; the batch size adapts to the measured setup time.
* The existing PHASE 4 stub phase is repaired (the CDP websocket died after the stub
  installed) and the "utterance carries whole sentences" assertion is corrected to match the
  text actually queued.

## Out of scope

* Kokoro's missing `pitch` support — the slider stays, but it has no effect with Kokoro
  voices. Noted in the status message rather than hidden.
* Changing Kokoro itself (its per-utterance model reload is its own design).
* The extension is **not currently registered in the user's Chrome**; the user must load it
  unpacked at `chrome://extensions` before any of this is visible.
