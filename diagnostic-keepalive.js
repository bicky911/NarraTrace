/**
 * Keep the MV3 service worker active while an isolated diagnostic utterance
 * is pending. Normal narration owns a separate keep-alive in PlaybackManager;
 * diagnostic speech bypasses that state machine and may spend over 30 seconds
 * preparing before its first word event.
 */
const SESSION_STORAGE_KEY = 'readAloud_sessionState';
const KEEP_ALIVE_INTERVAL_MS = 15_000;

export function createDiagnosticKeepAlive(storageArea, {
  schedule = setInterval,
  cancel = clearInterval
} = {}) {
  if (!storageArea || typeof storageArea.get !== 'function') {
    throw new TypeError('A Chrome session storage area is required.');
  }

  let timer = null;

  const ping = () => {
    try {
      const request = storageArea.get(SESSION_STORAGE_KEY);
      if (request && typeof request.catch === 'function') {
        request.catch(() => {});
      }
    } catch (_) {
      // A failed keep-alive ping must never interrupt diagnostic speech.
    }
  };

  return {
    start() {
      if (timer !== null) return false;
      timer = schedule(ping, KEEP_ALIVE_INTERVAL_MS);
      return true;
    },

    stop() {
      if (timer === null) return false;
      cancel(timer);
      timer = null;
      return true;
    }
  };
}
