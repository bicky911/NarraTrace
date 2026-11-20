# NarraTrace renderer workload profile

## Purpose

Measure the work performed by the real NarraTrace content script in Chromium while a long article is idle and while narration is active. The profile is intended to reveal regressions and guide later device testing. It is not a synthetic benchmark of neural TTS inference and does not measure end-to-end audio latency.

## Automated method

The test `tests/browser/extension-runtime-profile.test.mjs`:

1. Installs the real NarraTrace Manifest V3 extension and a deterministic test-only TTS engine.
2. Serves a repeatable 240-paragraph article from localhost so the extension's normal content scripts are injected.
3. Samples Chromium's renderer metrics over a four-second idle window.
4. Starts reading through the extension's normal `TRIGGER_READ_PAGE` route.
5. Samples the same metrics over a six-second active-playback window while the test engine emits word-boundary events that exercise highlight updates.

The browser suite reports:
- `ScriptDuration`: cumulative renderer JavaScript execution time during the sample.
- `TaskDuration`: cumulative renderer main-thread task time during the sample.
- `JSHeapUsedSize` delta: change in measured renderer JavaScript heap use between the sample boundaries.
- Wall-clock sample duration and the number of TTS utterances observed.

## Interpretation

These are renderer-level measurements from a headless GitHub Actions Chromium environment. They are useful for same-run idle-versus-playback comparison and regression detection, but they are not equivalent to total process CPU, GPU usage, audio engine compute, or power consumption.

Do not set a hard user-facing performance promise from a single hosted runner. Collect repeated measurements on representative hardware and Chrome versions before introducing stricter budgets. In particular, measure idle and playback separately on a low-power CPU-only machine, and compare the test-only voice with at least one real supported engine.

## Existing large-document baseline

The separate `performance-profile.test.mjs` test profiles production content-block selection and sentence-to-DOM range mapping for 1,200 paragraphs (2,401 sentences). Its coarse CI ceiling is a regression guard, not a performance claim for every website or device.
