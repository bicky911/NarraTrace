/**
 * NarraTrace - Background Service Worker
 * Manages playback, state persistence, alarms, context menus, and extension messaging.
 */

import {
  detectAndSelectVoice,
  stopSpeech,
  isSpeaking,
  waitForTtsApi
} from './speech-engine.js';

import { playbackManager, PlaybackState } from './playback-manager.js';

// Side-effect import: sentence-tokenizer.js is a dual-loadable classic/ESM
// script that defines globalThis.ReadAloudTokenizer — the SAME file the
// content script loads, so tokenization can never drift between contexts.
import './sentence-tokenizer.js';

const { splitIntoChunks } = globalThis.ReadAloudTokenizer;

console.log('[Background] NarraTrace service worker active.');

// Debug handle — type this in the service-worker console to inspect live state:
//   __readAloud.playbackManager.getState()
//   __readAloud.playbackManager.setBatchSize(1)
globalThis.__readAloud = { playbackManager, PlaybackState };

// ── Keep-alive alarm ─────────────────────────────────────────────────
// Chrome clamps periodInMinutes to a 0.5 minute (30s) minimum, and when no
// delayInMinutes is given it uses periodInMinutes as the initial delay too.
// Re-creating the alarm on every worker start therefore pushes its next fire
// further out each time — and the worker restarts on every event it handles.
// Follow Chrome's own sample: look first, create only when it is missing, so
// the schedule survives worker restarts.
async function ensureKeepAliveAlarm() {
  try {
    const existing = await chrome.alarms.get('readAloudKeepAlive');
    if (!existing) {
      await chrome.alarms.create('readAloudKeepAlive', { periodInMinutes: 0.5 });
      console.log('[Background] Keep-alive alarm created (every 30s).');
    }
  } catch (err) {
    console.warn('[Background] Could not ensure keep-alive alarm:', err?.message || err);
  }
}
ensureKeepAliveAlarm();

// ── Tab lifecycle guards ────────────────────────────────────────────
// If the tab that initiated playback is closed, stop playback so audio
// doesn't continue invisibly with no UI to control it.
chrome.tabs.onRemoved.addListener((tabId) => {
  const state = playbackManager.getState();
  if (playbackManager.tabId === tabId &&
      (state.playbackState === PlaybackState.PLAYING || state.playbackState === PlaybackState.PAUSED)) {
    console.warn('[Background] Playing tab', tabId, 'was closed — stopping playback.');
    playbackManager.stop();
  }
});

// If the playing tab navigates to a new URL (link click, address bar, refresh, or SPA history push),
// the content script / page is gone — stop playback to avoid orphaned audio.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading' && !changeInfo.url) return;
  const state = playbackManager.getState();
  if (playbackManager.tabId === tabId &&
      (state.playbackState === PlaybackState.PLAYING || state.playbackState === PlaybackState.PAUSED)) {
    console.warn('[Background] Playing tab', tabId, 'navigated or changed URL — stopping playback.');
    playbackManager.stop();
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'readAloudKeepAlive') return;

  const state = playbackManager.getState();
  if (state.playbackState !== PlaybackState.PLAYING) return;
  if (state.hasQueue === false) return;

  // awaitingSpeech is true only while THIS worker instance owns the in-flight
  // utterance. If the state says PLAYING but nothing is in flight, the worker
  // was restarted mid-sentence (the utterance's 'end' event died with it) and
  // the queue would otherwise stall forever.
  if (playbackManager.awaitingSpeech || playbackManager.isSwitchingSentence) return;

  console.warn('[KeepAlive] Playback stalled at sentence #', state.currentIndex + 1, '— recovering.');
  await playbackManager.recoverAfterWorkerRestart();
});

// Setup Context Menu for selected text.
//
// The service worker is restarted constantly (the keep-alive alarm wakes it
// every 30s, and Chrome also parks idle workers), and initializeWorker() runs
// on every worker start.
//
// Context-menu items are extension-scoped and PERSIST across service-worker
// restarts, so on most starts the items already exist. We therefore call
// create() and swallow the "Cannot create item with duplicate id" error in
// the callback — the menu stays in place, with no flicker.
//
// Why not check-then-update: chrome.contextMenus has NO getAll() method (the
// API surface is create / update / remove / removeAll only). Calling it throws
// "chrome.contextMenus.getAll is not a function", which took down
// initializeWorker() and left the extension with no context menu at all.
//
// Why not removeAll()+create() on every start: that tore the menu down on each
// restart, so "Narrate with NarraTrace" intermittently vanished from the
// right-click menu.
//
// The titles here are static, so update() would be a no-op anyway.
function setupContextMenu() {
  const ensure = (id, title, contexts) => {
    chrome.contextMenus.create(
      { id, title, contexts },
      () => { void chrome.runtime.lastError; }   // swallow duplicate-id on restarts
    );
  };
  ensure('read-aloud-selection', 'NarraTrace: narrate selection', ['selection']);
  ensure('read-aloud-from-here', 'NarraTrace: narrate from here', ['page', 'frame']);
}

