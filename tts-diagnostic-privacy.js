/**
 * Privacy-safe normalization for untrusted Chrome TTS provider events.
 * Provider error strings are not exported because some engines echo speech text.
 */

export const DIAGNOSTIC_PROVIDER_ERROR =
  'The selected TTS provider returned an error.';

export const DIAGNOSTIC_REQUEST_ERROR =
  'The selected TTS provider could not complete the diagnostic request.';

export function sanitizeTtsDiagnosticEvent(event) {
  const type = typeof event?.type === 'string' ? event.type : 'unknown';
  return {
    type,
    charIndex: Number.isFinite(event?.charIndex) ? event.charIndex : null,
    length: Number.isFinite(event?.length) ? event.length : null,
    charLength: Number.isFinite(event?.charLength) ? event.charLength : null,
    errorMessage: type === 'error' ? DIAGNOSTIC_PROVIDER_ERROR : null
  };
}
