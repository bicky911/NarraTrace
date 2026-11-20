# NarraTrace browser regression tests

The browser suite runs the real Manifest V3 extension in Chromium and installs a small deterministic Chrome TTS engine fixture. The fixture is not a production voice engine and does not generate audio; it emits real `chrome.ttsEngine` events with controlled timing.

## Run locally

Requires Node.js 22 or later and a Chromium/Chrome binary supported by Puppeteer.

From the repository root:

```bash
npm install --prefix tests/browser --no-save --no-package-lock puppeteer@25.17.0
node --test tests/browser/service-worker-recovery.test.mjs tests/browser/content-extraction.test.mjs
```

The Chromium browser tests cover:

- **Service-worker recovery:** loads NarraTrace and the deterministic TTS fixture, starts a two-sentence session, forcibly closes the NarraTrace service-worker target during the first utterance, and checks that the restored queue submits the second sentence exactly once.
- **Content extraction:** parses a structured research article, verifies site chrome is excluded, executes the production content-block selector and references cutoff, and checks sentence and word ranges across nested DOM text nodes.

The browser suite is separate from the deterministic VM tests in `tests/playback-manager.test.mjs`, the tokenizer tests in `tests/sentence-tokenizer.test.mjs`, and the resource-lifecycle unit tests in `tests/resource-lifecycle.test.mjs`. The TTS fixture exercises Chrome's event API but does not validate the audio quality or latency of a user's installed neural voice engines.
