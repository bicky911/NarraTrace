# NarraTrace 1.5.0 — manual test checklist

Everything below was verified automatically in a real Chrome (19/19 engine checks,
13/13 UI checks). This list is for the two things a headless browser cannot
judge: **how it actually sounds on your machine** and **how it feels while you
use it**.

---

## 0 · Install (30 s)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select exactly this folder:

   ```
   C:\Users\bicky_local\Desktop\read-aloud
   ```

   *(Not the zip, not a parent folder — the folder that contains `manifest.json`.)*
4. **Refresh every open tab** (Ctrl+R). A content script that was injected
   before the reload keeps the old code.

> Chrome shows the extension as **NarraTrace · 1.5.0** with the id
> `hbfbblacfbkjafmkjohjpbojhcfofpnp`.

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

## 8 · 1.5.0 regression pass (4 minutes)

These are the defects 1.5.0 fixes. Each one is also covered by an automated
test, but only a human can confirm the *sound*.

### 8.1 Abbreviations no longer fragment (30 s)

Open any article and read a sentence that begins with a title.

- [ ] A paragraph starting **"Dr. Smith…"**, **"Prof. Jones…"** or containing
      **"et al."** reads as one continuous sentence. You must **not** hear a
      separate "Doctor." fragment followed by a new intonation start.
- [ ] **"U.S. Army"** is spoken as two words, not "U. S." then a new sentence.
- [ ] **"One... two... three."** is one sentence; **"Wait... What happened?"**
      pauses and then restarts (two sentences).

### 8.2 No doubled audio after a stall (60 s)

Requires a slow engine (Kokoro on CPU is ideal).

- [ ] Let Kokoro take its ~10 s to start. If it ever exceeds the watchdog
      (45 s of speech), playback continues once — never two voices at the same
      time.
- [ ] After the watchdog fires, the reading resumes near where it stopped
      instead of restarting the whole page.

### 8.3 Single-page apps keep reading (60 s)

- [ ] On a SPA (YouTube, GitHub file browser, a docs site with client-side
      routing), start reading and let the address bar change on its own.
      Narration must **continue**; it must not stop when the URL changes.
- [ ] Click an in-page `#anchor` link while reading → reading continues.
- [ ] A real navigation (click a link to another document) → narration stops.

### 8.4 Pause means paused (30 s)

- [ ] Start reading, press pause, then click the progress bar or a sentence in
      Focus Reader. The highlight moves, but **no audio starts**.
- [ ] Press play → it reads from the new position.

### 8.5 Closed tabs cannot keep talking (30 s)

- [ ] Start reading, then close the tab from the tab strip.
      Audio stops immediately. *(Before 1.5.0 the last utterance could finish
      with no UI attached.)*

### 8.6 Context-menu selection is traced (30 s)

- [ ] Select two sentences on a page, right-click → **NarraTrace: narrate
      selection**.
- [ ] It starts reading the selection **and** the word capsule traces it on the
      page (previously it spoke without any highlight).

### 8.7 Script routing (30 s)

- [ ] On an English page that quotes a single Bangla word, the sentence reads
      in the English voice (not a Bangla accent over the whole sentence).
- [ ] A genuinely Bengali sentence still switches to the Bangla voice.

### 8.8 Pronunciation overrides (30 s) — currently storage-only

> The rules engine is implemented and tested, but the panel control was removed
> in the settings streamline, so this feature has **no UI** (decision P0 in
> `docs/QUALITY-STRATEGY.md`). This pass verifies the engine only.

In the service-worker console, write a rule set directly:

```js
chrome.storage.local.get('readAloud_userPreferences').then(({ readAloud_userPreferences: p }) => {
  chrome.storage.local.set({ readAloud_userPreferences: {
    ...(p || {}), pronunciationText: 'C++ = see plus plus\n.NET = dot net'
  }});
});
```

- [ ] After a worker restart, a sentence containing **C++** is spoken as
      "see plus plus".
- [ ] **.NET** is spoken as "dot net", and the string "XNET" is untouched.

### 8.9 Word capsule survives a re-render (30 s)

- [ ] Start reading a page whose text is replaced in place (a Twitter/X or
      Docs-style feed, or a page whose paragraph is swapped by a framework).
- [ ] The sentence highlight re-anchors onto the new nodes instead of
      disappearing, and **the word capsule reappears on the same word**
      rather than waiting for the next word event.
- [ ] If the sentence is genuinely gone, both highlights disappear — the
      capsule never sits over unrelated text.

### 8.10 Long-article responsiveness (60 s)

- [ ] Open a very long document (a Wikipedia article or a 5,000-sentence paper).
- [ ] Scrolling and typing in the page stay smooth while reading; the progress
      counter advances without stutter.
      *(The queue is now persisted once per run instead of on every sentence.)*

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
