# Real-engine compatibility and release validation

## Purpose

This document covers the checks that a synthetic browser fixture cannot prove. It is the manual verification record for the actual Chrome TTS providers installed on the target Windows machine.

NarraTrace calls **Chrome's chrome.tts API only**. Speech is requested from the extension background service worker; the page content script receives playback and word-position events. The automated fake TTS extension verifies that routing and highlighting pipeline, but it does not synthesize sound.

## Current provider-selection contract

When the user has not pinned a voice, the automatic selection order is:

1. **Piper** — highest-priority registered engine.
2. **Kokoro**.
3. **Supertonic**.
4. Other Chrome TTS extension providers.
5. Windows/Chrome system voices: first an English voice, then any system voice.

An explicitly selected voice remains preferred while that voice is present. The automatic resolver does not replace a pinned voice merely because a higher-priority engine appears. When a pinned provider is unavailable, select an available voice in the voice menu to change the pin.

Piper can be installed with an extension ID that differs from the registry's published ID. NarraTrace recognizes the current Piper integration by the **Piper ** voice-name prefix for grouping and display, while preserving the actual Chrome-provided extensionId for chrome.tts.speak(). A provider that does not follow that naming convention may appear as an unknown Chrome TTS engine and needs a separate compatibility review.

Provider labels such as “local neural” and “network” are descriptive registry metadata. They are not a runtime network monitor or a privacy guarantee. Each provider controls its own model downloads, synthesis, and network behavior.

## What CI verifies

The deterministic test suite covers:

- Provider ordering when multiple registered providers are present.
- Dynamic Piper ID grouping, active badge selection, and preservation of the real extension ID.
- Pinned-voice resolution and fallback candidate selection when a pinned voice is absent from the current voice list.
- System-voice fallback and visibility of unrecognized Chrome TTS providers.
- chrome.tts.speak() option construction, including trimming valid voice metadata and omitting empty optional fields.
- Successful completion on an end event, rejection on provider error, rejection on chrome.runtime.lastError, and no-op handling for empty text.
- Playback-manager voice refresh retaining the real provider ID and publishing the resolved provider identity.

These tests use a controlled Chrome API mock. They verify NarraTrace's handling of the API contract, not the correctness, latency, pronunciation, or sound quality of a real provider.

## Manual provider matrix

Run each available provider independently, then run the priority/fallback checks with multiple providers enabled.

| Provider | Discovery and identity | Event behavior to observe | Audible behavior to verify |
|---|---|---|---|
| Piper | Voice appears in the Piper group; popup badge says PIPER; actual selected voice is shown | Record whether word and sentence events arrive, and whether offsets are monotonic | Cold and warm start, word alignment, sentence transitions, pause/resume, rate/volume/pitch, and long text |
| Kokoro | Voice appears in the Kokoro group; popup badge says KOKORO | Current integration expects start/sentence/end boundaries and no native word events; NarraTrace estimates word position between boundaries | Model preparation, first audible word, grouped sentence pacing, highlight stability, pause/resume, rate/volume, and long text |
| Supertonic | Voice appears while its provider is available; popup badge says SUPERTONIC | Current integration expects start/sentence/end boundaries; its first sentence boundary may precede audible speech | Initial silent lead-in, highlight staying parked until speech is audible, sentence transitions, provider/host-tab availability, and recovery |
| Windows / Chrome system voice | Appears in the system-voice group; popup badge says SYSTEM | Record the actual word/sentence events exposed by the selected voice | Startup, pronunciation, highlight behavior, rate/volume/pitch, pause/resume, and long text |
| Other Chrome TTS provider | Appears under its own unknown-engine group and badge OTHER | Record every event type and the offsets supplied | Confirm it can speak, end cleanly, recover from interruption, and keep highlight movement bounded |

The event expectations in this table describe the current NarraTrace integration notes. Confirm them against the actual installed provider version rather than treating them as universal guarantees.

## Built-in diagnostic page