// Handle Context Menu click
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'read-aloud-from-here') {
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, { action: 'TRIGGER_READ_FROM_HERE' }).catch(() => {});
    }
    return;
  }

  if (info.menuItemId === 'read-aloud-selection' && info.selectionText) {
    const rawText = info.selectionText.trim();
    if (rawText.length > 0) {
      const sentences = splitIntoChunks(rawText);
      const tabId = tab?.id || null;
      console.log(`[Background] Context menu read triggered: ${sentences.length} sentences on tab`, tabId);
      await playbackManager.start(sentences, 0, tabId);
      if (tabId) {
        chrome.tabs.sendMessage(tabId, {
          action: 'SELECTION_READ_STARTED',
          sentences
        }).catch(() => {});
      }
    }
  }
});

// Initialize on startup/install: load preferences and restore active session.
// Guarded: onInstalled, onStartup, and the top-level call can race on first
// install — only the first invocation proceeds.
let _initDone = false;

// The chrome.tts namespace — and with it the onVoicesChanged event — only
// exists a moment after the worker starts. Registering the listener inside a
// plain try/catch would therefore silently drop it on a cold boot, and the
// voice would never follow the engine that registers late. Wait for the API
// and only then attach, so the listener is really in place.
let _voiceListenerReady = false;
async function registerVoiceChangeListener() {
  if (_voiceListenerReady) return;
  const ready = await waitForTtsApi(15000);
  if (!ready) {
    console.warn('[Background] chrome.tts never became available — voice auto-refresh stays off.');
    return;
  }
  try {
    if (typeof chrome.tts.onVoicesChanged?.addListener === 'function') {
      chrome.tts.onVoicesChanged.addListener(() => {
        playbackManager.refreshVoice().catch((err) => {
          console.warn('[Background] Voice refresh failed:', err && err.message);
        });
      });
    }
  } catch (_) {
    // Older Chrome without the event — the initial resolution still applies.
  }
  _voiceListenerReady = true;
}

async function initializeWorker() {
  if (_initDone) return;
  _initDone = true;

  setupContextMenu();
  await playbackManager.loadPreferences();

  // A TTS engine extension (Kokoro, Supertonic, ...) registers its voices a
  // moment after Chrome starts it, so the voice list is still empty when the
  // worker boots. Chrome announces every change of that list — re-resolve the
  // voice then, so the preferred engine takes over as soon as it appears.
  registerVoiceChangeListener();
  const restored = await playbackManager.restoreFromSession();
  if (restored) {
    const state = playbackManager.getState();
    console.log('[Background] Active session found on startup:', state);

    // The restored session may belong to a tab that was closed while the
    // worker was asleep. Resuming then would play audio nobody can stop.
    if (typeof playbackManager.tabId === 'number') {
      let tabAlive = false;
      try {
        const tab = await chrome.tabs.get(playbackManager.tabId);
        tabAlive = Boolean(tab);
      } catch (_) {
        tabAlive = false;
      }
      if (!tabAlive) {
        console.warn('[Background] Restored session belongs to a closed tab — discarding.');
        await playbackManager.reset();
        return;
      }
    }

    if (state.playbackState === PlaybackState.PLAYING) {
      await playbackManager.recoverAfterWorkerRestart();
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  initializeWorker();
});

chrome.runtime.onStartup.addListener(() => {
  initializeWorker();
});

// Immediate run
initializeWorker();

// Keyboard Shortcuts Router (Alt+P, Alt+X, Alt+., Alt+,)
chrome.commands.onCommand.addListener(async (command) => {
  console.log('[Background] Command received:', command);

  switch (command) {
    case 'toggle-play': {
      const state = playbackManager.getState();
      if (state.playbackState === PlaybackState.PLAYING) {
        await playbackManager.pause();
      } else if (state.playbackState === PlaybackState.PAUSED) {
        await playbackManager.resume();
      } else {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab && tab.id) {
            chrome.tabs.sendMessage(tab.id, { action: 'TRIGGER_READ_PAGE' }).catch((err) => {
              console.warn('[Background] toggle-play tab notification failed:', err);
            });
          }
        } catch (err) {
          console.warn('[Background] toggle-play active tab query error:', err);
        }
      }
      break;
    }

    case 'stop-speech': {
      await playbackManager.stop();
      break;
    }

    case 'skip-forward': {
      await playbackManager.skipForward();
      break;
    }

    case 'skip-backward': {
      await playbackManager.skipBackward();
      break;
    }
  }
});

