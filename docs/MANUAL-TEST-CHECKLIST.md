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

## 1 · The engine switched to Kokoro (60 s)

| # | Do this | Expected |
|---|---------|----------|
| 1.1 | Click the NarraTrace toolbar icon | The popup badge reads **KOKORO** |
| 1.2 | Open the voice dropdown | Three groups: `★ Kokoro (local neural)` with 28 voices, `★ Supertonic (local neural)`, `Windows System Voices` |
| 1.3 | The selected voice | **Kokoro Heart** |
| 1.4 | Open a Wikipedia article and press play | It speaks with a Kokoro voice, not the Supertonic one |

> If the badge says `SUPERTONIC`, you have pinned a Supertonic voice in an
> earlier session. That is intentional behaviour — pick any Kokoro voice in the
> dropdown once and it sticks.

---

## 2 · The first sentence takes a moment — that is normal (90 s)

Kokoro rebuilds its neural model **for every utterance**:

| Situation | Wait before you hear sound |
|-----------|---------------------------|
| First utterance ever (92 MB model download) | ~25–35 s |
| Every later utterance | ~10 s (CPU) / ~1–3 s (WebGPU) |
| A group of 4–12 sentences | one wait for the whole group |

- [ ] The pause before the voice starts is **one** pause, not one per sentence.
- [ ] While the pause happens, the highlight sits still on the first word
      instead of racing ahead. *(This is the fix for the drifting highlight.)*
- [ ] If your machine has a working WebGPU, the wait is much shorter. Check
      `chrome://gpu`.

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

## 6 · Hover to play (30 s)

- [ ] Hover a paragraph in a page → a **play button appears** on it.
- [ ] Click it → NarraTrace starts **from that paragraph**, not from the top of
      the page.
- [ ] Hover another paragraph while reading → the button follows the mouse.

---

## 7 · Fallback check (30 s)

- [ ] Pick a **Supertonic** voice in the dropdown → the badge changes to
  `SUPERTONIC` and Supertonic speaks. *(This proves the fallback still works
  and that a pinned voice is never overridden.)*
- [ ] Pick a Kokoro voice again → the badge returns to `KOKORO`.
- [ ] Disable the Kokoro extension in `chrome://extensions` → NarraTrace falls
  back to Supertonic, or to a Windows system voice if Supertonic is off too.

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