Use the bundled `chrome-extension://YOUR_EXTENSION_ID/test.html` page to capture a real provider request. It records provider/voice metadata, Chrome event types, character offsets, event timings, and any error returned by the provider. Enter the provider's extension version manually; it is not exposed by the Chrome TTS voice list.

Click **Run Audible Test**, then click **I Hear Audio** as soon as the first sound is audible. A report passes only when the provider ends cleanly and the manual audible mark exists. Export the JSON and preserve it with the manual observations. The sample text is not included in the report. Full instructions are in docs/DEVICE-DIAGNOSTICS.md.

## Manual test sequence

### 1. Record the environment

Record:

- Windows edition and build.
- Full Chrome version from chrome://version.
- NarraTrace version from chrome://extensions.
- Provider extension name and version.
- Exact voice/model selected.
- Whether the provider's host tab or background service is required.
- Whether GPU/WebGPU acceleration is enabled, if the provider exposes that information.

### 2. Test each provider in isolation

For each available row in the matrix:

1. Disable the other TTS provider extensions.
2. Open NarraTrace and confirm that its engine badge and voice list match the enabled provider.
3. Read a short paragraph, a multi-paragraph article, and a long page.
4. Listen for clipped words, repeated words, abrupt intonation resets, dead air between sentences, and unexpected mid-sentence silence.
5. Compare the highlighted word with the word actually being spoken. A highlight that moves during model preparation or provider silence is a failure.
6. Test pause/resume in the middle of a sentence, next/previous sentence, stop, and a speed change while speaking.
7. Repeat once after the provider has warmed up. Record cold-start and warm-start observations separately.

### 3. Test selection and provider changes

- Enable Piper, Kokoro, and Supertonic together. With no pinned choice, the expected automatic provider is Piper.
- Disable Piper while automatic selection is active. The next available provider should be Kokoro; then Supertonic; then a system voice when no extension provider remains.
- Pin Supertonic while Piper is available. Confirm that the explicit choice remains active instead of being silently replaced by Piper.
- Disable the pinned provider. Confirm the voice menu shows the providers that remain available, then manually select a working fallback. This is an intentional pin-preservation behavior, not an automatic switch.
- Re-enable the provider and verify its voices reappear in the list. Re-select it to pin it again if a fallback was chosen.
- For Piper, verify both the displayed group/badge and the actual voice routing. A dynamic extension ID must not be replaced by the canonical display ID.

### 4. Test interruption and long-session recovery

- Start reading, switch to another tab, and return.
- Pause for at least 10 seconds, then resume. Confirm that the word does not restart from the beginning or skip forward.
- Change speed while speech is active. Confirm that the voice and highlight resume from the same confirmed position.
- Disable or close the active provider while reading. Record whether Chrome emits an error, interruption, or no terminal event; NarraTrace must not become permanently stuck in PLAYING.
- Let a long article play long enough to cross multiple keep-alive intervals. Confirm playback continues and the player remains controllable.
- Close the initiating tab. Confirm that playback stops rather than continuing invisibly.

### 5. Record results

Use one row per provider and test session. Do not report a CI mock result as a real-engine pass.

| Date / session | Provider + version | Voice / model | Cold start | Warm start | Highlight sync | Sentence gaps | Pause / resume | Long session | Result / notes |
|---|---|---|---|---|---|---|---|---|---|
| Pending device test | — | — | — | — | — | — | — | — | Not yet run |

A failure report should include the exact provider and voice, the Chrome version, the test step, what was heard, what the highlight showed, and the service-worker console output from chrome://extensions.

## Release gate

A Stage 07 CI pass means the provider registry logic, Chrome TTS API wrapper, and deterministic recovery contracts pass automated checks. **It does not mean real audio has been verified.** Do not publish a release until the manual matrix has been run on the target Windows/Chrome machine for every provider advertised as supported. If a provider cannot be tested, mark it as unverified instead of claiming compatibility.
