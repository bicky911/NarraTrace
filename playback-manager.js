/**
 * NarraTrace - Playback Manager Module
 * 
 * Orchestrates the sentence queue, playback states, and session storage persistence.
 * 
 * HARD RULES RESPECTED:
 * 1. Only uses chrome.tts via speech-engine.js.
 * 2. Manages queue and index in chrome.storage.session so playback survives worker restarts.
 * 3. Highlighting and sentence advancement driven strictly by our own sentence queue.
 * 4. Only passes valid, non-empty voice/extensionId/lang strings.
 */

import {
  safeSpeak,
  stopSpeechAndWait,
  isSpeaking,
  detectAndSelectVoice,
  detectScript,
  findBestVoiceForLang
} from './speech-engine.js';

export const PlaybackState = {
  IDLE: 'IDLE',
  PLAYING: 'PLAYING',
  PAUSED: 'PAUSED',
  STOPPED: 'STOPPED'
};

const SESSION_STORAGE_KEY = 'readAloud_sessionState';
// The queue lives in its OWN session key. State changes (current sentence,
// pause, resume) happen once per sentence; writing the queue alongside them
// meant re-serialising up to 5000 sentences (~500 KB) on every single
// sentence. Splitting the keys makes the per-sentence write a few hundred
// bytes and keeps the queue written once per run.
const SESSION_QUEUE_KEY = 'readAloud_sessionQueue';
const PREFS_STORAGE_KEY = 'readAloud_userPreferences';

// Give up after this many consecutive TTS failures instead of racing through
// the whole queue (a broken voice driver would otherwise emit thousands of
// errors in a few seconds).
const MAX_CONSECUTIVE_ERRORS = 3;

// How many consecutive sentences may share ONE utterance.
// chrome.tts speaks one utterance at a time. An engine that has to prepare
// before it can speak (a network voice, or Kokoro rebuilding its model) pays
// that preparation on EVERY utterance, so one sentence per utterance costs a
// visible dead-air gap at every sentence boundary. Grouping turns N
// preparations into one and the sentences run into each other with no gap.
const MAX_BATCH_SENTENCES = 12;
const DEFAULT_REMOTE_BATCH = 3;

// How many characters one sentence typically holds. Only used to turn the
// measured preparation time into a sensible group size.
const TYPICAL_SENTENCE_CHARS = 65;

// The preparation time may cost at most this fraction of the speech it
// precedes. With a 10 s setup and ~4.6 s of speech per sentence this asks for
// ~14 sentences per utterance, i.e. one setup per ~60 s of reading.
const PREPARE_BUDGET_RATIO = 0.15;

// Fallback speaking speed used until we have measured the real one (~135-140 WPM).
const DEFAULT_CHARS_PER_SECOND = 13.5;
// How often the position estimator runs when the engine gives no word events (~22 fps).
const ESTIMATOR_INTERVAL_MS = 45;
// How long to wait for the engine's first SENTENCE boundary before assuming
// this engine reports no boundaries at all. Measured against the real engines:
// Supertonic reaches 7.2 s and Kokoro needs ~10 s on a CPU-only machine (and
// ~24 s the very first time, while its 92 MB model downloads), so this has to
// be comfortably above that.
const ESTIMATOR_BOUNDARY_WAIT = 45000;

// An engine that announces its first sentence boundary within this many
// milliseconds of the 'start' event is announcing the boundary BEFORE the
// voice starts (Supertonic: 'start' and 'sentence(0)' arrive together while
// the voice only becomes audible ~3.2 s later). Such an engine needs the
// lead-in correction; an engine whose first boundary arrives later (Kokoro:
// ~10 s, right when the first sentence actually starts playing) does not.
const BOUNDARY_ANNOUNCED_EARLY_MS = 500;

// ─── Semantic Noise Stripper ────────────────────────────────────────────────
// Removes citation clutter, raw URLs, footnote markers, and other non-speech
// noise from text BEFORE it reaches the TTS engine.
// Rules are ordered roughly by frequency.
// The original item.text is NEVER mutated — this only affects spoken output,
// so word-boundary highlights and display remain perfectly intact.
//
// Covered patterns:
//  • Bracket citations:        [1], [23], [1,2], [citation needed], [note 3]
//  • Academic parentheticals:  (Smith et al., 2024)  (Jones 1999)  (ibid.)
//  • Raw URLs:                 https://…  http://…  www.example.com/…
//  • DOI identifiers:          doi:10.xxxx/…
//  • Media labels:             [Photo]  [Image: caption]  [Figure 3]  [Table 2]
//  • Symbol footnote markers:  †  ‡  §  *  (standalone, not mid-word)
//  • Parenthetical "see also": (see §4)  (cf. Smith)  (compare with…)
//  • Social media handles:     @username  (stripped only when standalone)
//  • Markdown artifacts:       **bold**  *italic*  __underline__  `code`

