/**
 * NarraTrace - Speech Engine Module
 * 
 * HARD RULES RESPECTED:
 * 1. Only uses chrome.tts. Zero use of prohibited web speech APIs.
 * 2. Runs exclusively in extension background contexts where chrome.tts is available.
 * 3. Voice selection is ENGINE-AGNOSTIC: any TTS engine extension that registers
 *    voices through chrome.tts can drive NarraTrace. The engines listed in
 *    TTS_ENGINES define NarraTrace's maintained provider profiles (Piper first,
 *    Supertonic second). Other Chrome TTS providers remain discoverable through
 *    the generic engine path, with fallback to local/system voices.
 * 4. Only passes optional speak() options (voiceName, extensionId, lang) when they contain
 *    non-empty strings to prevent Windows Chrome silent TTS failures.
 */

export const PIPER_EXTENSION_ID = 'ppnfahcipommelgaapjalhooaeeblmeg';
export const SUPERTONIC_EXTENSION_ID = 'mdoplmghlkjcnegkdhocjbjcncocbdhk';

/**
 * The TTS engines NarraTrace knows about, best first.
 *
 * An engine is a Chrome extension that registers voices through the `tts_engine`
 * manifest key. Chrome exposes those voices through chrome.tts.getVoices(), each
 * tagged with the id of the extension that owns it, and routes a speak() request
 * to that extension when the request carries its id. So supporting a new engine
 * is a matter of knowing its id — nothing else in NarraTrace is engine specific.
 *
 * Measured behaviour of each engine (Chrome 156):
 *
 *   Piper     High-speed local neural voices running via WASM/ONNX. Fast, low-latency
 *             synthesis (<200 ms). Emits start/sentence/end with exact character offsets
 *             and lengths.
 *
 *   Supertonic  Advertises its voices only while its host tab is open. Emits
 *             start/sentence/end, no word events. 'sentence' events carry exact
 *             character offsets. Announces the first sentence boundary together
 *             with 'start', i.e. ~3.2 s BEFORE the voice is actually audible.
 */
export const TTS_ENGINES = [
  {
    id: PIPER_EXTENSION_ID,
    label: 'Piper',
    fullLabel: 'Piper (local neural)',
    badge: 'PIPER',
    defaultVoice: null,
    priority: 5
  },
  {
    id: SUPERTONIC_EXTENSION_ID,
    label: 'Supertonic',
    fullLabel: 'Supertonic',
    badge: 'SUPERTONIC',
    defaultVoice: null,
    priority: 20
  }
];

/**
 * Look up the known-engine spec for an extension id.
 * @param {string|null|undefined} extensionId
 * @returns {object|null}
 */
export function getEngineSpec(extensionId, voice = null) {
  if (extensionId) {
    const found = TTS_ENGINES.find(e => e.id === extensionId);
    if (found) return found;
  }
  if (voice && typeof voice.voiceName === 'string' && voice.voiceName.startsWith('Piper ')) {
    return TTS_ENGINES.find(e => e.id === PIPER_EXTENSION_ID) || null;
  }
  return null;
}

/**
 * Is the chrome.tts namespace usable yet?
 *
 * Chrome creates the namespace a moment after the service worker starts, so
 * code that runs at module scope can see `chrome.tts === undefined` on a cold
 * boot. Touching it unguarded throws and silently disables the caller.
 *
 * @returns {boolean}
 */
export function ttsApiAvailable() {
  try {
    return typeof chrome !== 'undefined'
      && !!chrome.tts
      && typeof chrome.tts.speak === 'function';
  } catch (_) {
    return false;
  }
}

/**
 * Wait until the chrome.tts namespace exists.
 *
 * @param {number} timeoutMs How long to wait before giving up.
 * @returns {Promise<boolean>} true when the API became available.
 */
export function waitForTtsApi(timeoutMs = 10000) {
  if (ttsApiAvailable()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (ttsApiAvailable()) {
        resolve(true);
      } else if (Date.now() >= deadline) {
        resolve(false);
      } else {
        setTimeout(tick, 50);
      }
    };
    tick();
  });
}

/**
 * Fetch all available TTS voices from Chrome.
 * @returns {Promise<chrome.tts.TtsVoice[]>}
 */
export function getAllVoices() {
  return new Promise((resolve) => {
    // The namespace can be missing for the first moments of the worker's life.
    const read = () => {
      chrome.tts.getVoices((voices) => {
        // Reading lastError marks it handled — otherwise Chrome logs an
        // "Unchecked runtime.lastError" for every failed call.
        void chrome.runtime.lastError;
        resolve(voices || []);
      });
    };
    if (ttsApiAvailable()) {
      read();
    } else {
      waitForTtsApi().then((ok) => (ok ? read() : resolve([])));
    }
  });
}

