# NarraTrace 1.5 — Reliability & Verification

## Purpose
Reliability, user-visible synchronization, privacy, accessibility, and repeatable release validation take priority over feature expansion. This roadmap distinguishes automated coverage from real-device validation.

## Stage 1: Baseline and regression safety
- [x] CI runs the existing static verification harness.
- [x] Add Node regression suites and Chromium integration tests.
- [x] Align maintained provider scope and selection expectations across implementation and documentation (Piper and Supertonic; generic Chrome TTS fallback; no Kokoro-specific maintenance).
- [x] Document broad page access and provider-dependent processing.
- [ ] Maintain a tested Chrome/OS/provider matrix based on real-device reports.
- [ ] Compare repeatable baseline measurements across representative hardware.

## Stage 2: Playback reliability
- [x] Guard asynchronous playback transitions against superseded playback runs.
- [x] Regression-test overlapping starts, rapid skips, pause/resume, worker-recovery timeout, and rapid rate changes.
- [x] Stop a timed-out orphan utterance before worker recovery to prevent overlap.
- [x] Route rate, volume, pitch, and voice updates through a guarded restart path.
- [x] Exercise service-worker recovery with a deterministic Chromium TTS fixture.
- [ ] Define all playback state-transition invariants explicitly.
- [ ] Verify exactly-once advancement across completion, timeout, and provider errors on real providers.
- [ ] Validate resume offsets and rapid control/tab-switch sequences with installed providers.

## Stage 3: Synchronization
- [x] Keep native word events authoritative while a fallback estimator bridges sparse events.
- [x] Reject malformed native offsets without disabling fallback.
- [x] De-duplicate repeated synthetic boundary events.
- [x] Test grouped sentence mapping and full-source resume offsets.
- [x] Test extraction and word/sentence range mapping in Chromium fixtures.
- [ ] Validate partial, missing, delayed, and provider-specific boundary behavior with real voices.
- [ ] Verify estimator recalibration, language/script routing, and mid-session voice changes on-device.
- [ ] Prefer sentence-level highlighting when reliable word offsets are unavailable.

## Stage 4: Content extraction
- [x] Test structured article content, references, headings, captions, tables, lists, and noise blocks.
- [x] Test paragraph replacement and stale-range relocation in the browser fixture.
- [x] Verify empty content does not create phantom ranges.
- [ ] Add additional real-world fixtures for long, noisy, dynamic, malformed, and inaccessible layouts.

## Stage 5: Performance and maintainability
- [x] Replace continuous zoom polling with viewport/resolution lifecycle-aware watchers.
- [x] Test watcher registration, re-arming, cleanup, and mutation-observer lifecycle.
- [x] Add a large-page baseline and renderer idle-versus-playback profile in CI.
- [x] Establish coarse CI performance ceilings.
- [ ] Collect repeat profiles on representative CPU-only and higher-end hardware.
- [ ] Audit remaining event listeners, timers, and lifecycle cleanup paths.
- [ ] Modularize only where test coverage and clear boundaries justify it; no rewrite for its own sake.

## Stage 6: Accessibility, security, and release
- [x] Add Focus Reader dialog semantics, keyboard focus trapping, Escape behavior, focus restoration, and slider announcements to automated Chromium checks.
- [x] Test focus restoration in mini/tucked player conditions.
- [x] Add diagnostic privacy sanitization and access-control tests.
- [x] Remove unused manifest permissions and test the privacy/permission contract.
- [ ] Conduct manual screen-reader and assistive-technology checks.
- [ ] Verify reduced-motion behavior, contrast, and keyboard navigation on real Chrome/OS combinations.
- [ ] Complete the remaining extension security-boundary review.
- [ ] Run the manual real-engine checklist with installed Piper and Supertonic voices.
- [ ] Confirm cold/warm first-audio latency, sentence gaps, highlight drift, 30-minute memory behavior, and CPU use.
- [ ] Make an explicit repository license decision before redistribution.
- [ ] Verify final package, version, changelog, upgrade behavior, and release notes before publishing.

## Release acceptance criteria
- Automated checks pass on the release candidate.
- No known unexplained stalls, duplicate or missing transitions in tested scenarios.
- Highlighting and resume behavior are evidence-based for supported provider profiles.
- Service-worker recovery is tested, not assumed.
- Privacy, permissions, compatibility, and accessibility claims match evidence.
- Real-provider audio and manual release gates are completed and documented.

## Scope discipline
Small, reviewable changes with regression tests. Avoid unrelated features, risky rewrites, and unsupported claims. Do not publish or label a release as verified until the outstanding real-device and release gates above are completed.
