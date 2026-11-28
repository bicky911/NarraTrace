import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeTtsDiagnosticEvent,
  DIAGNOSTIC_PROVIDER_ERROR,
  DIAGNOSTIC_REQUEST_ERROR
} from '../tts-diagnostic-privacy.js';

test('provider error strings that echo the spoken sample are redacted', () => {
  const spokenSample = 'PRIVATE-ERROR-ECHO-SAMPLE-DO-NOT-EXPORT';
  const safe = sanitizeTtsDiagnosticEvent({
    type: 'error',
    errorMessage: spokenSample,
    charIndex: 0,
    length: spokenSample.length,
    charLength: spokenSample.length
  });

  assert.equal(safe.type, 'error');
  assert.equal(safe.errorMessage, DIAGNOSTIC_PROVIDER_ERROR);
  assert.equal(safe.charIndex, 0);
  assert.equal(safe.length, spokenSample.length);
  assert.equal(safe.charLength, spokenSample.length);
  assert.equal(JSON.stringify(safe).includes(spokenSample), false);
  assert.equal(DIAGNOSTIC_REQUEST_ERROR, 'The selected TTS provider could not complete the diagnostic request.');
});

test('non-error event offsets are preserved and provider error text is omitted', () => {
  const safe = sanitizeTtsDiagnosticEvent({
    type: 'word',
    charIndex: 12,
    length: 5,
    charLength: 40,
    errorMessage: 'should never be copied'
  });

  assert.deepEqual(safe, {
    type: 'word',
    charIndex: 12,
    length: 5,
    charLength: 40,
    errorMessage: null
  });
});

test('malformed provider event metadata normalizes to a safe unknown event', () => {
  assert.deepEqual(sanitizeTtsDiagnosticEvent({
    type: 17,
    charIndex: Number.NaN,
    length: -Infinity,
    charLength: 'invalid',
    errorMessage: 'sensitive'
  }), {
    type: 'unknown',
    charIndex: null,
    length: null,
    charLength: null,
    errorMessage: null
  });
});