/**
 * Find the voice set, group the extension-provided voices by engine and select
 * the voice NarraTrace should speak with.
 *
 * Selection order:
 *   1. A voice the user explicitly picked (preference.pinned) — always wins, so
 *      a deliberately chosen Supertonic voice is never overridden.
 *   2. Otherwise the highest-priority maintained provider profile wins,
 *      using that engine's default voice. Piper is preferred, then Supertonic;
 *      other Chrome TTS providers remain available as generic choices.
 *   3. Otherwise an English Windows system voice, then any system voice, then
 *      any voice at all.
 *
 * @param {{voiceName?:string|null, pinned?:boolean}|null} preference
 * @returns {Promise<{
 *   selectedVoice: chrome.tts.TtsVoice|null,
 *   statusMessage: string,
 *   engineId: string|null,
 *   engineLabel: string,
 *   engineBadge: string,
 *   engineVoices: chrome.tts.TtsVoice[],
 *   engines: Array<{id:string,label:string,fullLabel:string,badge:string,voices:chrome.tts.TtsVoice[]}>,
 *   localSystemVoices: chrome.tts.TtsVoice[],
 *   otherVoices: chrome.tts.TtsVoice[],
 *   allVoices: chrome.tts.TtsVoice[]
 * }>}
 */
export async function detectAndSelectVoice(preference = null) {
  const pref = (preference && typeof preference === 'object') ? preference : {};
  const voices = await getAllVoices();

  // Group the extension-provided voices by the engine that owns them.
  const byEngine = new Map();
  for (const v of voices) {
    if (!v.extensionId) continue;
    // Resolve provider aliases (including unpacked Piper installs with a
    // dynamic extension ID) to the canonical registry ID for grouping. The
    // original voice object and its extensionId remain untouched for speak().
    const targetEngineId = getEngineSpec(v.extensionId, v)?.id || v.extensionId;
    if (!byEngine.has(targetEngineId)) byEngine.set(targetEngineId, []);
    byEngine.get(targetEngineId).push(v);
  }

  // Known engines first, in preference order; then any other engine we do not
  // know about (e.g. the built-in Google network voices).
  const engines = [];
  const known = [...TTS_ENGINES].sort((a, b) => a.priority - b.priority);
  for (const spec of known) {
    const list = byEngine.get(spec.id);
    if (!list || list.length === 0) continue;
    engines.push({
      id: spec.id,
      label: spec.label,
      fullLabel: spec.fullLabel,
      badge: spec.badge,
      voices: list
    });
    byEngine.delete(spec.id);
  }
  for (const [id, list] of byEngine) {
    engines.push({
      id,
      label: 'Other engine',
      fullLabel: `Other engine (${id.slice(0, 8)})`,
      badge: 'OTHER',
      voices: list
    });
  }

  const localSystemVoices = voices.filter(v => !v.extensionId);
  const best = engines.length > 0 ? engines[0] : null;

  let selectedVoice = null;
  let statusMessage = '';

  // 1. A voice the user explicitly picked always wins.
  if (pref.pinned && typeof pref.voiceName === 'string' && pref.voiceName.trim().length > 0) {
    const pinned = voices.find(v => v.voiceName === pref.voiceName.trim());
    if (pinned) {
      selectedVoice = pinned;
      const spec = getEngineSpec(pinned.extensionId, pinned);
      statusMessage = spec
        ? `Using ${spec.label} voice "${pinned.voiceName}".`
        : `Using voice "${pinned.voiceName}".`;
    }
  }

  // 2. Otherwise the highest-priority engine wins.
  if (!selectedVoice && best) {
    const spec = getEngineSpec(best.id);
    const defaultName = spec ? spec.defaultVoice : null;
    const defaultVoice = defaultName
      ? best.voices.find(v => v.voiceName === defaultName)
      : null;
    selectedVoice = defaultVoice || best.voices[0];
    statusMessage = `${best.fullLabel} is active (${best.voices.length} voice${best.voices.length > 1 ? 's' : ''}). Selected: "${selectedVoice.voiceName}".`;
  }

  // 3. No engine extension at all — fall back to the Windows voices.
  if (!selectedVoice) {
    const englishVoice = localSystemVoices.find(v => v.lang && v.lang.toLowerCase().startsWith('en'));
    if (englishVoice) {
      selectedVoice = englishVoice;
      statusMessage = `No TTS engine extension found. Falling back to local Windows voice: "${selectedVoice.voiceName}".`;
    } else if (localSystemVoices.length > 0) {
      selectedVoice = localSystemVoices[0];
      statusMessage = `Using default system voice: "${selectedVoice.voiceName}".`;
    } else if (voices.length > 0) {
      selectedVoice = voices[0];
      statusMessage = `Using available voice: "${selectedVoice.voiceName}".`;
    } else {
      statusMessage = `Warning: No TTS voices found on this system.`;
    }
  }

  // A maintained provider may advertise under a dynamic extension ID.
  // Match its canonical group identity without rewriting the real ID carried
  // by selectedVoice (which is required by chrome.tts.speak()).
  const selectedEngineSpec = selectedVoice
    ? getEngineSpec(selectedVoice.extensionId, selectedVoice)
    : null;
  const activeEngineId = selectedEngineSpec?.id || (selectedVoice?.extensionId || null);
  const activeEngine = engines.find(e => e.id === activeEngineId) || null;

  return {
    selectedVoice,
    statusMessage,
    engineId: activeEngine ? activeEngine.id : null,
    engineLabel: activeEngine ? activeEngine.label : 'System',
    engineBadge: activeEngine ? activeEngine.badge : 'SYSTEM',
    engineVoices: activeEngine ? activeEngine.voices : [],
    engines,
    localSystemVoices,
    otherVoices: voices.filter(v => {
      if (!v.extensionId) return false;
      const spec = getEngineSpec(v.extensionId, v);
      const id = spec?.id || v.extensionId;
      return !activeEngine || id !== activeEngine.id;
    }),
    allVoices: voices
  };
}

