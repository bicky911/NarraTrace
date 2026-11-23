# NarraTrace — Real-engine manual validation

Use this checklist on the Windows/Chrome installation that will run NarraTrace. Automated tests verify queue state, event routing, extraction, focus behavior, and browser integration; they do not establish real audio quality or acoustic word alignment.

## 0 · Install the candidate build

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Load the candidate extension folder containing `manifest.json`, or reload the existing unpacked installation.
4. Refresh the article tab after reloading the extension.
5. Open the NarraTrace popup and confirm it reports the expected build and voice provider.

Do not rely on a machine-specific folder path or extension ID in this checklist.

## 1 · Provider discovery and selection

| Check | Action | Expected result |
|---|---|---|
| 1.1 | Open the voice selector | Piper and Supertonic appear when their providers are installed and advertising voices |
| 1.2 | Inspect other installed Chrome TTS providers | They appear under a generic **Other engine** group; NarraTrace does not claim provider-specific tuning for them |
| 1.3 | Start with automatic selection and Piper installed | Piper is preferred when its voice is available |
| 1.4 | Explicitly select a Supertonic voice | The selection is remembered while that voice remains available |
| 1.5 | Restart Chrome and reopen NarraTrace | The selected voice is resolved again after providers register their voices |

NarraTrace's maintained provider profiles are **Piper and Supertonic**. Other Chrome TTS extensions remain usable through the generic Chrome TTS path, but are not a release-validation dependency.

## 2 · Audible output and continuity

- [ ] Start narration on a short article and confirm that sound is audible.
- [ ] Confirm the popup badge names the provider actually selected.
- [ ] Listen across at least ten sentence boundaries. There should be no unexplained long dead-air gaps.
- [ ] Repeat with a longer article and note first-audio latency separately from inter-sentence gaps.
- [ ] Repeat after a cold Chrome start and after a warm start.
- [ ] Confirm no duplicate sentence, skipped sentence, or overlapping audio occurs.
- [ ] Use Stop, then start a new article. The previous utterance must not continue.

Record the Chrome version, provider/voice name, rate, first-audio latency, and any noticeable sentence gaps. Do not describe a provider as local or network-based unless its own current documentation confirms that behavior.

## 3 · Speech-to-source synchronization

- [ ] Words highlight in reading order and track the audible speech.
- [ ] The highlight does not race ahead during provider preparation.
- [ ] At sentence and batch boundaries, the next highlight starts when the corresponding audio begins.
- [ ] Change playback speed during a sentence. The next spoken and highlighted positions must remain aligned.
- [ ] Pause in the middle of a sentence, wait several seconds, then resume. Verify the resume position without a repeated or skipped word.
- [ ] Skip forward and backward rapidly. Only the final requested sentence should continue speaking.
- [ ] Change voice during playback. Verify the new voice is active and the queue does not restart from an unrelated position.

If a provider does not expose dependable word offsets, sentence-level highlighting is preferable to confidently highlighting the wrong word.

## 4 · Focus Reader and keyboard accessibility

- [ ] Open Focus Reader from the floating player.
- [ ] Use Tab and Shift+Tab; focus remains within the reader dialog.
- [ ] Use arrow keys, Home, and End on the progress control.
- [ ] Press Escape. The reader closes and focus returns to its opener.
- [ ] Repeat with the floating player in mini layout and in its auto-tucked/beaded state.
- [ ] Open Settings, then press Escape. Focus returns to the Settings trigger even in mini layout.
- [ ] Confirm focus indicators remain visible and that reduced-motion preference is respected.

## 5 · Page extraction and dynamic content

- [ ] Test a research article with headings, lists, captions, tables, and references.
- [ ] Test a long-form news article with navigation, ads, related links, and footer content.
- [ ] Confirm page chrome and repeated recommendation blocks are not narrated.
- [ ] Replace or update a paragraph dynamically while narration is active. Highlighting must recover or safely fall back.
- [ ] Test browser zoom at 100%, 150%, and 200%.

## 6 · Failure and fallback behavior

- [ ] Temporarily disable Piper. NarraTrace should use the next available supported provider or a system voice.
- [ ] Temporarily disable Supertonic. Confirm a working alternative is selected.
- [ ] Disable all extension-provided TTS providers. Confirm a compatible Chrome/system voice is selected when available.
- [ ] Close the article tab during narration. Audio must not continue invisibly.
- [ ] Navigate or refresh the active article tab. Playback must stop or recover according to the documented session behavior.
- [ ] Force the service worker to stop during playback in the automated integration test. Confirm the queue advances without duplicate audio.

## 7 · Performance and privacy checks

- [ ] Compare the extension's idle behavior with active playback on the target CPU-only machine.
- [ ] Check memory after a 30-minute narration session for unbounded growth.
- [ ] Confirm animations and observers stop when their UI/page lifecycle ends.
- [ ] Review the selected voice provider's privacy policy. NarraTrace passes narration text to Chrome's TTS API; provider processing and retention depend on that provider.
- [ ] Run the bundled [real-engine diagnostic workflow](DEVICE-DIAGNOSTICS.md) for each provider you use. Require both a clean Chrome `end` event and the manual **I Hear Audio** mark before recording an audible pass.

## Diagnostic report

When a check fails, capture:

- Chrome version and operating system
- NarraTrace version/commit
- Provider and exact voice name
- Selected speed and language
- Whether the provider is cold-starting or already warm
- Expected behavior and actual behavior
- Relevant NarraTrace service-worker console messages

Do not include private article text in diagnostic reports unless it is necessary and you explicitly choose to share it.
