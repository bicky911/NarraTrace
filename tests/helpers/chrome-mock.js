/**
 * A deterministic stand-in for the parts of the Chrome extension API that the
 * NarraTrace modules touch, so the playback manager and speech engine can be
 * exercised in Node with no browser and no build step.
 *
 * Design notes:
 *  - `chrome.storage.*` supports BOTH the promise form (`await get()`) and the
 *    callback form (`get(keys, cb)`) because the production code deliberately
 *    mixes them for compatibility with older Chrome releases.
 *  - Stored values are cloned, like real extension storage, so a test cannot
 *    accidentally keep a live reference into the manager's state.
 *  - TTS is fully controllable: an utterance can complete automatically
 *    (`autoSpeak`) or be driven event by event (`emit`).
 */

const KOKORO_ID = 'mefecoigjodlohjacogkbbfpnifhfocb';
const SUPERTONIC_ID = 'mdoplmghlkjcnegkdhocjbjcncocbdhk';

export const DEFAULT_VOICES = [
  { voiceName: 'Kokoro Heart', lang: 'en-US', extensionId: KOKORO_ID, eventTypes: ['start', 'sentence', 'end'] },
  { voiceName: 'Kokoro Bella', lang: 'en-US', extensionId: KOKORO_ID, eventTypes: ['start', 'sentence', 'end'] },
  { voiceName: 'Microsoft David - English (United States)', lang: 'en-US', eventTypes: ['start', 'word', 'end'] }
];

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function makeStorageArea() {
  const map = new Map();
  const stats = { setCalls: 0, writtenKeys: [] };

  const keyList = (keys) => {
    if (keys === null || keys === undefined) return [...map.keys()];
    if (typeof keys === 'string') return [keys];
    if (Array.isArray(keys)) return keys;
    if (typeof keys === 'object') return Object.keys(keys);
    return [];
  };

  const read = (keys) => {
    const out = {};
    for (const key of keyList(keys)) {
      if (map.has(key)) out[key] = clone(map.get(key));
    }
    return out;
  };

  const get = (keys, callback) => {
    const out = read(keys);
    if (typeof callback === 'function') {
      queueMicrotask(() => callback(out));
      return undefined;
    }
    return Promise.resolve(out);
  };

  const set = (items, callback) => {
    stats.setCalls += 1;
    for (const [key, value] of Object.entries(items || {})) {
      map.set(key, clone(value));
      stats.writtenKeys.push(key);
    }
    if (typeof callback === 'function') {
      queueMicrotask(() => callback());
      return undefined;
    }
    return Promise.resolve();
  };

  return {
    get,
    set,
    remove: (keys) => {
      for (const key of keyList(keys)) map.delete(key);
      return Promise.resolve();
    },
    clear: () => { map.clear(); return Promise.resolve(); },
    __dump: () => clone(Object.fromEntries(map.entries())),
    __stats: stats,
    __resetStats: () => {
      stats.setCalls = 0;
      stats.writtenKeys = [];
    },
    __writeCount: (key) => stats.writtenKeys.filter((k) => k === key).length
  };
}

export function createChromeMock(options = {}) {
  const voices = options.voices ? structuredClone(options.voices) : structuredClone(DEFAULT_VOICES);

  const mock = {
    voices,
    speaks: [],          // every speak() call: { text, options, timers }
    stops: 0,
    pauses: 0,
    resumes: 0,
    runtimeMessages: [],
    tabMessages: [],
    autoSpeak: options.autoSpeak !== false,
    speaking: false,
    pending: null,
    // When true, speak() fails the way Chrome reports a rejected request.
    failSpeaks: false,
    failMessage: 'TTS engine refused the utterance.'
  };

  const storage = {
    local: makeStorageArea(),
    session: makeStorageArea()
  };

  const emit = (utterance, event) => {
    if (!utterance || utterance.settled) return;
    if (event.type === 'end' || event.type === 'error' ||
        event.type === 'interrupted' || event.type === 'cancelled') {
      utterance.settled = true;
      mock.speaking = false;
      if (mock.pending === utterance) mock.pending = null;
    }
    utterance.options.onEvent(event);
  };

  /** Drive the pending utterance by hand (autoSpeak off). */
  mock.emit = (event) => {
    if (!mock.pending) throw new Error('No pending utterance to drive.');
    emit(mock.pending, event);
  };

  /** Set true to have the next speak() call report a Chrome runtime error. */
  mock.failNextSpeak = false;

  const chrome = {
    runtime: {
      id: 'narratrace-test-extension',
      lastError: undefined,
      sendMessage(message) {
        mock.runtimeMessages.push(clone(message));
        return Promise.resolve();
      },
      getURL: (path) => `chrome-extension://test/${path}`
    },
    storage,
    tabs: {
      sendMessage(tabId, message) {
        mock.tabMessages.push({ tabId, message: clone(message) });
        return Promise.resolve();
      },
      query: () => Promise.resolve([]),
      getZoom: (tabId, callback) => callback(1)
    },
    tts: {
      getVoices(callback) {
        queueMicrotask(() => callback(structuredClone(mock.voices)));
      },
      speak(text, options, callback) {
        const utterance = {
          text,
          options,
          settled: false,
          charIndex: 0
        };
        mock.speaks.push(utterance);

        if (mock.failSpeaks || mock.failNextSpeak) {
          mock.failNextSpeak = false;
          chrome.runtime.lastError = { message: mock.failMessage };
          try {
            if (typeof callback === 'function') callback();
          } finally {
            chrome.runtime.lastError = undefined;
          }
          return;
        }

        mock.speaking = true;
        mock.pending = utterance;
        if (typeof callback === 'function') callback();

        if (mock.autoSpeak) {
          queueMicrotask(() => {
            if (utterance.settled) return;
            emit(utterance, { type: 'start', charIndex: 0 });
            const text = utterance.text;
            let index = 0;
            for (const word of text.split(' ')) {
              if (!word) { index += 1; continue; }
              if (utterance.settled) return;
              emit(utterance, { type: 'word', charIndex: index, length: word.length });
              index += word.length + 1;
            }
            if (utterance.settled) return;
            emit(utterance, { type: 'end', charIndex: text.length });
          });
        }
      },
      stop() {
        mock.stops += 1;
        mock.speaking = false;
        const utterance = mock.pending;
        if (utterance && !utterance.settled) {
          // Real chrome.tts.stop() surfaces a 'cancelled' event to the
          // utterance it interrupted; the engine reports it asynchronously.
          queueMicrotask(() => emit(utterance, { type: 'cancelled', charIndex: 0 }));
        }
        mock.pending = null;
      },
      pause() { mock.pauses += 1; mock.speaking = false; },
      resume() { mock.resumes += 1; mock.speaking = true; },
      isSpeaking(callback) { queueMicrotask(() => callback(mock.speaking)); },
      onVoicesChanged: { addListener() {} }
    }
  };

  mock.chrome = chrome;
  mock.reset = () => {
    mock.speaks = [];
    mock.stops = 0;
    mock.pauses = 0;
    mock.resumes = 0;
    mock.runtimeMessages = [];
    mock.tabMessages = [];
    mock.speaking = false;
    mock.pending = null;
    mock.failSpeaks = false;
    for (const area of [storage.local, storage.session]) {
      area.clear();
      area.__resetStats();
    }
  };

  return mock;
}

/** Wait until `predicate()` is true (or fail after `timeoutMs`). */
export async function waitFor(predicate, timeoutMs = 2000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

export const VOICE_IDS = {
  KOKORO: KOKORO_ID,
  SUPERTONIC: SUPERTONIC_ID
};