export const _NOISE_RULES = [
  // ── Raw URLs (most disruptive — do first) ─────────────────────────────────
  // https:// or http://  or ftp://
  { re: /https?:\/\/[^\s<>"')\]]+/gi,                  rep: '' },
  // www.domain/path
  { re: /\bwww\.[a-z0-9-]+\.[a-z]{2,}[^\s<>"')\]]*/gi, rep: '' },
  // DOI identifiers
  { re: /\bdoi:\s*10\.\d{4,}\/\S+/gi,                  rep: '' },

  // ── Bracket citations ─────────────────────────────────────────────────────
  // [1], [12], [1,2,3], [1–4], [citation needed], [note 2], [a], [n]
  { re: /\[\s*(?:\d[\d,\s\u2013\u2014–-]*|\w[\w\s,.]*?)\]/g, rep: '' },

  // ── Academic / parenthetical citations ────────────────────────────────────
  // (Smith et al., 2024), (Jones, 1999), (ibid.), (op. cit.), (loc. cit.)
  { re: /\(\s*(?:[A-Z][a-zA-Z]+(?:\s+et\s+al\.?)?[,.]?\s*(?:1[0-9]{3}|20[0-9]{2})|ibid\.|op\.\s*cit\.|loc\.\s*cit\.)\s*\)/g, rep: '' },
  // (see §3), (cf. Smith), (compare with X), (see also X)
  { re: /\(\s*(?:see\s+also|see|cf\.|compare(?:\s+with)?|refer\s+to)\s+[^)]{0,60}\)/gi, rep: '' },

  // ── Media / figure labels ──────────────────────────────────────────────────
  // [Photo], [Image], [Video], [Audio], [Figure 3], [Table 2], [Graph]
  { re: /\[\s*(?:Photo|Image|Figure|Fig\.|Table|Graph|Video|Audio|Illustration|Map|Chart)(?:[:\s][^\]]{0,40})?\]/gi, rep: '' },

  // ── Standalone footnote symbols ───────────────────────────────────────────
  // † ‡ § ° * when surrounded by spaces or punctuation (not inside words)
  { re: /(?<=\s|^|[.,;!?])[†‡§°*]{1,2}(?=\s|$|[.,;!?])/g, rep: '' },

  // ── Markdown artifacts ────────────────────────────────────────────────────
  // **bold**  __bold__
  { re: /\*\*([^*]+)\*\*/g,  rep: '$1' },
  { re: /__([^_]+)__/g,      rep: '$1' },
  // *italic*  _italic_
  { re: /\*([^*\n]+)\*/g,    rep: '$1' },
  { re: /_([^_\n]+)_/g,      rep: '$1' },
  // `inline code`
  { re: /`([^`\n]{1,80})`/g, rep: '$1' },

  // ── Whitespace cleanup ────────────────────────────────────────────────────
  // Multiple spaces / tabs → single space
  { re: /[ \t]{2,}/g,  rep: ' ' },
  // Space before punctuation (artifact after removing citations)
  { re: / ([.,;:!?])/g, rep: '$1' },
  // Double punctuation artifacts   "..," → ".," or ",."
  { re: /([.,;])([.,;])/g, rep: '$1' },
];

/**
 * Strip semantic noise from text for TTS consumption.
 * Returns cleaned text; never returns empty string — falls back to original.
 * @param {string} text
 * @returns {string}
 */
export function stripSemanticNoise(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const rule of _NOISE_RULES) {
    out = out.replace(rule.re, rule.rep);
  }
  out = out.trim();
  // Safety: never return blank — fall back to original so the sentence is
  // spoken (even if noisy) rather than silently skipped.
  return out.length > 0 ? out : text.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Context-Aware Prosody & Punctuation Cadence
// ─────────────────────────────────────────────────────────────────────────────
// Injects natural breathing pauses at clause boundaries (em-dashes, colons,
// semicolons, parentheticals, and enumerations) so speech has human-like rhythm
// and cadence rather than robotic run-on delivery.
// Original item.text is never mutated — only the spoken utterance is enhanced.
export const _PROSODY_RULES = [
  // 1. Em-dash (—) and En-dash (–) and double-dash (--) → comma breathing pause
  // Prevents speech engines from pronouncing "dash" or running through breathlessly
  { re: /\s*[—–]\s*|\s+--\s+/g, rep: ', ' },

  // 2. Colons and semicolons: ensure trailing whitespace for distinct clause-level pause
  { re: /([;:])(?=[A-Za-z0-9])/g, rep: '$1 ' },

  // 3. Ellipses (… or ...): ensure trailing pause boundary
  { re: /(…|\.{3})(?=[A-Za-z0-9])/g, rep: '$1 ' },

  // 4. Enumerations: "1. Item" or "A. Title" → "1, Item" so numbers aren't run together
  { re: /(^|[\s(])(\d+|[A-Z])\.\s+(?=[A-Z])/g, rep: '$1$2, ' },

  // 5. Parenthetical clauses: wrap in comma breaths for pitch/cadence modulation
  { re: /\s*\(([^)]+)\)\s*/g, rep: ', $1, ' },

  // 6. Cleanup stacked commas or extra whitespace introduced by prosody insertion
  { re: /,\s*,+/g, rep: ', ' },
  { re: /[ \t]{2,}/g, rep: ' ' }
];

/**
 * Apply context-aware prosody pauses and punctuation cadence to spoken text.
 * @param {string} text
 * @returns {string}
 */
export function applyProsodyCadence(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const rule of _PROSODY_RULES) {
    out = out.replace(rule.re, rule.rep);
  }
  out = out.trim();
  return out.length > 0 ? out : text.trim();
}
// ─────────────────────────────────────────────────────────────────────────────

export class PlaybackManager {
  constructor() {
    this.queue = [];
    this.currentIndex = 0;
    this.playbackState = PlaybackState.IDLE;
    this.tabId = null;
    this.allVoices = [];
    this.options = {
      rate: 1.0,
      pitch: 1.0,
      volume: 1.0,
      voiceName: null,
      extensionId: null,
      lang: null
    };
    this.isSwitchingSentence = false;
    this.playbackRunId = 0;
    // True while THIS worker instance owns an in-flight utterance. Used to tell
    // "speaking normally" apart from "the worker was restarted mid-sentence and
    // the utterance's end event was lost".
    this.awaitingSpeech = false;
    this.consecutiveErrors = 0;
    // Word-offset tracking for pause/resume without rewinding, and for the
    // watchdog remainder re-queue. Absolute char index into the FULL sentence.
    this.lastWordCharIndex = 0;
    this.sawWordEvents = false;
    // Which sentence that offset belongs to. Offsets are per sentence, so one
    // left over from the previous sentence is never valid for the next one.
    this.lastWordSentence = -1;
    // False when any rewrite (citation noise, prosody, pronunciation) changed
    // the spoken form of a sentence in the current batch: word events then
    // index the rewritten text and cannot be mapped onto the page.
    this.wordEventsUsable = true;
    this.resumeOffset = 0;
    // SW-side keep-alive interval handle (see _syncKeepAliveTick).
    this._keepAliveTimer = null;
    // Explicit grouping override (0 = automatic).
    this.batchSize = 0;
    // True once the user has picked a voice themselves. Until then the voice is
    // resolved automatically (highest-priority engine, Kokoro first), which is
    // what migrates a legacy Supertonic preference over to Kokoro.
    this.voicePinned = false;
    // Measured speaking speed in characters per second, used by the position
    // estimator when the engine does not emit word/sentence events.
    this.charsPerSecond = 0;
    // Lead-in delay: the seconds a network voice spends preparing the
    // synthesis before the first word of an utterance is audible. Measured
    // against the real Supertonic engine at ~3.2 s; learned and refined from
    // the engine's own sentence boundaries as reading continues.
    this.leadInMs = 3200;
    // What we have learned about each TTS engine, keyed by extension id.
    //
    //   prepareMs          time from the engine's 'start' event to its first
    //                       boundary — the engine's setup cost per utterance.
    //   baseCharsPerSecond measured speaking rate at 1.0x rate.
    //   leadInMs           delay between announcing a boundary and the voice
    //                       becoming audible (Supertonic only).
    //   boundariesSeen      how many boundaries the engine has reported.
    //
    // Keeping this per engine matters: the two engines behave completely
    // differently (Kokoro rebuilds its model per utterance, Supertonic waits on
    // a network round-trip), so their measurements must never be mixed.
    this.engineProfiles = new Map();
    // Active utterance descriptor + estimator timer.
    this.activeBatch = null;
    this.estimatorTimer = null;
    // True when the persisted queue no longer matches this.queue, so the next
    // saveToSession() has to write it. Cleared only after a successful write.
    this._queueDirty = true;
  }

  /**
   * The measurement profile of the engine that is currently speaking.
   * @returns {{prepareMs:number, baseCharsPerSecond:number, leadInMs:number, boundariesSeen:number}}
   */
  engineProfile() {
    const id = this.options.extensionId || 'system';
    let profile = this.engineProfiles.get(id);
    if (!profile) {
      profile = {
        prepareMs: 0,
        baseCharsPerSecond: 0,
        leadInMs: 0,
        boundariesSeen: 0,
        // Average rate between sentence boundaries. It includes the gaps an
        // engine leaves when it cannot synthesise as fast as it plays, so it
        // is the speed at which the reader really HEARS the text.
        intervalCps: 0,
        intervalSamples: 0,
        // True when the engine measurably cannot keep up.
        starving: false
      };
      this.engineProfiles.set(id, profile);
    }
    return profile;
  }

  /**
   * The speaking rate to use right now: the measured rate of this engine,
   * scaled by the rate slider (the engine speeds the audio up, so the number
   * of characters read per second scales with it too).
   */
  effectiveCharsPerSecond() {
    const profile = this.engineProfile();
    const base = profile.baseCharsPerSecond > 0
      ? profile.baseCharsPerSecond
      : (this.charsPerSecond > 0 ? this.charsPerSecond : 0);
    if (base > 0) return base * (this.options.rate || 1);
    return DEFAULT_CHARS_PER_SECOND * (this.options.rate || 1);
  }

  /**
   * Normalise an incoming sentence queue.
   *
   * Accepts [{ text }] objects or plain strings and drops anything without
   * usable text. Without this a malformed runtime message (null entry, missing
   * `text`, non-string) reaches speakCurrentSentence() and throws a TypeError
   * on `sentenceItem.text` — which surfaces as an unhandled rejection and an
   * endless recovery loop in the keep-alive heartbeat.
   *
   * @param {any} sentences Raw payload
   * @returns {Array<{index:number, text:string}>} Clean queue (possibly empty)
   */
  static sanitizeQueue(sentences) {
    const clean = [];
    if (!Array.isArray(sentences)) return clean;
    const limit = Math.min(sentences.length, 5000);
    for (let i = 0; i < limit; i++) {
      const item = sentences[i];
      let text = null;
      if (typeof item === 'string') {
        text = item;
      } else if (item && typeof item === 'object' && typeof item.text === 'string') {
        text = item.text;
      }
      if (typeof text !== 'string' || text.trim().length === 0) continue;
      clean.push({ index: clean.length, text });
    }
    return clean;
  }

  /**
   * Keep THIS service worker alive while playback is PLAYING.
   *
   * Why this exists: Chrome terminates an MV3 service worker after ~30 s
   * without extension-API activity. During playback the only guaranteed
   * activity was the content-script heartbeat — a setInterval living in the
   * READING TAB. Switch away from that tab and Chrome throttles its timers
   * (intensively after the tab stays hidden for 5 minutes, per the Chrome 88+
   * timer-throttling rules) and can freeze the page outright: heartbeats
   * stop → the worker dies mid-utterance → the utterance's 'end' event is
   * lost → reading stalls silently until the 30 s keep-alive alarm wakes the
   * worker and recovery replays the current sentence. User-visible symptom:
   * "when I change tabs, the reading pauses after a few moments."
   *
   * The fix: while PLAYING, the worker pings a cheap extension API of its
   * own every 15 s. Extension-API calls reset the idle timer (official
   * lifecycle docs, Chrome 110+), and worker-side timers are never throttled
   * the way hidden-tab timers are. The 30 s alarm remains the safety net
   * that revives a dead worker; the content-script heartbeat remains as a
   * harmless second belt.
   */
  _syncKeepAliveTick() {
    const want = this.playbackState === PlaybackState.PLAYING;
    if (want && this._keepAliveTimer === null) {
      this._keepAliveTimer = setInterval(() => {
        // Any extension API call resets the 30 s idle timer; read a key we
        // already own and ignore the value and any error.
        chrome.storage.session.get(SESSION_STORAGE_KEY).catch(() => {});
      }, 15000);
    } else if (!want && this._keepAliveTimer !== null) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }
  }

  /**
   * Save active playback session to chrome.storage.session.
   * Caps the persisted queue size to stay well within the 10 MB session storage
   * quota — on pathological pages the queue can grow to thousands of entries.
   */
  async saveToSession() {
    // Called after EVERY playback-state transition (start, per-sentence,
    // pause, resume, stop, skip, error paths) — the one hook that reliably
    // keeps the SW-side keep-alive tick in sync with the state.
    this._syncKeepAliveTick();
    try {
      const data = {
        currentIndex: this.currentIndex,
        playbackState: this.playbackState,
        tabId: this.tabId,
        options: this.options,
        resumeOffset: this.resumeOffset || 0,
        queueLength: this.queue.length,
        timestamp: Date.now()
      };

      if (!this._queueDirty) {
        await chrome.storage.session.set({ [SESSION_STORAGE_KEY]: data });
        return;
      }

      // Cap persisted queue: 5000 sentences (matches sanitizeQueue) × ~100
      // chars ≈ 500 KB — well within the 10 MB session storage quota. The
      // old 2000 cap silently truncated long papers on worker restart.
      const MAX_PERSISTED = 5000;
      const persistedQueue = this.queue.length > MAX_PERSISTED
        ? this.queue.slice(0, MAX_PERSISTED)
        : this.queue;
      await chrome.storage.session.set({
        [SESSION_QUEUE_KEY]: persistedQueue,
        [SESSION_STORAGE_KEY]: data
      });
      // Only clear the flag once the write really succeeded — a failed write
      // must be retried by the next save, not silently dropped.
      this._queueDirty = false;
    } catch (err) {
      console.warn('[PlaybackManager] Failed to write to chrome.storage.session:', err);
    }
  }

  /**
   * Restore playback session from chrome.storage.session.
   */
  async restoreFromSession() {
    try {
      const res = await chrome.storage.session.get([SESSION_STORAGE_KEY, SESSION_QUEUE_KEY]);
      const data = res[SESSION_STORAGE_KEY];
      // Sessions written by 1.4.x stored the queue inside the state object;
      // 1.5.0 stores it under its own key. Read both so upgrading users keep
      // the session they were in the middle of.
      const storedQueue = Array.isArray(res[SESSION_QUEUE_KEY])
        ? res[SESSION_QUEUE_KEY]
        : (Array.isArray(data && data.queue) ? data.queue : null);
      if (data && storedQueue && storedQueue.length > 0) {
        const queue = PlaybackManager.sanitizeQueue(storedQueue);
        if (queue.length === 0) {
          console.warn('[PlaybackManager] Stored session had no usable sentences — discarding.');
          return false;
        }
        this.queue = queue;
        // The persisted queue may have been truncated by saveToSession(), so the
        // stored index can point past the end — clamp it instead of letting
        // queue[index] come back undefined.
        const storedIndex = typeof data.currentIndex === 'number' && Number.isFinite(data.currentIndex)
          ? Math.trunc(data.currentIndex)
          : 0;
        this.currentIndex = Math.max(0, Math.min(storedIndex, this.queue.length - 1));
        this.playbackState = data.playbackState || PlaybackState.IDLE;
        this.tabId = typeof data.tabId === 'number' ? data.tabId : null;
        this.resumeOffset = typeof data.resumeOffset === 'number' ? Math.max(0, data.resumeOffset) : 0;
        if (data.options) {
          this.allVoices = [];
          this.options = { ...this.options, ...data.options };
        }
        // The queue came from storage, so it is already persisted.
        this._queueDirty = false;
        console.log(`[PlaybackManager] Restored session: ${this.queue.length} sentences, index ${this.currentIndex}, state: ${this.playbackState}`);
        return true;
      }
    } catch (err) {
      console.warn('[PlaybackManager] Failed to restore from chrome.storage.session:', err);
    }
    return false;
  }

  /**
   * Drop all playback state (used when the owning tab no longer exists).
   */
  async reset() {
    this.playbackRunId = (this.playbackRunId || 0) + 1;
    // Silence the engine too. reset() runs when the owning tab is gone or the
    // restored session belongs to a closed tab; clearing the queue without
    // stopping TTS left the last utterance speaking with no UI attached and
    // no way for the user to stop it.
    this.isSwitchingSentence = true;
    this.awaitingSpeech = false;
    await stopSpeechAndWait();
    this.queue = [];
    this.currentIndex = 0;
    this.playbackState = PlaybackState.IDLE;
    this.tabId = null;
    this.awaitingSpeech = false;
    this.isSwitchingSentence = false;
    this.consecutiveErrors = 0;
    this.stopEstimator();
    this.activeBatch = null;
    this.resumeOffset = 0;
    this.lastWordCharIndex = 0;
    this.sawWordEvents = false;
    this.lastWordSentence = -1;
    this._queueDirty = true;   // overwrite the stored queue with the empty one
    await this.saveToSession();
  }

  /**
   * Wait until the TTS engine reports idle.
   * @param {number} timeoutMs Give up after this long
   * @returns {Promise<boolean>} true if the engine went idle, false on timeout
   */
  waitForSpeechIdle(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const poll = () => {
        isSpeaking()
          .then((speaking) => {
            if (!speaking) resolve(true);
            else if (Date.now() >= deadline) resolve(false);
            else setTimeout(poll, 100);
          })
          .catch(() => resolve(false));
      };
      poll();
    });
  }

  /**
   * Recover playback after the service worker was restarted mid-sentence.
   *
   * Case A — nothing is speaking: the worker died before or during starting
   * the utterance. Speak the current sentence again.
   *
   * Case B — something IS speaking: the utterance outlived the worker (it is
   * owned by the browser process) but its 'end' event died with the worker, so
   * the queue would never advance. Wait for it to finish, then continue with
   * the NEXT sentence rather than repeating the current one.
   */
  async recoverAfterWorkerRestart() {
    if (this.playbackState !== PlaybackState.PLAYING) return;
    if (this.queue.length === 0) return;

    // Hold the keep-alive heartbeat off while we recover, so it cannot start a
    // second recovery chain on top of this one during the awaits below.
    this.isSwitchingSentence = true;

    const speaking = await isSpeaking();
    if (!speaking) {
      console.log('[PlaybackManager] Recovering interrupted playback at sentence #', this.currentIndex + 1);
      this.isSwitchingSentence = false;
      this.speakCurrentSentence(this.playbackRunId);
      return;
    }

    console.warn('[PlaybackManager] Worker restarted mid-utterance — waiting for it to finish.');
    const wentIdle = await this.waitForSpeechIdle(10000);
    if (this.playbackState !== PlaybackState.PLAYING) return;
    if (wentIdle) {
      // The orphaned utterance completed; its event was lost, so advance here.
      this.currentIndex++;
      if (this.currentIndex >= this.queue.length) {
        console.log('[PlaybackManager] Recovered queue finished after last sentence.');
        this.playbackState = PlaybackState.STOPPED;
        this.currentIndex = 0;
        await this.saveToSession();
        this.broadcast('PLAYBACK_COMPLETED');
        return;
      }
    } else {
      // The orphaned utterance is STILL talking after the wait and we have no
      // idea where it is. Silencing it before restarting the sentence is the
      // only safe move — speaking now would play the same sentence twice at
      // the same time.
      console.warn('[PlaybackManager] Orphaned utterance never went idle — stopping it before recovery.');
      await stopSpeechAndWait(1000);
      if (this.playbackState !== PlaybackState.PLAYING) return;
    }
    await this.saveToSession();
    this.isSwitchingSentence = false;
    this.speakCurrentSentence(this.playbackRunId);
  }

  /**
   * Load user persistent preferences from chrome.storage.local.
   */
  async loadPreferences() {
    try {
      const res = await chrome.storage.local.get(PREFS_STORAGE_KEY);
      const prefs = res[PREFS_STORAGE_KEY];
      if (prefs) {
        if (typeof prefs.rate === 'number') this.options.rate = prefs.rate;
        if (typeof prefs.pitch === 'number') this.options.pitch = prefs.pitch;
        if (typeof prefs.volume === 'number') this.options.volume = prefs.volume;
        if (prefs.voiceName) this.options.voiceName = prefs.voiceName;
        if (prefs.extensionId) this.options.extensionId = prefs.extensionId;
        if (prefs.lang) this.options.lang = prefs.lang;
        // voicePinned was added together with multi-engine support. Preferences
        // saved before that have no such flag, so their voice was merely the
        // old automatic default (Supertonic) — not a choice the user made.
        this.voicePinned = prefs.voicePinned === true;
        if (typeof prefs.pronunciationText === 'string') {
          this.pronunciationRules = PlaybackManager.parsePronunciations(prefs.pronunciationText);
        }
        if (typeof prefs.batchSize === 'number') this.batchSize = prefs.batchSize;
        console.log('[PlaybackManager] Loaded user preferences:', prefs);
      }

      // Resolve the voice against the engines that are actually installed.
      // A voice the user picked themselves always wins; otherwise the
      // highest-priority engine does (Kokoro before Supertonic), which is what
      // moves a legacy Supertonic preference over to Kokoro.
      const report = await detectAndSelectVoice({
        voiceName: this.options.voiceName,
        pinned: this.voicePinned
      });
      this.allVoices = report.allVoices || [];
      if (report.selectedVoice) {
        const changed = report.selectedVoice.voiceName !== this.options.voiceName ||
          (report.selectedVoice.extensionId || null) !== (this.options.extensionId || null);
        this.options.voiceName = report.selectedVoice.voiceName;
        this.options.extensionId = report.selectedVoice.extensionId || null;
        this.options.lang = report.selectedVoice.lang || null;
        this.engineLabel = report.engineLabel;
        this.engineBadge = report.engineBadge;
        this.voiceStatus = report.statusMessage;
        if (changed) {
          console.log(`[PlaybackManager] Voice resolved to "${report.selectedVoice.voiceName}" (${report.engineLabel}).`);
          await this.savePreferences();
        }
      }
    } catch (err) {
      console.warn('[PlaybackManager] Failed to load preferences from local storage:', err);
    }
  }

  /**
   * Set how many sentences share one utterance.
   * 0 = automatic (grouped for network voices, one at a time for local voices).
   * @param {number} size 0..MAX_BATCH_SENTENCES
   */
  async setBatchSize(size) {
    const n = typeof size === 'number' && Number.isFinite(size) ? Math.trunc(size) : 0;
    const next = (n >= 1 && n <= MAX_BATCH_SENTENCES) ? n : 0;
    if (next !== this.batchSize) {
      this.batchSize = next;
      await this.savePreferences();
      console.log('[PlaybackManager] Sentence grouping set to', next === 0 ? 'auto' : next);
    }
    return this.batchSize;
  }

  /**
   * Re-resolve the automatic voice.
   *
   * A TTS engine extension registers its voices a moment AFTER Chrome starts
   * it, so at worker start-up the voice list can still be empty (or contain
   * only the built-in Google voices). Chrome announces every change of the
   * voice list through chrome.tts.onVoicesChanged, and this runs again then —
   * which is how the preferred engine (Kokoro) takes over as soon as it
   * appears.
   *
   * A voice the user picked themselves is never touched.
   */
  async refreshVoice() {
    if (this.voicePinned) return null;

    const report = await detectAndSelectVoice({
      voiceName: this.options.voiceName,
      pinned: false
    });
    this.allVoices = report.allVoices || [];
    this.engineLabel = report.engineLabel;
    this.engineBadge = report.engineBadge;
    this.voiceStatus = report.statusMessage;
    if (!report.selectedVoice) return null;

    const changed = report.selectedVoice.voiceName !== this.options.voiceName ||
      (report.selectedVoice.extensionId || null) !== (this.options.extensionId || null);
    if (!changed) return report.selectedVoice;

    this.options.voiceName = report.selectedVoice.voiceName;
    this.options.extensionId = report.selectedVoice.extensionId || null;
    this.options.lang = report.selectedVoice.lang || null;
    console.log(`[PlaybackManager] Voice switched to "${report.selectedVoice.voiceName}" (${report.engineLabel}).`);
    await this.savePreferences();
    this.broadcast('VOICE_CHANGED', {
      voiceName: this.options.voiceName,
      extensionId: this.options.extensionId,
      lang: this.options.lang,
      engineLabel: report.engineLabel,
      engineBadge: report.engineBadge,
      statusMessage: report.statusMessage
    });
    return report.selectedVoice;
  }

  /**
   * Save user persistent preferences to chrome.storage.local.
   */
  async savePreferences() {
    try {
      // Read-modify-write so fields saved elsewhere (pronunciationText) survive.
      const res = await chrome.storage.local.get(PREFS_STORAGE_KEY);
      const prefs = (res && res[PREFS_STORAGE_KEY]) || {};
      prefs.rate = this.options.rate;
      prefs.pitch = this.options.pitch;
      prefs.volume = this.options.volume;
      prefs.voiceName = this.options.voiceName;
      prefs.extensionId = this.options.extensionId;
      prefs.lang = this.options.lang;
      prefs.voicePinned = this.voicePinned;
      prefs.batchSize = this.batchSize;
      await chrome.storage.local.set({ [PREFS_STORAGE_KEY]: prefs });
    } catch (err) {
      console.warn('[PlaybackManager] Failed to save preferences to local storage:', err);
    }
  }

  /**
   * Notify listening tabs and popup of playback state changes.
   */
  broadcast(action, payload = {}) {
    const message = {
      action,
      state: this.playbackState,
      currentIndex: this.currentIndex,
      totalSentences: this.queue.length,
      currentSentence: this.queue[this.currentIndex] || null,
      options: this.options,
      ...payload
    };

    // Send to initiating tab
    if (this.tabId) {
      chrome.tabs.sendMessage(this.tabId, message).catch(() => {
        // Tab may have closed or reloaded
      });
    }

    // Broadcast to any open popup / test page / side panel
    chrome.runtime.sendMessage(message).catch(() => {
      // Ignore when no extension popup view is open
    });
  }

  /**
   * Start reading a new sentence queue.
   * Cancels any ongoing playback immediately and starts the new queue cleanly.
   */
  async start(sentences, startIndex = 0, tabId = null, userOptions = {}) {
    const queue = PlaybackManager.sanitizeQueue(sentences);
    if (queue.length === 0) {
      console.warn('[PlaybackManager] Cannot start: no usable sentences in payload.');
      return false;
    }

    // Remember the previous owner before we overwrite the state below, so we
    // can tell the old tab that it was preempted.
    const previousTabId = this.tabId;
    const previousStateWasActive =
      this.playbackState === PlaybackState.PLAYING ||
      this.playbackState === PlaybackState.PAUSED;

    // Increment run ID to invalidate any prior speaking loop immediately
    this.playbackRunId = (this.playbackRunId || 0) + 1;
    this.isSwitchingSentence = true;
    this.awaitingSpeech = false;
    this.consecutiveErrors = 0;
    await stopSpeechAndWait();

    this.queue = queue;
    this._queueDirty = true;
    const safeStartIndex = typeof startIndex === 'number' && Number.isFinite(startIndex)
      ? Math.trunc(startIndex)
      : 0;
    this.currentIndex = Math.max(0, Math.min(safeStartIndex, this.queue.length - 1));
    this.tabId = typeof tabId === 'number' ? tabId : null;
    this.playbackState = PlaybackState.PLAYING;

    // Tell the previously-playing tab (if it is a different tab) to reset its
    // pill UI. Audio has already been stopped by stopSpeechAndWait() above;
    // this only syncs the on-screen state so Tab A's pill does not keep
    // showing PLAYING while Tab B is the active speaker.
    if (previousStateWasActive
        && typeof previousTabId === 'number'
        && previousTabId !== this.tabId) {
      chrome.tabs.sendMessage(previousTabId, {
        action: 'PLAYBACK_STOPPED',
        state: PlaybackState.STOPPED,
        currentIndex: 0,
        reason: 'preempted-by-other-tab'
      }).catch(() => {
        // Tab may already be closed — ignore.
      });
    }

    // Merge options
    if (userOptions) {
      if (typeof userOptions.rate === 'number') this.options.rate = userOptions.rate;
      if (typeof userOptions.pitch === 'number') this.options.pitch = userOptions.pitch;
      if (userOptions.voiceName) this.options.voiceName = userOptions.voiceName;
      if (userOptions.extensionId) this.options.extensionId = userOptions.extensionId;
      if (userOptions.lang) this.options.lang = userOptions.lang;
    }

    // If no voice set, resolve default voice
    if (!this.options.voiceName) {
      const voiceReport = await detectAndSelectVoice({
        voiceName: this.options.voiceName,
        pinned: this.voicePinned
      });
      if (voiceReport.selectedVoice) {
        this.options.voiceName = voiceReport.selectedVoice.voiceName;
        this.options.extensionId = voiceReport.selectedVoice.extensionId || null;
        this.options.lang = voiceReport.selectedVoice.lang || null;
        this.engineLabel = voiceReport.engineLabel;
        this.engineBadge = voiceReport.engineBadge;
        this.voiceStatus = voiceReport.statusMessage;
      }
    } else if (!this.voicePinned) {
      // An engine extension registers its voices a moment after Chrome starts
      // it, so the list can have been incomplete when this worker woke up.
      // Re-resolve right before the first utterance — this is the moment the
      // voice actually matters.
      try {
        await this.refreshVoice();
      } catch (err) {
        console.warn('[PlaybackManager] Voice refresh failed:', err && err.message);
      }
    }

    await this.saveToSession();
    this.speakCurrentSentence(this.playbackRunId);
    return true;
  }

  /**
   * How many consecutive sentences share one utterance.
   *
   * An engine that has to prepare before it can speak pays that preparation on
   * EVERY utterance. Measured against the real engines: Kokoro rebuilds its
   * ONNX model and its offscreen document for every utterance, which costs
   * ~10 s on a CPU-only machine (~24 s the very first time, while its 92 MB
   * model downloads); Supertonic waits on a network round-trip. One sentence
   * per utterance would therefore put a long gap between every sentence.
   *
   * So the group size follows the engine's MEASURED preparation time: the
   * preparation may cost at most ~15% of the speech it precedes. A fast engine
   * (Kokoro with WebGPU, ~1 s setup) gets short groups and stays responsive for
   * skipping; a slow one gets long groups and reads almost seamlessly.
   */
  resolveBatchSize() {
    if (typeof this.batchSize === 'number' && this.batchSize > 0) {
      return Math.min(Math.trunc(this.batchSize), MAX_BATCH_SENTENCES);
    }

    const profile = this.engineProfile();
    const prepareMs = profile.prepareMs || 0;
    if (profile.starving) {
      // The engine cannot synthesise as fast as it plays, so it goes silent
      // between the sentences of one utterance. A long group would be a long
      // series of gaps — keep it short.
      return Math.min(4, MAX_BATCH_SENTENCES);
    }
    if (!profile.boundariesSeen) {
      // The engine has not reported a boundary yet, so its setup cost is
      // unknown. Start small so the very first utterance is quick, then let
      // the measurement adapt the group size.
      return DEFAULT_REMOTE_BATCH;
    }

    const cps = profile.baseCharsPerSecond > 0
      ? profile.baseCharsPerSecond
      : DEFAULT_CHARS_PER_SECOND;
    const speechPerSentence = TYPICAL_SENTENCE_CHARS / cps;   // seconds
    const sentences = Math.ceil(
      (prepareMs / 1000 / PREPARE_BUDGET_RATIO) / speechPerSentence
    );
    return Math.max(1, Math.min(MAX_BATCH_SENTENCES, sentences));
  }

  /**
   * Build the utterance for the current position.
   *
   * Returns the items to speak, the character offset of each item inside the
   * utterance, and the utterance text itself. Grouping is skipped whenever it
   * would break the text↔offset mapping:
   *   - a resume offset (only the first sentence can start mid-way)
   *   - a pronunciation override that rewrote the text
   *
   * @param {number} firstIndex Queue index the utterance starts at
   * @param {number} offset Character offset to resume the first sentence from
   */
  buildBatch(firstIndex, offset) {
    const size = this.resolveBatchSize();
    const items = [];
    const offsets = [];
    const spokenTexts = [];
    // Per sentence: is the spoken form byte-for-byte the source sentence?
    // Only then does a spoken char index equal a page char index.
    const wordAligned = [];
    let pronunciationChanged = false;
    let acc = 0;

    let firstScript = null;
    for (let k = 0; k < size && firstIndex + k < this.queue.length; k++) {
      const item = this.queue[firstIndex + k];
      if (!item || typeof item.text !== 'string' || item.text.trim().length === 0) break;
      // A resume offset applies to the first sentence only.
      if (k > 0 && offset > 0) break;

      // Do not group sentences with different scripts into one utterance so each language
      // can be spoken by its native voice.
      const script = detectScript(item.text);
      if (k === 0) {
        firstScript = script;
      } else if (script !== firstScript) {
        break;
      }

      const source = k === 0
        ? item.text.substring(Math.max(0, Math.min(offset, item.text.length)))
        : item.text;
      if (source.trim().length === 0) break;
      // Strip citations, URLs, footnotes etc. for speech only.
      // item.text is never mutated — highlights stay accurate.
      const clean   = stripSemanticNoise(source);
      const cadence = applyProsodyCadence(clean);
      const norm    = this.applyPronunciations(cadence);

      items.push(item);
      spokenTexts.push(norm.text);
      offsets.push(acc);
      wordAligned.push(norm.text === source);
      acc += norm.text.length + 1; // +1 for the joining space

      // Rewritten text can no longer be matched to the original offsets.
      if (norm.changed) {
        pronunciationChanged = true;
        break;
      }
    }

    if (items.length === 0) return null;

    return {
      items,
      offsets,
      spokenTexts,
      // A word offset may only be treated as a page offset for `true` slots.
      wordAligned,
      spokenLengths: spokenTexts.map((t) => t.length),
      text: spokenTexts.join(' '),
      firstIndex,
      resumeOffset: offset,
      pronunciationChanged,
      // Estimator anchor. The engine's 'sentence' events carry an exact
      // charIndex into the spoken text — ground truth for "the voice is
      // here". anchorChar/anchorTime is the most recent such boundary;
      // segmentIndex counts how many boundaries have been seen, so the
      // estimator knows whether it is still inside the utterance's lead-in.
      anchorChar: null,
      anchorTime: null,
      segmentIndex: 0,
      // Delay between the engine's 'start' event and its first boundary.
      // null until the first boundary arrives. It is the engine's preparation
      // cost, and it decides both the lead-in correction and the group size.
      firstBoundaryDelay: null
    };
  }

  /**
   * Map a character position inside the utterance back to a queue sentence.
   * @returns {{sentenceIndex:number, offset:number}|null}
   */
  locateInBatch(batch, pos) {
    if (!batch || typeof pos !== 'number' || !Number.isFinite(pos)) return null;
    for (let i = batch.offsets.length - 1; i >= 0; i--) {
      const start = batch.offsets[i];
      if (pos >= start) {
        const len = batch.spokenLengths[i] || 0;
        return {
          sentenceIndex: batch.firstIndex + i,
          offset: Math.max(0, Math.min(pos - start, len))
        };
      }
    }
    return null;
  }

  /**
   * Can a word offset for this sentence be applied to the page?
   *
   * Word events index the SPOKEN text. `buildBatch()` records, per sentence,
   * whether that text is byte-for-byte the source sentence; it is not once a
   * citation, URL, em-dash, parenthesis or pronunciation rule rewrote it. Only
   * an aligned sentence may turn an engine offset into a highlight or a resume
   * point — everything else keeps sentence-level tracking only.
   */
  canMapWordOffset(batch, sentenceIndex) {
    if (!batch || !Array.isArray(batch.wordAligned)) return false;
    const slot = sentenceIndex - batch.firstIndex;
    return batch.wordAligned[slot] === true;
  }

  /**
   * The only word offset allowed to survive into a resume.
   *
   * Conservative by design: returns 0 unless the last word event came from the
   * sentence that is current NOW and that sentence's spoken form is identical
   * to the page text. A general speech-index → page-index map through every
   * rewrite was deliberately rejected: restarting one sentence is cheaper and
   * far more reliable than cutting into the middle of a word.
   */
  validResumeOffset() {
    if (!this.sawWordEvents) return 0;
    if (this.lastWordSentence !== this.currentIndex) return 0;
    const item = this.queue[this.currentIndex];
    if (!item || typeof item.text !== 'string') return 0;
    const offset = this.lastWordCharIndex;
    return (offset > 0 && offset < item.text.length) ? offset : 0;
  }

  /**
   * Record a word position — but only if it indexes the page text.
   *
   * @returns {boolean} true when the position was usable (and the caller may
   *   broadcast it as aligned).
   */
  recordWordPosition(batch, sentenceIndex, pageOffset) {
    const mapped = this.canMapWordOffset(batch, sentenceIndex);
    if (mapped) {
      this.lastWordCharIndex = pageOffset;
      this.sawWordEvents = true;
      this.lastWordSentence = sentenceIndex;
    } else {
      // An offset into a rewrite is not a page offset. Drop it, and drop any
      // offset inherited from an earlier sentence with it.
      this.lastWordCharIndex = 0;
      this.sawWordEvents = false;
      this.lastWordSentence = -1;
    }
    return mapped;
  }

  /**
   * Move the reader's position to a sentence and tell the UI about it.
   */
  setCurrentSentence(sentenceIndex, batch) {
    if (typeof sentenceIndex !== 'number' || !Number.isFinite(sentenceIndex)) return;
    const changed = batch.currentSentence !== sentenceIndex;
    batch.currentSentence = sentenceIndex;
    this.currentIndex = sentenceIndex;

    if (!changed) return;
    const item = this.queue[sentenceIndex];
    this.broadcast('SENTENCE_CHANGED', {
      index: sentenceIndex,
      sentence: item,
      totalSentences: this.queue.length,
      resumeOffset: (sentenceIndex === batch.firstIndex && batch.resumeOffset > 0) ? batch.resumeOffset : 0,
      wordAligned: this.canMapWordOffset(batch, sentenceIndex)
    });
  }

  /**
   * Remember how long the engine needed before its first boundary.
   *
   * That delay is the engine's preparation cost for this utterance (measured:
   * ~10 s per utterance for Kokoro on a CPU-only machine, ~24 s while its
   * 92 MB model downloads, ~3.2 s for Supertonic's network round-trip).
   * It decides two things: the lead-in correction and the group size.
   */
  noteFirstBoundary(batch, now) {
    if (!batch || batch.firstBoundaryDelay !== null) return;
    // Measure from the REQUEST, not from the engine's 'start' event. An
    // engine that spends time preparing before it announces anything
    // (Supertonic: 2.6 s on its first request) would otherwise report a
    // preparation cost of ~0, and the group size would be based on a lie.
    const origin = batch.requestedAt || batch.startedAt || now;
    const delay = now - origin;
    if (delay < 0) return;
    batch.firstBoundaryDelay = delay;
    // The moment of the FIRST boundary. The stretch from there to the 'end'
    // event is the whole utterance — the cleanest rate measurement there is,
    // because no announcement gap and no preparation is folded into it.
    if (batch.firstBoundaryTime === undefined || batch.firstBoundaryTime === null) {
      batch.firstBoundaryTime = now;
    }

    const profile = this.engineProfile();
    profile.prepareMs = profile.prepareMs > 0
      ? (profile.prepareMs * 0.7 + delay * 0.3)
      : delay;
    profile.boundariesSeen++;
  }

  /**
   * Translate a raw chrome.tts event into reader positions.
   *
   * Native 'word' events carry a charIndex into the spoken text — that is
   * exactly what the word highlight needs. Engines that do not implement word
   * boundaries (a network TTS usually does not) simply never send them, and
   * the estimator takes over.
   */
  handleTtsEvent(event, batch) {
    if (!event || !batch) return;

    if (event.type === 'start') {
      batch.startedAt = Date.now();
      this.startEstimator(batch);
      return;
    }

    if (event.type === 'sentence') {
      batch.sawSentences = true;
      const now = Date.now();
      const charIndex = event.charIndex || 0;
      const profile = this.engineProfile();

      // How long is the sentence the engine just announced? Some engines
      // report it (Supertonic sends charIndex + length), others do not
      // (Kokoro sends only the charIndex). When it is known, the estimator
      // uses the ENGINE's sentence extent as its ceiling — see startEstimator().
      //
      // The engine's sentences do not have to be ours: Supertonic merges our
      // title with the sentence after it (the title has no terminating
      // punctuation), so its boundary at charIndex 101 is really the start of
      // OUR third sentence while its first sentence covered our first two.
      const engineLength = (typeof event.length === 'number' && event.length > 0)
        ? event.length
        : ((typeof event.charLength === 'number' && event.charLength > 0)
          ? event.charLength
          : 0);
      batch.anchorEnd = engineLength > 0 ? charIndex + engineLength : null;

      // The engine's sentence boundary is GROUND TRUTH for "the voice is
      // exactly here" — it carries the precise charIndex of the sentence
      // inside the spoken text. Re-anchor the estimator on it, and learn two
      // things from the distance between two boundaries:
      //
      //   * the steady speaking rate, and
      //   * the lead-in delay — the seconds the engine spends preparing the
      //     synthesis before the first word of an audible.
      //
      // Both were measured against the real engines:
      //
      //   Supertonic announces 'start' and the first sentence boundary at the
      //   same instant and only becomes audible ~3.2 s later, so its first
      //   boundary interval is slower than the real speaking rate.
      //
      //   Kokoro announces the boundary when that sentence actually starts
      //   playing — ~10 s after 'start', because it rebuilds its model for
      //   every utterance — so its intervals are pure playback.
      //
      // A lead-in can only make an interval SLOWER, never faster, so the
      // fastest interval observed is the cleanest rate measurement and the
      // first interval's excess over that rate is the lead-in.
      if (batch.anchorTime !== null && charIndex !== batch.anchorChar &&
          now > batch.anchorTime) {
        const seconds = (now - batch.anchorTime) / 1000;
        const chars = charIndex - batch.anchorChar;
        const cps = seconds > 0 ? chars / seconds : 0;

        if (cps > 1 && cps < 200) {
          // The interval rate is what the reader actually hears (it includes
          // any gap the engine left), so it is tracked separately from the
          // clean playback rate.
          const intervalUnitCps = cps / (this.options.rate || 1);
          profile.intervalCps = profile.intervalSamples > 0
            ? (profile.intervalCps * 0.7 + intervalUnitCps * 0.3)
            : intervalUnitCps;
          profile.intervalSamples++;

          // Normalise to a 1.0x rate: the engine speeds the audio up, so the
          // number of characters per second scales with the rate slider.
          const unitCps = cps / (this.options.rate || 1);
          if (profile.baseCharsPerSecond <= 0 || unitCps > profile.baseCharsPerSecond) {
            profile.baseCharsPerSecond = unitCps;
          } else {
            // Follow the engine down slowly (the rate slider can lower it),
            // but never below a clean measurement.
            profile.baseCharsPerSecond = profile.baseCharsPerSecond * 0.98 + unitCps * 0.02;
          }
          this.charsPerSecond = profile.baseCharsPerSecond;
        }

        // The lead-in only exists when the engine announces the boundary
        // BEFORE the voice starts — that is, when its first boundary arrived
        // together with 'start' rather than when the speech actually began.
        if (batch.segmentIndex === 0 && batch.firstBoundaryDelay <= BOUNDARY_ANNOUNCED_EARLY_MS) {
          const steady = profile.baseCharsPerSecond > 0
            ? profile.baseCharsPerSecond
            : DEFAULT_CHARS_PER_SECOND;
          const speechSeconds = chars / (steady * (this.options.rate || 1));
          const leadInMs = Math.max(0, (seconds - speechSeconds) * 1000);
          profile.leadInMs = profile.leadInMs > 0
            ? (profile.leadInMs * 0.6 + leadInMs * 0.4)
            : leadInMs;
          this.leadInMs = profile.leadInMs;
        }
        batch.segmentIndex++;
      }

      // The very first boundary also tells us how long the engine needed to
      // get ready — its preparation cost for this utterance. That number
      // decides how many sentences are worth grouping together.
      this.noteFirstBoundary(batch, now);

      batch.anchorChar = charIndex;
      batch.anchorTime = now;

      const loc = this.locateInBatch(batch, charIndex);
      if (loc) this.setCurrentSentence(loc.sentenceIndex, batch);
      return;
    }

    if (event.type === 'word') {
      batch.sawWords = true;
      const loc = this.locateInBatch(batch, event.charIndex || 0);
      if (!loc) return;

      this.setCurrentSentence(loc.sentenceIndex, batch);

      const rel = loc.offset;
      const now = Date.now();
      this.noteFirstBoundary(batch, now);
      if (!batch.firstWordAt) {
        batch.firstWordAt = now;
        batch.firstWordIndex = rel;
      }
      batch.lastWordAt = now;
      batch.lastWordIndex = rel;

      // Absolute position inside the full sentence (used by pause/resume).
      // The number is only meaningful when the engine read the source text
      // verbatim; a rewritten sentence's offset would cut into another word on
      // resume, so it is discarded rather than stored.
      const mapped = this.recordWordPosition(
        batch, loc.sentenceIndex, (batch.resumeOffset || 0) + rel
      );

      const wordLength = (typeof event.length === 'number' && event.length > 0)
        ? event.length
        : ((typeof event.charLength === 'number' && event.charLength > 0) ? event.charLength : 0);

      this.broadcast('TTS_EVENT', {
        event: {
          type: 'word',
          charIndex: rel,
          charLength: wordLength,
          length: wordLength
        },
        index: loc.sentenceIndex,
        aligned: mapped,
        resumeOffset: 0
      });
      return;
    }

    if (event.type === 'end') {
      // Where the utterance ended. Kokoro reports how much it spoke; Supertonic
      // does not (it sends charIndex 0), and then the end of the text we handed
      // to the engine IS the end of the utterance.
      const now = Date.now();
      const profile = this.engineProfile();
      const reportedEnd = (typeof event.charIndex === 'number' && event.charIndex > 0)
        ? event.charIndex
        : null;
      const endChar = reportedEnd !== null
        ? reportedEnd
        : ((batch.text && batch.text.length) ? batch.text.length : null);

      if (endChar !== null && batch.anchorTime !== null && now > batch.anchorTime &&
          endChar > batch.anchorChar) {
        // The stretch from the LAST boundary to the end is one clean piece of
        // playback: nothing follows it, so neither a preparation gap nor an
        // announcement gap can be folded into it. That makes it the best
        // measurement of the engine's real reading speed — and therefore the
        // best predictor for the next utterance.
        //
        // For Kokoro this is what recovers the true reading speed when its
        // synthesis lags behind its own playback. For Supertonic it matters
        // even more: the distance between two boundaries is NOT the reading
        // speed there, because the engine announces a boundary several seconds
        // away from the moment the voice gets there — a rate learned from that
        // distance alone leaves the estimate ~40 characters behind the voice.
        const seconds = (now - batch.anchorTime) / 1000;
        const cps = (endChar - batch.anchorChar) / seconds;
        if (cps > 1 && cps < 200) {
          const unitCps = cps / (this.options.rate || 1);
          if (profile.baseCharsPerSecond <= 0 || unitCps > profile.baseCharsPerSecond) {
            profile.baseCharsPerSecond = unitCps;
          } else {
            profile.baseCharsPerSecond = profile.baseCharsPerSecond * 0.98 + unitCps * 0.02;
          }
          this.charsPerSecond = profile.baseCharsPerSecond;
        }
      }

      if (endChar !== null && batch.anchorTime === null &&
          batch.firstBoundaryTime !== null && batch.firstBoundaryTime !== undefined &&
          now > batch.firstBoundaryTime && batch.text && batch.text.length > 0) {
        // No boundary at all in this utterance — the whole thing was read
        // between the first boundary and the end. Still a usable measurement.
        const seconds = (now - batch.firstBoundaryTime) / 1000;
        const cps = batch.text.length / seconds;
        if (cps > 1 && cps < 200) {
          const unitCps = cps / (this.options.rate || 1);
          if (profile.baseCharsPerSecond <= 0 || unitCps > profile.baseCharsPerSecond) {
            profile.baseCharsPerSecond = unitCps;
          } else {
            profile.baseCharsPerSecond = profile.baseCharsPerSecond * 0.98 + unitCps * 0.02;
          }
          this.charsPerSecond = profile.baseCharsPerSecond;
        }
      }

      // The stretch from the last boundary to the end is pure playback, so it
      // reveals the real speaking speed. When that is clearly higher than the
      // interval rate, the engine could not synthesise as fast as it plays —
      // it goes SILENT between sentences.
      if (profile.intervalSamples > 0 && profile.baseCharsPerSecond > 0 &&
          profile.baseCharsPerSecond > profile.intervalCps * 1.5) {
        profile.starving = true;
      }
    }

    // Anything else (end / error / interrupted) is passed through untouched.
    this.broadcast('TTS_EVENT', {
      event,
      index: this.currentIndex,
      aligned: this.wordEventsUsable,
      resumeOffset: 0
    });
  }

  /**
   * How long the engine may still be PREPARING before the estimator starts
   * extrapolating.
   *
   * The wait is the engine's own measured setup cost — Kokoro rebuilds its
   * neural model for every utterance (~21 s on a CPU-only machine), Supertonic
   * needs a few seconds before it announces anything. Extrapolating during
   * that window is what puts the highlight seconds ahead of the voice, so the
   * highlight parks at the first word until the preparation is over.
   *
   * An engine we have never measured gets a short default window.
   *
   * @param {object} profile The engine profile.
   * @returns {number} Milliseconds.
   */
  preparationWindowMs(profile) {
    const measured = profile && profile.prepareMs > 0 ? profile.prepareMs : 0;
    if (measured <= 0) return 3000;
    // Some slack: the preparation varies, and parking a moment too long is
    // far less visible than running ahead of the voice.
    return Math.min(measured * 1.5, ESTIMATOR_BOUNDARY_WAIT);
  }

  /**
   * Position estimator.
   *
   * When the engine reports no word boundaries we estimate the reading position
   * from the elapsed time and the measured speaking speed, then publish it as
   * a synthetic word event. That keeps the word highlight working with voices
   * that do not implement boundaries (Supertonic), instead of leaving the
   * reader with sentence-level highlighting only.
   *
   * The estimate is anchored on the engine's SENTENCE boundaries, never on the
   * 'start' event. Those two are far apart for a network voice: measured
   * against the real Supertonic engine, 'start' arrives up to 7.2 s BEFORE the
   * first sentence is actually spoken, because the engine spends that time
   * preparing the synthesis. Extrapolating from 'start' therefore made the
   * highlight run up to 7 s AHEAD of the voice — measured, not guessed.
   */
  startEstimator(batch) {
    this.stopEstimator();
    this.estimatorTimer = setInterval(() => {
      if (this.activeBatch !== batch) return;
      // Native word events are more accurate — hand over to them completely.
      if (batch.sawWords) {
        this.stopEstimator();
        return;
      }

      const now = Date.now();
      let pos;

      const profile = this.engineProfile();
      const cps = this.effectiveCharsPerSecond();

      if (batch.anchorTime !== null) {
        // Ground truth is available: the engine told us exactly where the
        // voice is. Extrapolate from that anchor, minus the lead-in delay
        // that opens every utterance (only engines that announce their first
        // boundary before the voice starts have one).
        let elapsed = (now - batch.anchorTime) / 1000;
        if (batch.segmentIndex === 0) {
          elapsed -= (profile.leadInMs || 0) / 1000;
        }
        pos = batch.anchorChar + Math.max(0, elapsed) * cps;

        // The estimate must never leave the sentence the voice is currently
        // in. An engine that cannot synthesise as fast as it plays goes SILENT
        // between sentences; without this cap the estimate runs into the next
        // sentence while the voice is still quiet (measured: 119 characters
        // ahead at the boundary that followed such a gap).
        //
        // The ceiling is the ENGINE's own sentence extent when the engine
        // reports one (Supertonic sends charIndex + length). Using OUR
        // sentence boundary instead would pin the estimate to the end of a
        // sentence the voice had already read past — the engine's sentences
        // do not have to match ours, and when they do not the estimate would
        // freeze for the whole sentence. Measured against the real Supertonic
        // engine: the estimate sat 78 characters behind for 11.6 seconds.
        let ceiling = null;
        if (batch.anchorEnd !== null && batch.anchorEnd > batch.anchorChar) {
          ceiling = batch.anchorEnd;
        } else {
          const anchorLoc = this.locateInBatch(batch, batch.anchorChar);
          if (anchorLoc) {
            const slot = anchorLoc.sentenceIndex - batch.firstIndex;
            const sentenceEnd = (batch.offsets[slot] || 0) + (batch.spokenLengths[slot] || 0);
            if (sentenceEnd > batch.anchorChar) {
              ceiling = sentenceEnd;
            }
          }
        }
        if (ceiling !== null) {
          pos = Math.min(pos, ceiling);
        }
      } else if (this.options.extensionId &&
                 (now - (batch.requestedAt || batch.startedAt)) < this.preparationWindowMs(profile)) {
        // The engine has accepted the utterance but has not started speaking
        // yet. Preparing can take a long time — measured: ~10 s for Kokoro on a
        // CPU-only machine, ~24 s while its model downloads, ~7 s for Supertonic.
        // Park the highlight at the beginning of the utterance instead of
        // extrapolating — extrapolating here is what put the highlight seconds
        // ahead of the voice.
        pos = 0;
      } else {
        // This engine reports no boundaries at all — fall back to a straight
        // extrapolation from the start of the utterance.
        const elapsed = Math.max(0, (now - batch.startedAt) / 1000 - (profile.leadInMs || this.leadInMs || 0) / 1000);
        if (elapsed <= 0) return;
        pos = elapsed * cps;
      }

      pos = Math.max(0, Math.min(batch.text.length, pos));

      const loc = this.locateInBatch(batch, pos);
      if (!loc) return;
      this.setCurrentSentence(loc.sentenceIndex, batch);

      // Work in the SPOKEN text of that sentence (it may start at a resume
      // offset) — the page adds the resume offset back when it maps the word.
      const slot = loc.sentenceIndex - batch.firstIndex;
      const spoken = (batch.spokenTexts && batch.spokenTexts[slot]) || '';
      const upto = Math.max(0, Math.min(spoken.length, loc.offset));
      const wordStart = spoken.lastIndexOf(' ', upto - 1) + 1;
      const match = spoken.substring(wordStart).match(/^\S+/);
      const len = match ? match[0].length : 1;

      // Feed the estimate into the pause/resume bookkeeping too, so pausing
      // with an engine that reports no word boundaries still resumes near the
      // right place instead of restarting the sentence — but only when the
      // estimate indexes the page text rather than a rewrite of it.
      const mapped = this.recordWordPosition(
        batch, loc.sentenceIndex, (batch.resumeOffset || 0) + wordStart
      );

      this.broadcast('TTS_EVENT', {
        event: { type: 'word', charIndex: wordStart, charLength: len, length: len },
        index: loc.sentenceIndex,
        aligned: mapped,
        resumeOffset: 0
      });
    }, ESTIMATOR_INTERVAL_MS);
  }

  stopEstimator() {
    if (this.estimatorTimer) {
      clearInterval(this.estimatorTimer);
      this.estimatorTimer = null;
    }
  }

  /**
   * Learn how fast this voice actually reads, so the estimator stays in sync.
   *
   * With native word events the rate is measured directly between two of them.
   * Without them the rate is learned from the engine's sentence boundaries as
   * they arrive (see handleTtsEvent) — a rate measured across the WHOLE
   * utterance would include the lead-in delay and come out too slow, so it is
   * deliberately not used here.
   */
  updateSpeakingRate(batch) {
    if (!batch || !batch.sawWords) return;
    if (!(batch.lastWordAt > batch.firstWordAt && batch.lastWordIndex > batch.firstWordIndex)) return;

    // Measured between two word events — excludes the engine's start-up delay.
    const cps = (batch.lastWordIndex - batch.firstWordIndex) /
      ((batch.lastWordAt - batch.firstWordAt) / 1000);
    if (cps > 1 && cps < 200) {
      // Normalise to a 1.0x rate so the rate slider keeps working.
      const unitCps = cps / (this.options.rate || 1);
      const profile = this.engineProfile();
      profile.baseCharsPerSecond = profile.baseCharsPerSecond > 0
        ? (profile.baseCharsPerSecond * 0.7 + unitCps * 0.3)
        : unitCps;
      this.charsPerSecond = profile.baseCharsPerSecond;
    }
  }

  /**
   * Speak the sentence at this.currentIndex — or a small group of consecutive
   * sentences when the voice is a network engine.
   *
   * `runId` identifies the playback run this call belongs to. Every await
   * boundary re-checks it: without that guard a stale chain (the one that was
   * mid-sentence when a new text was started) can wake up after the new run
   * has already installed its queue, bump currentIndex past the first
   * sentence and start a second concurrent utterance — which is exactly what
   * makes the Windows TTS engine swallow the new text.
   */
  async speakCurrentSentence(runId = this.playbackRunId, offset = 0) {
    // A newer run has taken over — abandon this chain.
    if (runId !== this.playbackRunId) return;

    if (this.playbackState !== PlaybackState.PLAYING) {
      return;
    }

    if (this.currentIndex >= this.queue.length) {
      console.log('[PlaybackManager] Queue completed.');
      this.playbackState = PlaybackState.STOPPED;
      this.currentIndex = 0;
      this.awaitingSpeech = false;
      await this.saveToSession();
      this.broadcast('PLAYBACK_COMPLETED');
      return;
    }

    // Mark the whole chain (not just the utterance) as live so the keep-alive
    // heartbeat can tell "reading normally" from "the worker died mid-sentence".
    this.awaitingSpeech = true;

    const firstIndex = this.currentIndex;
    const batch = this.buildBatch(firstIndex, offset);
    if (!batch) {
      // Nothing usable to speak here — move past it.
      this.currentIndex = firstIndex + 1;
      if (this.currentIndex >= this.queue.length) {
        this.playbackState = PlaybackState.STOPPED;
        this.currentIndex = 0;
        this.awaitingSpeech = false;
        await this.saveToSession();
        this.broadcast('PLAYBACK_COMPLETED');
        return;
      }
      this.speakCurrentSentence(runId);
      return;
    }

    const batchSize = batch.items.length;
    const firstItem = batch.items[0];
    const safeOffset = batch.resumeOffset;

    // Resume/continuation: speak only the remainder from `offset`, while
    // highlight metadata keeps referencing the FULL sentence text.
    this.resumeOffset = safeOffset;
    // A new utterance invalidates the previous sentence's word position.
    this.lastWordSentence = -1;
    if (safeOffset === 0) {
      this.lastWordCharIndex = 0;
      this.sawWordEvents = false;
    }

    // Any rewrite (noise stripping, prosody cadence, pronunciation) changes
    // the spoken text; word events then index that text, not the page. When
    // even one sentence in the batch was rewritten, the coarse batch-level
    // flag is false. Per-sentence decisions use canMapWordOffset().
    this.wordEventsUsable = batch.wordAligned.every(Boolean);

    console.log(
      `[PlaybackManager] Speaking [${firstIndex + 1}/${this.queue.length}]` +
      `${batchSize > 1 ? ` (+${batchSize - 1} grouped)` : ''}: "${batch.text.substring(0, 40)}..."`
    );

    // Notify listeners so UI highlight updates BEFORE speech starts
    this.broadcast('SENTENCE_CHANGED', {
      index: firstIndex,
      sentence: firstItem,
      totalSentences: this.queue.length,
      resumeOffset: safeOffset,
      wordAligned: this.wordEventsUsable
    });

    this.saveToSession().catch(() => {});

    this.isSwitchingSentence = false;

    // Descriptor for event mapping and the position estimator.
    const batchRef = {
      firstIndex,
      offsets: batch.offsets,
      spokenLengths: batch.spokenLengths,
      spokenTexts: batch.spokenTexts,
      // Per-sentence mapability: word events may only become page offsets for
      // sentences whose spoken form was not rewritten.
      wordAligned: batch.wordAligned,
      text: batch.text,
      resumeOffset: safeOffset,
      // The moment the request was handed to the engine. The engine's own
      // 'start' event arrives later (Supertonic needed 2.6 s for its first
      // request), and the preparation cost — what decides the group size —
      // has to be measured from the REQUEST, not from the 'start' event.
      requestedAt: Date.now(),
      startedAt: Date.now(),
      sawWords: false,
      sawSentences: false,
      firstWordAt: 0,
      lastWordAt: 0,
      firstWordIndex: 0,
      lastWordIndex: 0,
      currentSentence: firstIndex,
      // Estimator anchor state. These MUST start as null (not undefined):
      // handleTtsEvent() compares them against null to decide whether the
      // engine has reported a boundary yet.
      anchorChar: null,
      anchorTime: null,
      // The extent of the sentence the engine just announced: charIndex plus
      // the length the engine reported for it (null when the engine reports
      // no length, e.g. Kokoro).
      anchorEnd: null,
      segmentIndex: 0,
      firstBoundaryDelay: null,
      firstBoundaryTime: null
    };
    this.activeBatch = batchRef;

    // Arm the position estimator from the REQUEST, not from the engine's
    // 'start' event. An extension engine that never emits 'start' (or emits
    // it only after a long preparation) otherwise produced no word highlight
    // at all for the whole session. With no boundary yet the estimator parks
    // at the first word until the engine's measured preparation window has
    // passed, so arming early cannot run the highlight ahead of the voice.
    this.startEstimator(batchRef);

    // Mixed-language automatic voice routing:
    // If the utterance is in Bengali or Hindi, route to the best matching native voice.
    const script = detectScript(batch.text);
    let batchOptions = { ...this.options };
    if (script !== 'en' && Array.isArray(this.allVoices) && this.allVoices.length > 0) {
      const nativeVoice = findBestVoiceForLang(this.allVoices, script, null);
      if (nativeVoice) {
        batchOptions.voiceName = nativeVoice.voiceName;
        batchOptions.extensionId = nativeVoice.extensionId || null;
        batchOptions.lang = nativeVoice.lang || null;
        console.log(`[PlaybackManager] Mixed-language auto-route (${script}): using "${nativeVoice.voiceName}"`);
      }
    }

    try {
      const result = await safeSpeak(batch.text, batchOptions, (event) => {
        // Two guards, not one. The run id rejects events from a superseded
        // playback run; the batch identity rejects events from an utterance
        // that has already been abandoned (watchdog timeout, stop, error)
        // whose engine kept trickling boundaries for a moment. Without the
        // second guard those late events dragged the highlight backwards.
        if (runId !== this.playbackRunId) return;
        if (this.activeBatch !== batchRef) return;
        this.handleTtsEvent(event, batchRef);
      });

      // If playback run is still active and hasn't been superseded or paused
      if (runId !== this.playbackRunId) return;

      this.stopEstimator();
      this.updateSpeakingRate(batchRef);
      if (this.activeBatch === batchRef) this.activeBatch = null;

      this.consecutiveErrors = 0;

      // Watchdog fired mid-utterance: instead of silently dropping the rest,
      // re-speak the remainder from the last confirmed word position.
      if (result && result.type === 'timeout' && this.wordEventsUsable
          && this.playbackState === PlaybackState.PLAYING
          && !this.isSwitchingSentence) {
        const spokenIndex = batchRef.currentSentence;
        const spokenItem = this.queue[spokenIndex];
        const cont = (spokenIndex === this.currentIndex) ? this.validResumeOffset() : 0;
        if (spokenItem && cont > 0 && cont < spokenItem.text.length) {
          this.currentIndex = spokenIndex;
          this.speakCurrentSentence(runId, cont);
          return;
        }
      }

      if (this.playbackState === PlaybackState.PLAYING && !this.isSwitchingSentence) {
        this.currentIndex = firstIndex + batchSize;
        this.saveToSession().catch(() => {});
        if (runId !== this.playbackRunId) return;
        this.speakCurrentSentence(runId);
      }
    } catch (err) {
      this.stopEstimator();
      if (this.activeBatch === batchRef) this.activeBatch = null;
      if (runId !== this.playbackRunId) return;
      this.consecutiveErrors++;
      console.warn(`[PlaybackManager] Speech error at sentence ${firstIndex + 1}:`, err);
      this.broadcast('PLAYBACK_ERROR', { error: err.message, index: firstIndex });

      // A persistently broken voice driver would otherwise burn through the
      // whole queue in milliseconds, spamming PLAYBACK_ERROR at every page.
      if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.warn('[PlaybackManager] Too many consecutive TTS errors — stopping playback.');
        this.awaitingSpeech = false;
        this.playbackState = PlaybackState.STOPPED;
        await this.saveToSession();
        this.broadcast('PLAYBACK_STOPPED');
        return;
      }

      if (this.playbackState === PlaybackState.PLAYING) {
        // Skip only the sentence that failed — a grouped utterance must not
        // take three sentences down with it.
        this.currentIndex = firstIndex + 1;
        this.saveToSession().catch(() => {});
        if (runId !== this.playbackRunId) return;
        this.speakCurrentSentence(runId);
      }
    }
  }

  /**
   * Pause playback.
   */
  async pause() {
    if (this.playbackState !== PlaybackState.PLAYING) {
      return;
    }

    // Remember how far into the current sentence we got so resume continues
    // from the spoken word instead of replaying the whole sentence.
    //
    // validResumeOffset() returns 0 unless that offset indexes the page text
    // of the sentence that is current right now. Storing an offset that came
    // from a rewritten sentence used to resume in the middle of a different
    // word — the audible half of the F1 defect.
    this.resumeOffset = this.validResumeOffset();

    this.playbackRunId = (this.playbackRunId || 0) + 1;
    this.isSwitchingSentence = true;
    this.playbackState = PlaybackState.PAUSED;
    this.awaitingSpeech = false;
    this.stopEstimator();
    await stopSpeechAndWait();
    await this.saveToSession();
    this.broadcast('PLAYBACK_PAUSED');
  }

  /**
   * Resume playback.
   */
  async resume() {
    if (this.playbackState !== PlaybackState.PAUSED) {
      return;
    }

    this.playbackRunId = (this.playbackRunId || 0) + 1;
    this.playbackState = PlaybackState.PLAYING;
    await this.saveToSession();
    this.broadcast('PLAYBACK_RESUMED');
    const resumeFrom = this.resumeOffset || 0;
    this.speakCurrentSentence(this.playbackRunId, resumeFrom);
  }

  /**
   * Stop playback and reset to beginning.
   */
  async stop() {
    this.playbackRunId = (this.playbackRunId || 0) + 1;
    this.isSwitchingSentence = true;
    this.playbackState = PlaybackState.STOPPED;
    this.awaitingSpeech = false;
    this.stopEstimator();
    await stopSpeechAndWait();
    this.currentIndex = 0;
    await this.saveToSession();
    this.broadcast('PLAYBACK_STOPPED');
  }

  /**
   * Skip forward to next sentence.
   */
  async skipForward() {
    if (this.queue.length === 0) return;

    this.playbackRunId = (this.playbackRunId || 0) + 1;
    this.isSwitchingSentence = true;
    await stopSpeechAndWait();

    if (this.currentIndex < this.queue.length - 1) {
      this.currentIndex++;
    }

    await this.saveToSession();

    if (this.playbackState === PlaybackState.PLAYING) {
      this.speakCurrentSentence(this.playbackRunId);
    } else {
      this.broadcast('SENTENCE_CHANGED', {
        index: this.currentIndex,
        sentence: this.queue[this.currentIndex],
        totalSentences: this.queue.length
      });
    }
  }

  /**
   * Skip backward to previous sentence.
   */
  async skipBackward() {
    if (this.queue.length === 0) return;

    this.playbackRunId = (this.playbackRunId || 0) + 1;
    this.isSwitchingSentence = true;
    await stopSpeechAndWait();

    if (this.currentIndex > 0) {
      this.currentIndex--;
    }

    await this.saveToSession();

    if (this.playbackState === PlaybackState.PLAYING) {
      this.speakCurrentSentence(this.playbackRunId);
    } else {
      this.broadcast('SENTENCE_CHANGED', {
        index: this.currentIndex,
        sentence: this.queue[this.currentIndex],
        totalSentences: this.queue.length
      });
    }
  }

  /**
   * Jump to a specific sentence index.
   */
  async jumpToIndex(index) {
    if (this.queue.length === 0) return;

    this.playbackRunId = (this.playbackRunId || 0) + 1;
    this.isSwitchingSentence = true;
    await stopSpeechAndWait();

    const requested = typeof index === 'number' && Number.isFinite(index) ? Math.trunc(index) : 0;
    const targetIndex = Math.max(0, Math.min(requested, this.queue.length - 1));
    const wasPaused = this.playbackState === PlaybackState.PAUSED;
    this.currentIndex = targetIndex;
    this.resumeOffset = 0;
    this.lastWordCharIndex = 0;
    this.sawWordEvents = false;
    this.lastWordSentence = -1;

    if (wasPaused) {
      // Seeking while paused moves the reading position but does not start
      // speaking again: the user pressed pause deliberately. It used to flip
      // straight back to PLAYING, so a click on the progress bar silently
      // resumed audio.
      await this.saveToSession();
      this.isSwitchingSentence = false;
      this.broadcast('SENTENCE_CHANGED', {
        index: targetIndex,
        sentence: this.queue[targetIndex],
        totalSentences: this.queue.length,
        resumeOffset: 0,
        wordAligned: true
      });
      return;
    }

    this.playbackState = PlaybackState.PLAYING;
    await this.saveToSession();

    this.speakCurrentSentence(this.playbackRunId);
  }

  /**
   * Change playback speed rate.
   */
  async setRate(rate) {
    // A malformed message (NaN/undefined) must not poison every later
    // utterance with an invalid `rate`, which Chrome silently rejects.
    const requested = typeof rate === 'number' && Number.isFinite(rate) ? rate : this.options.rate;
    const validRate = Math.max(0.5, Math.min(requested, 3.0));
    this.options.rate = validRate;
    await this.savePreferences();
    await this.saveToSession();

    // If currently speaking, restart current sentence with the new rate immediately
    if (this.playbackState === PlaybackState.PLAYING) {
      this.playbackRunId = (this.playbackRunId || 0) + 1;
      this.isSwitchingSentence = true;
      await stopSpeechAndWait();
      const resumeFrom = this.validResumeOffset() || (this.resumeOffset || 0);
      this.speakCurrentSentence(this.playbackRunId, resumeFrom);
    } else {
      this.broadcast('OPTIONS_CHANGED', { options: this.options });
    }
  }

  /**
   * Change playback volume (0.0 to 1.0).
   */
  async setVolume(volume) {
    const requested = typeof volume === 'number' && Number.isFinite(volume) ? volume : this.options.volume;
    const validVolume = Math.max(0.0, Math.min(requested, 1.0));
    this.options.volume = validVolume;
    await this.savePreferences();
    await this.saveToSession();

    // If currently speaking, restart current sentence with the new volume immediately
    if (this.playbackState === PlaybackState.PLAYING) {
      this.playbackRunId = (this.playbackRunId || 0) + 1;
      this.isSwitchingSentence = true;
      await stopSpeechAndWait();
      const resumeFrom = this.validResumeOffset() || (this.resumeOffset || 0);
      this.speakCurrentSentence(this.playbackRunId, resumeFrom);
    } else {
      this.broadcast('OPTIONS_CHANGED', { options: this.options });
    }
  }

  /**
   * Change playback pitch (0.5 to 2.0).
   */
  async setPitch(pitch) {
    const requested = typeof pitch === 'number' && Number.isFinite(pitch) ? pitch : this.options.pitch;
    const validPitch = Math.max(0.5, Math.min(requested, 2.0));
    this.options.pitch = validPitch;
    await this.savePreferences();
    await this.saveToSession();

    if (this.playbackState === PlaybackState.PLAYING) {
      this.playbackRunId = (this.playbackRunId || 0) + 1;
      this.isSwitchingSentence = true;
      await stopSpeechAndWait();
      const resumeFrom = this.validResumeOffset() || (this.resumeOffset || 0);
      this.speakCurrentSentence(this.playbackRunId, resumeFrom);
    } else {
      this.broadcast('OPTIONS_CHANGED', { options: this.options });
    }
  }

  // ── Pronunciation overrides ("zea mays = zee-a mays", one per line) ──

  static parsePronunciations(rawText) {
    const rules = [];
    if (typeof rawText !== 'string') return rules;
    for (const line of rawText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const eq = trimmed.indexOf('=');
      const find = trimmed.slice(0, eq).trim();
      const say = trimmed.slice(eq + 1).trim();
      if (!find || !say) continue;
      const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Word boundaries only work next to a word character. A term that ends
      // in a symbol ("C++", "C#", "node.js" as written) got a trailing `\b`
      // that can never match, so the rule silently did nothing. Anchor each
      // side only when that side really is alphanumeric.
      const prefix = /^[\w]/.test(find) ? '\\b' : '';
      const suffix = /[\w]$/.test(find) ? '\\b' : '';
      try {
        rules.push({ re: new RegExp(`${prefix}${escaped}${suffix}`, 'gi'), say });
      } catch (_) { /* invalid pattern — skip line */ }
    }
    return rules;
  }

  setPronunciationText(rawText) {
    const text = typeof rawText === 'string' ? rawText : '';
    this.pronunciationRules = PlaybackManager.parsePronunciations(text);
    try {
      chrome.storage.local.get(PREFS_STORAGE_KEY, (res) => {
        void chrome.runtime.lastError;
        const prefs = (res && res[PREFS_STORAGE_KEY]) || {};
        prefs.pronunciationText = text;
        chrome.storage.local.set({ [PREFS_STORAGE_KEY]: prefs }).catch(() => {});
      });
    } catch (_) { /* context gone — ignore */ }
  }

  applyPronunciations(text) {
    if (!this.pronunciationRules || this.pronunciationRules.length === 0 || typeof text !== 'string') {
      return { text, changed: false };
    }
    let out = text;
    let changed = false;
    for (const rule of this.pronunciationRules) {
      const next = out.replace(rule.re, rule.say);
      if (next !== out) {
        out = next;
        changed = true;
      }
    }
    return { text: out, changed };
  }

  /**
   * Change voice.
   */
  async setVoice(voiceName, extensionId = null, lang = null) {
    // Defensive: only real strings reach the options, never a raw payload value.
    const name = typeof voiceName === 'string' ? voiceName.trim() : '';
    const ext = typeof extensionId === 'string' ? extensionId.trim() : '';
    const lng = typeof lang === 'string' ? lang.trim() : '';
    this.options.voiceName = name.length > 0 ? name : null;
    this.options.extensionId = ext.length > 0 ? ext : null;
    this.options.lang = lng.length > 0 ? lng : null;
    // An explicit choice sticks: from now on the automatic engine priority
    // must not override it (that is what keeps Supertonic usable as a
    // deliberate fallback next to Kokoro).
    this.voicePinned = true;

    await this.savePreferences();
    await this.saveToSession();

    // If currently speaking, restart current sentence with the new voice immediately
    if (this.playbackState === PlaybackState.PLAYING) {
      this.playbackRunId = (this.playbackRunId || 0) + 1;
      this.isSwitchingSentence = true;
      await stopSpeechAndWait();
      this.speakCurrentSentence(this.playbackRunId);
    } else {
      this.broadcast('OPTIONS_CHANGED', { options: this.options });
    }
  }

  /**
   * Get full current playback snapshot.
   */
  getState() {
    return {
      playbackState: this.playbackState,
      currentIndex: this.currentIndex,
      totalSentences: this.queue.length,
      currentSentence: this.queue[this.currentIndex] || null,
      options: this.options,
      hasQueue: this.queue.length > 0
    };
  }
}

export const playbackManager = new PlaybackManager();