/**
 * Safely speak a text segment using chrome.tts.
 * 
 * STRICT COMPLIANCE:
 * - Only passes voiceName, extensionId, and lang if they are non-empty strings.
 * - Captures start, end, error, and other events.
 * 
 * @param {string} text Text to speak
 * @param {object} options Speech options (rate, pitch, volume, voiceName, extensionId, lang)
 * @param {function} onEvent Callback for TTS events
 * @returns {Promise<object>} Resolves on completion or interruption; rejects on TTS error.
 */
export function safeSpeak(text, options = {}, onEvent = null) {
  return new Promise((resolve, reject) => {
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      resolve({ type: 'empty' });
      return;
    }

    const ttsOptions = {
      rate: typeof options.rate === 'number' && !isNaN(options.rate) ? options.rate : 1.0,
      pitch: typeof options.pitch === 'number' && !isNaN(options.pitch) ? options.pitch : 1.0,
      volume: typeof options.volume === 'number' && !isNaN(options.volume) ? options.volume : 1.0,
      desiredEventTypes: ['start', 'word', 'sentence', 'end', 'error', 'interrupted', 'cancelled'],
    };

    // HARD RULE: Only pass optional speak() options when they hold a real value. Never an empty string.
    if (typeof options.voiceName === 'string' && options.voiceName.trim().length > 0) {
      ttsOptions.voiceName = options.voiceName.trim();
    }
    if (typeof options.extensionId === 'string' && options.extensionId.trim().length > 0) {
      ttsOptions.extensionId = options.extensionId.trim();
    }
    if (typeof options.lang === 'string' && options.lang.trim().length > 0) {
      ttsOptions.lang = options.lang.trim();
    }

    // Watchdog timers: the engine may spend a long time PREPARING before the
    // first word is audible, and that preparation must not eat the speaking
    // budget. Measured against the real engines:
    //
    //   Supertonic can announce its first sentence boundary before audible
    //   playback begins; its provider-specific lead-in is handled by the
    //   playback synchronizer. Other engines use their observed TTS events.
    //
    // So the speaking budget only starts once the engine has actually
    // produced a boundary; until then a separate, much longer preparation
    // budget applies. Without this split a long preparation would abort a
    // perfectly healthy utterance and make the reader stutter.
    const rateWatchdogMs = Math.round(45000 / (ttsOptions.rate || 1));
    const lengthWatchdogMs = Math.ceil((text.length / 8) * 1000);
    // Never shorter than 45 s of speaking; only longer when the utterance
    // really needs it. 8 chars/s is the slowest sustained rate observed.
    const speakWatchdogMs = Math.max(45000, rateWatchdogMs, lengthWatchdogMs);
    const prepareWatchdogMs = Math.max(60000, speakWatchdogMs);

    let watchdogTimer = null;
    let speechStarted = false;
    const armWatchdog = (ms) => {
      if (watchdogTimer) {
        clearTimeout(watchdogTimer);
      }
      watchdogTimer = setTimeout(() => {
        console.warn(`[SpeechEngine] Speech exceeded ${Math.round(ms / 1000)}s without TTS end event; advancing to avoid stall.`);
        resolve({ type: 'timeout' });
      }, ms);
    };
    const cleanupWatchdog = () => {
      if (watchdogTimer) {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
    };

    // The preparation budget runs until the engine says a word.
    armWatchdog(prepareWatchdogMs);

    ttsOptions.onEvent = (event) => {
      // The first boundary means the engine is actually speaking — from now
      // on the speaking budget applies.
      if (!speechStarted && (event.type === 'sentence' || event.type === 'word')) {
        speechStarted = true;
        armWatchdog(speakWatchdogMs);
      }

      if (onEvent) {
        onEvent(event);
      }
      if (event.type === 'end') {
        cleanupWatchdog();
        resolve(event);
      } else if (event.type === 'error') {
        cleanupWatchdog();
        const errorMsg = event.errorMessage || 'Unknown TTS error occurred during speech.';
        console.warn('[SpeechEngine] TTS error event:', errorMsg);
        reject(new Error(errorMsg));
      } else if (event.type === 'interrupted' || event.type === 'cancelled') {
        cleanupWatchdog();
        resolve(event);
      }
    };

    chrome.tts.speak(text, ttsOptions, () => {
      if (chrome.runtime.lastError) {
        cleanupWatchdog();
        const err = new Error(chrome.runtime.lastError.message);
        console.warn('[SpeechEngine] chrome.tts.speak API call failed:', err);
        reject(err);
      }
    });
  });
}

