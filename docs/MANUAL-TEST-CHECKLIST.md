# NarraTrace 1.4.0 — 5-minute manual test checklist

Run this manual release smoke test after the automated suites. These checks
require a real Chrome installation and audible speech, so they cannot be
replaced by source-code assertions or unit tests.

---

## 0 · Install (30 s)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select exactly this folder:

   ```
   C:\path\to\NarraTrace
   ```

   *(Not the zip, not a parent folder — the folder that contains `manifest.json`.)*
4. **Refresh every open tab** (Ctrl+R). A content script that was injected
   before the reload keeps the old code.

> Chrome displays the name and version declared in manifest.json. An unpacked
> extension's ID can vary by installation location.

---

## 1 · Provider discovery and selection (60 s)

| # | Do this | Expected |
|---|---------|----------|
| 1.1 | Click the NarraTrace toolbar icon | The badge matches the selected provider: PIPER, KOKORO, SUPERTONIC, OTHER, or SYSTEM |
| 1.2 | Open the voice dropdown | Every currently available provider is listed; known providers appear in priority order: Piper, Kokoro, Supertonic |
| 1.3 | With no voice pinned, enable multiple providers | Piper is selected first; disabling it selects Kokoro, then Supertonic, then system voices |
| 1.4 | Select a lower-priority provider manually | The explicit voice remains selected while it is available, even when a higher-priority provider is installed |

> Piper may use a dynamic extension ID. Its voice should still appear in the Piper group and show the PIPER badge; NarraTrace must route speech using the real ID supplied by Chrome.

---

## 2 · Cold start and sentence pacing (90 s)

Record each provider's cold-start and warm-start behavior separately. Do not use one fixed latency threshold for all providers.

| Provider | What to observe |
|-----------|-----------------|
| Piper | Time from Play to first audible speech, then repeat after the model is warm; check word/sentence events and sentence gaps |
| Kokoro | Allow model preparation to finish; confirm the highlight stays at the first word until speech begins and that grouping avoids repeated dead air |
| Supertonic | Confirm its voice is available; the first sentence boundary can arrive before audible speech, so the highlight must not race ahead during the lead-in |
| Windows / Chrome system voice | Confirm the selected system voice starts and that its available word/sentence events align with the highlight |

- [ ] The first delay is followed by continuous speech, not a pause after every source line.
- [ ] While the provider prepares audio, the highlight stays parked instead of racing ahead.
- [ ] Record provider, voice/model, cold-start time, warm-start time, and any noticeable gap between sentences.
- [ ] Repeat after switching away from the tab, then return and confirm that playback remains synchronized.

---


## 3 · The highlight stays on the spoken word (90 s)

- [ ] Words highlight **one at a time**, in order.
- [ ] The highlighted word is the word being **spoken** — not 1–2 sentences ahead.
- [ ] At the end of a group, the highlight jumps to the first word of the next
      group exactly when the voice starts there.
- [ ] Change the **speed** slider (0.5× → 2×). The highlight must keep up with
      the new speed, not stay at the old rate.
- [ ] Press **pause** in the middle of a sentence, wait 10 s, press **play**.
      The voice resumes **at the same word** and the highlight continues there.
      *(Kokoro has no native pause, so NarraTrace stops and resumes from the
      exact offset — the word must not be skipped or repeated.)*
- [ ] Press **next** / **previous**. The voice jumps a sentence and the
      highlight jumps with it.

---

## 4 · The floating player (60 s)

- [ ] At rest, the player is a **thin 6 px vertical bar** docked flush against
      the right screen edge — like the Samsung Galaxy S26 Ultra edge panel. It
      should not cover any page text.
- [ ] Click the bar → it opens to a **small 48 × 34 px block** (status LED +
  play button only).
- [ ] Hover the block → the full control row unfolds (previous, play, next,
  speed, settings, collapse).
- [ ] Move the mouse away → it folds back to the small block.

---

## 5 · The player keeps its size when you zoom the page (60 s)

- [ ] Press **Ctrl + +** until the page reaches 150–200 %.
- [ ] The player stays exactly the same **physical** size — it does not grow
      with the page.
      *(Measured automatically: 0.0 % width drift between 100 % and 150 %.)*
- [ ] Ctrl+0 back to 100 % → the player is still the same size.
- [ ] Same on a HiDPI display — it should not be half or double size.

---

## 5b · Dynamic-page runtime stability (60 s)

- [ ] Start narration on a page that updates while open (for example, a live
      news feed or an infinite-scroll page).
- [ ] Let unrelated parts of the page update while a sentence is being read.
      The active highlight should remain stable; unrelated updates must not
      repeatedly interrupt or remove it.
- [ ] When the active paragraph is re-rendered but the sentence remains in the
      document, NarraTrace should re-anchor the highlight. If the sentence is
      removed, the stale highlight should clear instead of pointing at other text.
- [ ] Change browser zoom with Ctrl + + and Ctrl + 0 while narration is idle and
      while it is playing. The player should keep its physical size without a
      recurring polling timer.

## 6 · Hover to play (30 s)

- [ ] Hover a paragraph in a page → a **play button appears** on it.
- [ ] Click it → NarraTrace starts **from that paragraph**, not from the top of
      the page.
- [ ] Hover another paragraph while reading → the button follows the mouse.

---

## 7 · Provider fallback and pin behavior (45 s)

- [ ] With no voice pinned, enable Piper, Kokoro, and Supertonic together. The active badge should be PIPER.
- [ ] Disable Piper while automatic selection is active. The active provider should move to Kokoro, then to Supertonic when Kokoro is also disabled.
- [ ] Choose Supertonic manually while Piper is available. The explicit choice should remain selected; automatic priority must not override it.
- [ ] Disable the pinned provider. The voice menu should show the remaining providers. Select an available fallback manually to continue playback.
- [ ] Re-enable the original provider and confirm its voices reappear in the dropdown.
- [ ] Disable every provider extension. Confirm a Windows/Chrome system voice can be selected and used.

> A deliberately pinned voice is preserved rather than silently replaced. When that provider is unavailable, select a currently available voice from the dropdown.

---


## 8 · Capture a real-engine diagnostic report

- [ ] Open `chrome-extension://YOUR_EXTENSION_ID/test.html` in the same Chrome profile.
- [ ] Select the provider and exact voice you are validating. Enter its version if known.
- [ ] Stop normal narration, then click **Run Audible Test**.
- [ ] Click **I Hear Audio** as soon as the first sound is audible.
- [ ] Let the sample finish and confirm the report shows **Passed** only when both the audio mark and Chrome `end` event were recorded.
- [ ] Export the JSON report. It includes event timing/offsets and browser/provider metadata, but not the sample text.

Follow docs/DEVICE-DIAGNOSTICS.md. A CI fake-engine pass is not a substitute for this real audible check.

---

## If something is wrong

Open `chrome://extensions` → **NarraTrace** → **service worker** → the console
log. The useful lines are:

```
[Background] NarraTrace service worker active.
[SpeechEngine] Speech exceeded Ns without TTS end event; advancing to avoid stall.
[Background] Voice refresh failed: ...
```

Copy that output and send it back — it identifies which of the seven sections
above is misbehaving.
