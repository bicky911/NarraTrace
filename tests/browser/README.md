# NarraTrace browser regression tests

The browser suite runs the real Manifest V3 extension in Chromium and installs a small deterministic Chrome TTS engine fixture. The fixture is not a production voice engine and does not generate audio; it emits real `chrome.ttsEngine` events with controlled timing.

## Run locally

Requires Node.js 22 or later and a Chromium/Chrome binary supported by Puppeteer.

From the repository root:

```bash
npm install --prefix tests/browser --no-save --no-package-lock puppeteer@25.17.0
node --test tests/browser/service-worker-recovery.test.mjs tests/browser/content-extraction.test.mjs tests/browser/performance-profile.test.mjs
```

The Chromium browser tests cover:

- **Service-worker recovery:** loads NarraTrace and the deterministic TTS fixture, starts a two-sentence session, forcibly closes the NarraTrace service-worker target during the first utterance, and checks that the restored queue submits the second sentence exactly once.
- **Content extraction:** parses a structured research article, verifies site chrome is excluded, executes the production content-block selector and references cutoff, and checks sentence and word ranges across nested DOM text nodes.
- **Large-page performance:** profiles production block selection and sentence-range mapping for 1,200 paragraphs, records renderer heap/script-duration deltas, and applies a coarse 1,000 ms CI regression ceiling.

The browser suite is separate from the deterministic VM tests in `tests/playback-manager.test.mjs`, the tokenizer tests in `tests/sentence-tokenizer.test.mjs`, and the resource-lifecycle unit tests in `tests/resource-lifecycle.test.mjs`. The TTS fixture exercises Chrome's event API but does not validate the audio quality or latency of a user's installed neural voice engines.


## Extension renderer workload profile

Run the real-extension idle/playback profile with:

```bash
node --test tests/browser/extension-runtime-profile.test.mjs
```

The test serves a repeatable 240-paragraph article on localhost, lets the real Manifest V3 content script initialise, samples Chromium renderer script/task time and heap during an idle window, then starts narration through the extension and samples again during active playback. Its deterministic TTS fixture emits word-boundary events throughout each utterance so the active interval includes word-highlighting work.

Results are diagnostic baselines only. They are not a full device CPU benchmark, and no performance budget is claimed until repeated runs on representative user hardware are compared.