/**
 * Stop any ongoing speech.
 */
export function stopSpeech() {
  chrome.tts.stop();
}

/**
 * Stop speech and wait until the engine confirms it is idle.
 * A speak() issued immediately after stop() can be silently swallowed by the
 * Windows TTS pipeline; this barrier closes that race before a new utterance.
 */
export function stopSpeechAndWait(timeoutMs = 500) {
  chrome.tts.stop();
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      chrome.tts.isSpeaking((speaking) => {
        void chrome.runtime.lastError;
        if (!speaking || Date.now() >= deadline) {
          resolve();
        } else {
          setTimeout(poll, 40);
        }
      });
    };
    poll();
  });
}

/**
 * Pause speech playback.
 */
export function pauseSpeech() {
  chrome.tts.pause();
}

/**
 * Resume speech playback.
 */
export function resumeSpeech() {
  chrome.tts.resume();
}

/**
 * Check if speech is currently playing.
 * @returns {Promise<boolean>}
 */
export function isSpeaking() {
  return new Promise((resolve) => {
    chrome.tts.isSpeaking((speaking) => {
      void chrome.runtime.lastError;
      resolve(Boolean(speaking));
    });
  });
}

/**
 * Detect script/language of a text string.
 * Returns 'bn' (Bengali), 'hi' (Hindi/Devanagari), or 'en' (Latin/default).
 * @param {string} text
 * @returns {'bn'|'hi'|'en'}
 */
export function detectScript(text) {
  if (!text || typeof text !== 'string') return 'en';
  let bn = 0, hi = 0, en = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x0980 && code <= 0x09FF) bn++;
    else if (code >= 0x0900 && code <= 0x097F) hi++;
    else if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) en++;
  }
  if (bn > 0 && bn >= hi) return 'bn';
  if (hi > 0 && hi > bn) return 'hi';
  return 'en';
}

/**
 * Find the best available voice in the browser for a given language code.
 * @param {Array<object>} voices List of available chrome.tts voices
 * @param {string} langCode 'bn', 'hi', etc.
 * @param {object|null} fallback Voice to return if no match found
 * @returns {object|null}
 */
export function findBestVoiceForLang(voices, langCode, fallback = null) {
  if (!Array.isArray(voices) || voices.length === 0) return fallback;
  if (!langCode || langCode === 'en') return fallback;

  const code = langCode.toLowerCase();
  // 1. Language code match (e.g. 'bn-BD', 'bn-IN', 'hi-IN')
  const byLang = voices.find(v => v.lang && v.lang.toLowerCase().startsWith(code));
  if (byLang) return byLang;

  // 2. Name search (Bengali / Bangla / Hindi)
  if (code === 'bn') {
    const byName = voices.find(v => /bangla|bengali|বাংলা/i.test(v.voiceName));
    if (byName) return byName;
  } else if (code === 'hi') {
    const byName = voices.find(v => /hindi|हिन्दी/i.test(v.voiceName));
    if (byName) return byName;
  }

  return fallback;
}
