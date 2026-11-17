# NarraTrace device diagnostics

## What this tool does

The bundled `test.html` page can run a short speech sample through the exact Chrome TTS voice selected in its voice dropdown. It records the Chrome TTS event sequence and timestamps, the voice metadata, and the browser environment so a provider-specific problem can be investigated from a real Windows/Chrome machine.

The report does **not** record microphone input or audio. The sample text is **not included** in the exported JSON; only its character count is recorded. A real audible pass requires two separate signals:

1. Chrome sends a clean `end` event for the utterance.
2. The person running the test hears the sample and clicks **I Hear Audio** while it is speaking.

A synthetic or silent provider can pass the event pipeline but cannot produce an audible-confirmed report.

## Open the diagnostics page on Windows

1. Load the latest NarraTrace unpacked folder in `chrome://extensions` (Developer mode → Load unpacked). If NarraTrace is already installed as an unpacked extension, use **Reload** after replacing its files.
2. On the NarraTrace card, copy its extension ID.
3. Open a new Chrome tab and enter:

   ```
   chrome-extension://YOUR_NARRATRACE_EXTENSION_ID/test.html
   ```

   Replace the placeholder with the actual ID shown by Chrome. Do not include angle brackets.
4. Wait for the voice dropdown to populate. Choose the voice/provider you want to test. The selected provider is the actual voice sent to Chrome; the canonical group label is for display.
5. Optionally enter the provider extension's version. This field is manual because Chrome's voice-list API does not expose the installed extension's version.

## Run one provider test

1. Stop normal NarraTrace playback first. The diagnostics route refuses to run while the normal playback queue is PLAYING or PAUSED, or while Chrome reports another TTS utterance is active.
2. Keep the default short sample or replace it with a sentence of your own (maximum 500 characters).
3. Click **Run Audible Test**.
4. Listen for the first audible output. As soon as you hear it, click **I Hear Audio**. This records an approximate time from the test button click to your mark. It is a human timing mark, not an acoustic measurement.
5. Let the sample finish. A clean pass requires a Chrome `end` event and the manual audible mark. If the event stream ends without the mark, repeat the test and click the mark while the voice is speaking.
6. Inspect the event log. Note whether `start`, `word`, and/or `sentence` events appear; whether offsets increase sensibly; and whether an `end` event arrives.

The page can run one provider at a time. Repeat with each installed provider and voice you want to validate. Record cold-start and warm-start behavior separately.

## Export and share the report

Click **Export JSON** after the test finishes. The JSON contains:

- NarraTrace version, Chrome version, user agent, platform, language, timezone, and capture time.
- Provider group, exact voice name, actual extension ID, voice language, and the manually entered provider version (if supplied).
- Sample character count (not the sample text), selected rate, and test timestamps.
- Chrome TTS event types, elapsed times, character offsets and lengths, plus provider error messages if present.
- Whether Chrome returned `end`, the total provider request duration, and the user-marked first-audio time.

The report intentionally excludes the spoken sample text. It does not record sound or use the microphone. Attach the exported JSON to the NarraTrace development conversation together with a short note about any audible pauses, clipped/repeated words, pronunciation defects, or highlight mismatch observed while testing the normal reader.

## Interpreting outcomes

| Result | Interpretation |
|---|---|
| **Passed** | Chrome returned `end`, and the tester manually confirmed audible output during playback |
| **Chrome TTS completed, but audible output was not confirmed** | The provider emitted `end`, but no manual audible mark was made. This is not an audible pass |
| **Provider error** | Chrome delivered a TTS error event or API callback error; export the report and check the service-worker console |
| **Timeout / no completion** | No terminal event arrived within the safety window. Check the provider, service-worker console, and whether Chrome suspended/restarted the worker |
| **Voice no longer available** | The selected voice disappeared between discovery and the request; refresh the page and select a current voice |

## Security and isolation

The diagnostic speech request is accepted only from NarraTrace's bundled `test.html` extension page. The background worker validates that the selected voice name and extension ID match a voice currently returned by `chrome.tts.getVoices()`, checks that normal playback and Chrome speech are idle, and rejects text longer than 500 characters or rates outside 0.5×–2.0×. It calls the existing `safeSpeak()` wrapper; it does not add a second speech implementation or use Web Speech APIs.

The normal playback queue and diagnostic request are separate. Diagnostic events expose event metadata and provider errors only; they do not broadcast the sample text to other extension contexts.
