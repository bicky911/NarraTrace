# NarraTrace browser regression tests

The browser suite runs the real Manifest V3 extension in Chromium and installs a small deterministic Chrome TTS engine fixture. The fixture is not a production voice engine and does not generate audio; it emits real `chrome.ttsEngine` events with controlled timing.

## Run locally

Requires Node.js 22 or later and a Chromium/Chrome binary supported by Puppeteer.

From the repository root:

```bash
npm install --prefix tests/browser --no-save --no-package-lock puppeteer@25.17.0
node --test tests/browser/service-worker-recovery.test.mjs
```

The test loads NarraTrace and the fixture extension, starts a two-sentence session, forcibly closes the NarraTrace service-worker target during the first utterance, and checks that the restored queue submits the second sentence exactly once.

The browser suite is separate from the deterministic VM tests in `tests/playback-manager.test.mjs`. It should not be interpreted as validation of a user's installed neural TTS engines or their generated audio.
