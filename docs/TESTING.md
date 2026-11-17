# NarraTrace testing

NarraTrace has two dependency-free automated test layers.

## Requirements

- Node.js 22 or newer
- Python 3.10 or newer

No npm packages are installed. package.json only declares the module format, scripts, and minimum Node version; the tests use Node's built-in test runner.

## Run the tests

Focused runtime/unit tests: npm test

Existing source-structure checks: npm run test:static

Both layers: npm run test:all

## Coverage

The unit suite currently exercises:

- Sentence whitespace normalization, decimal punctuation, Indic terminators, and chunk limits
- Bengali/Hindi script detection and voice matching
- Playback queue sanitation and pronunciation rules
- Pitch-change resume offsets
- Service-worker recovery when an orphaned utterance is still active
- Persistence of deferred recovery state across session save/restore

The Python harness remains useful for source-level invariants and markup checks. It is not a substitute for running the extension in Chrome.

## Browser and real-engine verification

The unit tests do not prove that Chrome's TTS providers behave correctly on a particular device. Before a release, also follow docs/MANUAL-TEST-CHECKLIST.md with each supported engine. Record the Chrome version, operating system, engine version, and test result when reporting an engine-specific defect.
