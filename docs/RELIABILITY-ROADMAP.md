# NarraTrace 1.5 — Reliability & Verification

## Purpose
Establish a trustworthy quality baseline before adding features or performing risky architectural refactors. This roadmap is an engineering plan, not a claim that the items are already implemented or verified.

## Stage 1: Baseline and regression safety
- [x] Add CI execution for the existing static verification harness.
- [x] Document test limitations and the staged plan.
- [ ] Reconcile automatic voice-selection expectations between implementation, README, and manual checklist.
- [ ] Capture a repeatable Chrome test environment and supported-engine matrix.
- [ ] Record baseline results for the current branch and main.

## Stage 2: Playback reliability
- [x] Guard asynchronous start, pause, resume, stop, skip, jump, and worker-recovery continuations against superseded playback runs.
- [x] Add deterministic mocked Chrome/TTS regression tests for overlapping starts, rapid skips, pause/resume, worker-recovery timeout, and rapid rate changes.
- [x] Stop a timed-out orphaned utterance before worker-recovery replay to prevent overlapping speech.
- [x] Route rate, volume, pitch, and voice updates through a shared latest-run restart guard.
- [ ] Define the remaining explicit playback state-transition invariants.
- [ ] Test rapid play/pause/stop/next/previous and tab-switching sequences.
- [ ] Verify exactly-once sentence advancement on completion, timeout, and errors.
- [ ] Exercise service-worker termination and session restoration.
- [ ] Validate resume offsets after speed changes and pauses.
- [ ] Add deterministic mocked Chrome TTS tests.

## Stage 3: Synchronization
- [x] Keep native word events authoritative while the estimator bridges stale or partial boundary streams.
- [x] Reject malformed native word indices without disabling estimator fallback.
- [x] De-duplicate repeated synthetic word events within the same word.
- [x] Add regression coverage for grouped sentence offsets and full-source resume-position mapping.
- [ ] Normalize TTS word-boundary events across supported engines.
- [ ] Validate offset handling with partial, missing, and delayed boundary events.
- [ ] Verify estimator recalibration at sentence boundaries.
- [ ] Test language/script routing and voice changes mid-session.

## Stage 4: Content extraction
- [x] Add a structured research-article fixture covering headings, paragraphs, lists, captions, tables, metadata, navigation, sidebars, recommendations, footer noise, and references.
- [x] Fix the tokenizer boundary that incorrectly split honorifics from capitalized names.
- [x] Retain short structural headings so reference-section cutoff can operate.
- [x] Verify Readability output and its integration with the shared sentence tokenizer.
- [x] Test production content-block selection, references cutoff, sentence DOM ranges, and word subranges across inline nodes.
- [x] Simulate paragraph replacement and verify stale sentence ranges can be relocated without pointing to detached nodes.
- [x] Verify missing text and empty blocks do not create phantom sentence/word ranges.
- [ ] Build additional fixtures for long articles, dynamic pages, and noisy layouts.
- [ ] Add malformed and inaccessible DOM regression cases.

## Stage 5: Performance and maintainability
- [x] Remove always-on 1.2 s zoom-compensation polling; react to viewport and resolution changes instead.
- [x] Re-arm the device-pixel-ratio watcher on BFCache restore and disconnect it on pagehide.
- [x] Add resource-lifecycle regression tests for DPR watcher registration, re-arming, cleanup, and legacy listener support.
- [x] Test MutationObserver start idempotency, mutation throttling, disconnect, timer cancellation, and restart after cleanup.
- [x] Add a repeatable Chromium large-article baseline for production block selection, sentence DOM mapping, renderer script duration, and heap delta.
- [ ] Profile idle CPU and playback CPU on a real extension page.
- [ ] Establish performance budgets from collected baseline results before optimizing.
- [ ] Modularize only behind test coverage; avoid a rewrite.
- [ ] Audit remaining event-listener and timer cleanup paths.

## Stage 6: Release quality
- [ ] Accessibility test keyboard navigation, screen readers, reduced motion, and focus restoration.
- [ ] Audit privacy claims and engine-specific network/local processing behavior.
- [ ] Review permissions and extension security boundaries.
- [ ] Verify release package, changelog, version, and upgrade behavior.

## Acceptance criteria
- No unexplained playback stalls, duplicate or missing sentence transitions in defined scenarios.
- Resume position and highlighting behave consistently across supported engines, including fallback paths.
- Service-worker termination/restart behavior is tested rather than assumed.
- Automated checks pass on proposed changes.
- Privacy, compatibility, and accessibility claims are evidence-based.

## Scope discipline
Reliability improvements take priority over major feature additions. Each change should be small, independently reviewable, accompanied by tests, and evaluated against the acceptance criteria.
