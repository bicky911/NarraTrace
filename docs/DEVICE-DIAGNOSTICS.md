# NarraTrace device diagnostics

## Purpose

The bundled `test.html` page sends one short sample through the exact Chrome TTS voice selected in its voice dropdown. Use it to measure provider startup, event behavior, offsets, completion, and errors on the Windows/Chrome installation that will run NarraTrace.

NarraTrace's maintained provider profiles are **Piper and Supertonic**. The page can also test other installed Chrome TTS providers and system voices when Chrome exposes them. It does not require Kokoro.

## What the report contains

The exported JSON records:

- NarraTrace version, Chrome version, platform, language, timezone, and capture time.
- Provider group, exact voice name, actual Chrome extension ID, language, and a manually entered provider version if supplied.
- Selected speech rate and sample character count.
- Chrome TTS event types, elapsed times, character offsets and lengths, and bounded provider error messages.
- Whether Chrome returned a clean `end` event, request duration, and a human-marked first-audio time.

The report intentionally excludes the sample text and any audio recording. The page does not use the microphone.

## Open the diagnostics page

1. Load the current NarraTrace unpacked folder in `chrome://extensions`, or click **Reload** on the existing unpacked extension.
2. On the NarraTrace card, copy the extension ID.
3. Open a new Chrome tab and enter:

   ```
   chrome-extension://YOUR_NARRATRACE_EXTENSION_ID/test.html
   ```

   Replace the placeholder with the actual ID shown by Chrome.
4. Wait for the voice dropdown to populate.
5. Select the provider/voice to test. Enter its extension version manually if useful; Chrome's TTS voice list does not expose that version.

## Run a provider test

1. Stop normal NarraTrace playback first. The diagnostics route refuses to run while the normal queue is PLAYING or PAUSED, or when Chrome reports another TTS utterance is active.
2. Use the default short sample or enter a test sentence of your own (maximum 500 characters).
3. Click **Run Audible Test**.
4. Listen for the first audible output. As soon as you hear it, click **I Hear Audio**. This is a human timing mark from the diagnostic request start, not an acoustic measurement.
5. Let the sample finish. A genuine audible pass requires both a clean Chrome `end` event and the manual audible mark.
6. Inspect the event log. Note whether `start`, `word`, and/or `sentence` events appear, whether offsets are plausible, and whether an `end` event arrives.
7. Repeat once after the provider has warmed up. Record cold-start and warm-start behavior separately.

The page can run one provider at a time. Repeat for Piper, Supertonic, other installed Chrome TTS providers, or system voices that you actually use.

## Export and share

Click **Export JSON** after the test finishes. The report is useful for comparing:

- First audible response time (human-marked approximation).
- Event order and offsets.
- Provider completion and error behavior.
- Cold-start versus warm-start timing.

The report does not contain the sample text or audio. Before sharing it, review the provider name, extension ID, and environment metadata to ensure you are comfortable sharing them.

## Interpreting outcomes

| Result | Meaning |
|---|---|
| **Passed** | Chrome returned `end` and you manually confirmed audible output during playback |
| **Chrome TTS completed, but audible output was not confirmed** | Event routing completed, but no audible pass can be claimed |
| **Provider error** | Chrome delivered a TTS error event or API callback error |
| **Timeout / no completion** | No terminal event arrived within the diagnostic safety window |
| **Voice no longer available** | The selected voice disappeared between discovery and the request; refresh the list and select it again |

A silent test fixture can verify the diagnostic event pipeline, but it cannot produce an audible pass.

## Security and isolation

The diagnostic request is accepted only from NarraTrace's bundled `test.html` extension page. The background worker validates the selected voice against Chrome's current `chrome.tts.getVoices()` list, bounds the sample to 500 characters and rate to 0.5×–2.0×, and rejects overlap with normal playback or other active Chrome speech.

Normal playback is also blocked while a diagnostic utterance is active. The separate session-inspection route is restricted to the same bundled diagnostics page. Diagnostic event telemetry never includes the spoken sample text.

For a failure report, include the Chrome version, NarraTrace commit, provider/voice, cold or warm start, what you heard, and the exported JSON. Do not add private article text unless it is essential and you explicitly choose to share it.
