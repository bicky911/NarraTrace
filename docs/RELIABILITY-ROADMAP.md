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
- [x] Add a structured research-article fixture covering headings, paragraphs, lists, captions, tables, metadata, navigation, sidebars, recommendations, and footer noise.
- [x] Fix the tokenizer boundary that incorrectly split honorifics from capitalized names.
- [x] Verify Readability output and its integration with the shared sentence tokenizer.
- [ ] Build additional fixtures for long articles, dynamic pages, and noisy layouts.
- [ ] Verify extracted text, sentence ranges, and DOM-highlight mapping.
- [ ] Add regression cases for malformed and inaccessible DOM structures.

## Stage 5: Performance and maintainability
- [ ] Profile idle CPU, playback CPU, memory, and large-page behavior.
- [ ] Establish performance budgets before optimizing.
- [ ] Modularize only behind test coverage; avoid a rewrite.
- [ ] Check resource cleanup and event-listener lifecycle.

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