// Full session inspection is intentionally available only to the bundled
// diagnostics page, never to content scripts or ordinary popup requests.
function isDiagnosticsPageSender(sender) {
  if (typeof sender?.url !== 'string') return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === 'chrome-extension:' &&
      url.host === chrome.runtime.id &&
      url.pathname === '/test.html';
  } catch (_) {
    return false;
  }
}

// Message Router
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.action !== 'string' || message.action.length === 0) {
    return false;
  }

  const senderTabId = sender?.tab?.id || null;

  switch (message.action) {
    case 'GET_VOICES': {
      // Report the voice set with the CURRENT selection highlighted. The
      // manager already resolved the engine (Kokoro first, then Supertonic,
      // then the Windows voices) when the worker started.
      detectAndSelectVoice({
        voiceName: message.preferredVoiceName || playbackManager.options.voiceName,
        pinned: message.preferredVoiceName ? true : playbackManager.voicePinned
      })
        .then((report) => sendResponse({ success: true, data: report }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'GET_PAGE_ZOOM': {
      // The content script cannot read the page zoom on its own: on desktop
      // Chrome neither svg.currentScale nor visualViewport.scale follows it,
      // and devicePixelRatio mixes it with the display scaling. Chrome's own
      // tabs API reports the tab's zoom factor and needs no extra permission.
      const tabId = senderTabId;
      if (typeof tabId !== 'number') {
        sendResponse({ success: false, error: 'No tab id for this message.' });
        return true;
      }
      chrome.tabs.getZoom(tabId, (zoom) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, data: { zoom } });
        }
      });
      return true;
    }

    case 'START_READING_TEXT': {
      if (!message.rawText || typeof message.rawText !== 'string' || message.rawText.trim().length === 0) {
        sendResponse({ success: false, error: 'Missing or invalid rawText string.' });
        return true;
      }
      const sentences = splitIntoChunks(message.rawText);
      const startIndex = typeof message.startIndex === 'number' && Number.isFinite(message.startIndex)
        ? Math.trunc(message.startIndex)
        : 0;
      playbackManager.start(
        sentences,
        startIndex,
        senderTabId,
        message.options || {}
      )
        .then((ok) => sendResponse(ok
          ? { success: true, state: playbackManager.getState(), count: sentences.length }
          : { success: false, error: 'No usable sentences to read.' }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'START_PLAYBACK': {
      if (!Array.isArray(message.sentences) || message.sentences.length === 0) {
        sendResponse({ success: false, error: 'Missing or empty sentences array.' });
        return true;
      }
      playbackManager.start(
        message.sentences,
        typeof message.startIndex === 'number' && Number.isFinite(message.startIndex)
          ? Math.trunc(message.startIndex)
          : 0,
        senderTabId,
        message.options || {}
      )
        .then((ok) => sendResponse(ok
          ? { success: true, state: playbackManager.getState() }
          : { success: false, error: 'No usable sentences to read.' }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'TRIGGER_READ_PAGE': {
      // Popup "Read page" button: popup messages reach the worker, not the
      // tab — forward to the active tab's content script.
      chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (tab && tab.id) {
          chrome.tabs.sendMessage(tab.id, { action: 'TRIGGER_READ_PAGE' })
            .then(() => sendResponse({ success: true }))
            .catch(() => sendResponse({ success: false, error: 'Page not readable (no content script).' }));
        } else {
          sendResponse({ success: false, error: 'No active tab.' });
        }
      }).catch(() => sendResponse({ success: false, error: 'Tab lookup failed.' }));
      return true;
    }

    case 'PAUSE_PLAYBACK': {
      playbackManager.pause()
        .then(() => sendResponse({ success: true, state: playbackManager.getState() }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'RESUME_PLAYBACK': {
      playbackManager.resume()
        .then(() => sendResponse({ success: true, state: playbackManager.getState() }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'STOP_PLAYBACK': {
      playbackManager.stop()
        .then(() => sendResponse({ success: true, state: playbackManager.getState() }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'SKIP_FORWARD': {
      playbackManager.skipForward()
        .then(() => sendResponse({ success: true, state: playbackManager.getState() }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'SKIP_BACKWARD': {
      playbackManager.skipBackward()
        .then(() => sendResponse({ success: true, state: playbackManager.getState() }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'SKIP_TO_INDEX':
    case 'JUMP_TO_INDEX': {
      const idx = typeof message.index === 'number' && Number.isFinite(message.index) ? message.index : 0;
      playbackManager.jumpToIndex(idx)
        .then(() => sendResponse({ success: true, state: playbackManager.getState() }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'SET_RATE': {
      if (typeof message.rate !== 'number' || !Number.isFinite(message.rate)) {
        sendResponse({ success: false, error: 'rate must be a finite number.' });
        return false;
      }
      const rate = message.rate;
      playbackManager.setRate(rate)
        .then(() => sendResponse({ success: true, state: playbackManager.getState() }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'SET_VOLUME': {
      if (typeof message.volume !== 'number' || !Number.isFinite(message.volume)) {
        sendResponse({ success: false, error: 'volume must be a finite number.' });
        return false;
      }
      const volume = message.volume;
      playbackManager.setVolume(volume)
        .then(() => sendResponse({ success: true, state: playbackManager.getState() }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'SET_PITCH': {
      if (typeof message.pitch !== 'number' || !Number.isFinite(message.pitch)) {
        sendResponse({ success: false, error: 'pitch must be a finite number.' });
        return false;
      }
      const pitch = message.pitch;
      playbackManager.setPitch(pitch)
        .then(() => sendResponse({ success: true, state: playbackManager.getState() }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'SET_PRONUNCIATIONS': {
      // Raw multi-line text ("match = say-as"); the playback manager parses
      // it into rules for the speech normalizer.
      const text = typeof message.text === 'string' ? message.text : '';
      playbackManager.setPronunciationText(text);
      sendResponse({ success: true, count: playbackManager.pronunciationRules.length });
      return false;
    }

    case 'SET_BATCH_SIZE': {
      // 0 = automatic; 1..12 = an explicit utterance group size.
      if (typeof message.size !== 'number' || !Number.isFinite(message.size) ||
          Math.trunc(message.size) < 0 || Math.trunc(message.size) > 12) {
        sendResponse({ success: false, error: 'size must be an integer from 0 to 12.' });
        return false;
      }
      const size = Math.trunc(message.size);
      playbackManager.setBatchSize(size)
        .then((applied) => sendResponse({ success: true, batchSize: applied }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'SET_VOICE': {
      const voiceName = typeof message.voiceName === 'string' ? message.voiceName.trim() : '';
      const extensionId = message.extensionId == null ? null : message.extensionId;
      const lang = message.lang == null ? null : message.lang;
      if (!voiceName || voiceName.length > 256 ||
          (extensionId !== null && (typeof extensionId !== 'string' || extensionId.length > 128)) ||
          (lang !== null && (typeof lang !== 'string' || lang.length > 64))) {
        sendResponse({ success: false, error: 'Invalid voice selection payload.' });
        return false;
      }
      playbackManager.setVoice(voiceName, extensionId, lang)
        .then(() => sendResponse({ success: true, state: playbackManager.getState() }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'SET_PLAYER_VISIBILITY': {
      if (typeof message.visible !== 'boolean') {
        sendResponse({ success: false, error: 'visible must be a boolean.' });
        return false;
      }
      const visible = message.visible;
      chrome.storage.local.set({ readAloud_pillVisible: visible }).catch(() => {});
      chrome.tabs.query({}, (tabs) => {
        void chrome.runtime.lastError;
        (tabs || []).forEach(t => {
          if (t.id) {
            chrome.tabs.sendMessage(t.id, {
              action: 'PLAYER_VISIBILITY_CHANGED',
              visible
            }).catch(() => {});
          }
        });
      });
      sendResponse({ success: true, visible });
      return false;
    }

    case 'GET_PLAYBACK_STATE': {
      sendResponse({ success: true, state: playbackManager.getState() });
      return false;
    }

    case 'HEARTBEAT': {
      // Periodic ping from active content script keeps the SW idle timer reset
      sendResponse({ success: true, state: playbackManager.getState().playbackState });
      return false;
    }

    case 'GET_SESSION_STORAGE': {
      if (!isDiagnosticsPageSender(sender)) {
        sendResponse({ success: false, error: 'Session inspection is restricted to the diagnostics page.' });
        return false;
      }
      chrome.storage.session.get(null)
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    default:
      return false;
  }
});
