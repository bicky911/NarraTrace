/**
 * NarraTrace - Teenage Engineering Studio Popup Controller (NT·1)
 * 
 * STRICT COMPLIANCE:
 * 1. Strictly uses chrome.tts via background worker messaging. Zero prohibited APIs.
 * 2. Real-time synchronization with active tab and background playback manager.
 * 3. Immediate speed, voice, and theme switching.
 */

// DOM Elements
const engineBadgeEl      = document.getElementById('engine-badge');
const badgeTextEl        = document.getElementById('badge-text');
const statusDotEl        = document.getElementById('status-dot');
const themeToggleEl      = document.getElementById('theme-toggle');
const tabTitleEl         = document.getElementById('tab-title');
const progressCounterEl  = document.getElementById('progress-counter');
const sentenceBoxEl      = document.getElementById('sentence-box');
const progressBarFillEl  = document.getElementById('progress-bar-fill');

const ctrlPrevBtn        = document.getElementById('ctrl-prev');
const ctrlPlayBtn        = document.getElementById('ctrl-play');
const ctrlPlayIcon       = document.getElementById('ctrl-play-icon');
const ctrlNextBtn        = document.getElementById('ctrl-next');
const ctrlStopBtn        = document.getElementById('ctrl-stop');

const voiceSelectEl      = document.getElementById('popup-voice-select');
const voiceSubstatusEl   = document.getElementById('voice-substatus');
const speedSliderEl      = document.getElementById('popup-speed-slider');
const speedDisplayEl     = document.getElementById('popup-speed-display');
const speedChips         = document.querySelectorAll('.chip');
const volumeSliderEl     = document.getElementById('popup-volume-slider');
const volumeDisplayEl    = document.getElementById('popup-volume-display');
const readingEstEl       = document.getElementById('reading-est');
const btnTogglePill      = document.getElementById('btn-toggle-pill');
const btnTogglePillText  = document.getElementById('btn-toggle-text');

// State
let currentPlaybackState = 'IDLE';
let activeTabId          = null;
let currentTheme         = 'dark';
let currentSpeed         = 1.0;
let currentVolume        = 1.0;
let isPillVisible        = true;

function updatePillToggleText() {
  if (btnTogglePillText) {
    btnTogglePillText.textContent = isPillVisible ? 'HIDE SCREEN MODULE' : 'SHOW SCREEN MODULE';
    btnTogglePill.setAttribute('aria-pressed', String(isPillVisible));
    btnTogglePill.setAttribute('aria-label', isPillVisible ? 'Hide floating player' : 'Show floating player');
  }
}

const SVG_PLAY  = '<path d="M8 5v14l11-7z"/>';
const SVG_PAUSE = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';

/**
 * Apply theme to popup body and update toggle button icon.
 */
function applyTheme(theme) {
  currentTheme = theme;
  if (theme === 'light') {
    document.body.classList.add('light');
    themeToggleEl.textContent = '●';
    themeToggleEl.title = 'Switch to Dark Mode';
    themeToggleEl.setAttribute('aria-label', 'Switch to dark theme');
  } else {
    document.body.classList.remove('light');
    themeToggleEl.textContent = '☼';
    themeToggleEl.title = 'Switch to OP-1 Light Mode';
    themeToggleEl.setAttribute('aria-label', 'Switch to light theme');
  }
}

function updateVolumeDisplay(vol) {
  currentVolume = typeof vol === 'number' ? Math.max(0, Math.min(1, vol)) : 1.0;
  if (volumeSliderEl) {
    volumeSliderEl.value = String(currentVolume);
    volumeSliderEl.setAttribute('aria-valuetext', `${Math.round(currentVolume * 100)} percent volume`);
  }
  if (volumeDisplayEl) volumeDisplayEl.textContent = `${Math.round(currentVolume * 100)}%`;
}

/**
 * Update UI play button and sentence box according to playback state.
 */
function updatePlayState(state, currentSentence = null, currentIndex = 0, totalSentences = 0) {
  currentPlaybackState = state;
  const playControlLabel = state === 'PLAYING'
    ? 'Pause reading'
    : state === 'PAUSED' ? 'Resume reading' : 'Play reading';
  ctrlPlayBtn.setAttribute('aria-label', playControlLabel);
  ctrlPlayBtn.setAttribute('aria-pressed', String(state === 'PLAYING'));

  if (state === 'PLAYING') {
    ctrlPlayIcon.innerHTML = SVG_PAUSE;
    ctrlPlayBtn.title = 'Pause reading';
    sentenceBoxEl.classList.remove('idle');
    sentenceBoxEl.classList.add('active');
    if (statusDotEl) statusDotEl.classList.add('pulsing');

    if (currentSentence && currentSentence.text) {
      sentenceBoxEl.textContent = currentSentence.text;
    }

    if (totalSentences > 0) {
      progressCounterEl.style.display = 'inline-block';
      const cur = String(currentIndex + 1).padStart(2, '0');
      const tot = String(totalSentences).padStart(2, '0');
      progressCounterEl.textContent = `SEN ${cur}/${tot}`;
      const pct = Math.round(((currentIndex + 1) / totalSentences) * 100);
      progressBarFillEl.style.width = `${pct}%`;
      progressBarFillEl.parentElement?.setAttribute('aria-valuenow', pct);

      // Estimate remaining time (avg ~18 words/sentence at ~160 WPM * speed)
      const remainingSentences = Math.max(0, totalSentences - (currentIndex + 1));
      const estMin = Math.max(1, Math.ceil((remainingSentences * 18) / (160 * currentSpeed)));
      if (readingEstEl) {
        readingEstEl.textContent = `~${estMin}m left`;
        readingEstEl.style.display = 'inline-block';
      }
    }
  } else if (state === 'PAUSED') {
    ctrlPlayIcon.innerHTML = SVG_PLAY;
    ctrlPlayBtn.title = 'Resume reading';
    sentenceBoxEl.classList.remove('idle');
    sentenceBoxEl.classList.add('active');
    if (statusDotEl) statusDotEl.classList.remove('pulsing');
  } else {
    ctrlPlayIcon.innerHTML = SVG_PLAY;
    ctrlPlayBtn.title = 'Play';
    progressCounterEl.style.display = 'none';
    if (readingEstEl) readingEstEl.style.display = 'none';
    progressBarFillEl.style.width = '0%';
    progressBarFillEl.parentElement?.setAttribute('aria-valuenow', 0);
    sentenceBoxEl.classList.add('idle');
    sentenceBoxEl.classList.remove('active');
    sentenceBoxEl.textContent = 'Ready to read this webpage. Press play to start.';
    if (statusDotEl) statusDotEl.classList.remove('pulsing');
  }
}

/**
 * Fetch voices from speech-engine via background worker.
 */
async function loadVoices() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'GET_VOICES' });
    if (!res || !res.success) {
      voiceSubstatusEl.textContent = 'Unable to query TTS voices.';
      return;
    }

    const {
      engines, localSystemVoices, selectedVoice, statusMessage,
      engineId, engineLabel, engineBadge
    } = res.data;

    // The badge names the engine that is actually speaking.
    if (engineBadgeEl) {
      engineBadgeEl.className = engineId ? 'engine-badge' : 'engine-badge warning';
    }
    if (badgeTextEl) {
      badgeTextEl.textContent = engineBadge || (engineId ? 'ENGINE' : 'SYSTEM');
    }

    voiceSubstatusEl.textContent = statusMessage || '';
    voiceSelectEl.innerHTML = '';

    // One group per TTS engine extension, the active engine first.
    (engines || []).forEach((engine) => {
      if (!engine.voices || engine.voices.length === 0) return;
      const isActive = engine.id === engineId;
      const grp = document.createElement('optgroup');
      grp.label = isActive ? `★ ${engine.fullLabel}` : engine.fullLabel;
      engine.voices.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.voiceName;
        opt.dataset.extensionId = v.extensionId || '';
        opt.dataset.lang = v.lang || '';
        opt.textContent = isActive ? `★ ${v.voiceName}` : v.voiceName;
        if (selectedVoice && v.voiceName === selectedVoice.voiceName) opt.selected = true;
        grp.appendChild(opt);
      });
      voiceSelectEl.appendChild(grp);
    });

    // Windows local system voices
    if (localSystemVoices && localSystemVoices.length > 0) {
      const grp = document.createElement('optgroup');
      grp.label = 'Windows System Voices';
      localSystemVoices.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.voiceName;
        opt.dataset.extensionId = '';
        opt.dataset.lang = v.lang || '';
        opt.textContent = v.lang ? `${v.voiceName} (${v.lang})` : v.voiceName;
        if (selectedVoice && v.voiceName === selectedVoice.voiceName && !v.extensionId) {
          opt.selected = true;
        }
        grp.appendChild(opt);
      });
      voiceSelectEl.appendChild(grp);
    }
  } catch (err) {
    console.warn('[Popup] Voice load error:', err);
    voiceSubstatusEl.textContent = 'Error loading voices: ' + err.message;
  }
}

/**
 * Synchronize with the active tab and existing playback session.
 */
function chromeCallbackPromise(invoke) {
  return new Promise((resolve, reject) => {
    try {
      invoke((value) => {
        let lastError = null;
        try {
          lastError = chrome.runtime?.lastError || null;
        } catch (err) {
          reject(err);
          return;
        }
        if (lastError) {
          reject(new Error(lastError.message || 'Chrome extension API request failed.'));
        } else {
          resolve(value);
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Hydrate every persisted value and the live playback snapshot before showing
 * the popup. The voice list is loaded independently so a slow provider cannot
 * block the first stable render.
 */
async function initActiveTabAndState() {
  try {
    const tabsRequest = Promise.resolve().then(() =>
      chrome.tabs.query({ active: true, currentWindow: true })
    );
    const preferencesRequest = chromeCallbackPromise((callback) => {
      chrome.storage.local.get(
        ['readAloud_popupTheme', 'readAloud_userPreferences', 'readAloud_pillVisible'],
        callback
      );
    });
    const playbackRequest = chromeCallbackPromise((callback) => {
      chrome.runtime.sendMessage({ action: 'GET_PLAYBACK_STATE' }, callback);
    });

    const [tabsResult, preferencesResult, playbackResult] = await Promise.allSettled([
      tabsRequest,
      preferencesRequest,
      playbackRequest
    ]);

    if (tabsResult.status === 'fulfilled' && tabsResult.value && tabsResult.value.length > 0) {
      const tab = tabsResult.value[0];
      activeTabId = tab.id;
      tabTitleEl.textContent = (tab.title || tab.url || 'Webpage').toUpperCase();
      tabTitleEl.title = tab.title || '';
    } else {
      tabTitleEl.textContent = 'STANDBY';
      if (tabsResult.status === 'rejected') {
        console.warn('[Popup] Active tab lookup failed:', tabsResult.reason);
      }
    }

    if (preferencesResult.status === 'fulfilled') {
      const res = preferencesResult.value || {};
      const theme = res.readAloud_popupTheme === 'light' ? 'light' : 'dark';
      applyTheme(theme);

      isPillVisible = typeof res.readAloud_pillVisible === 'boolean'
        ? res.readAloud_pillVisible
        : true;
      updatePillToggleText();

      const prefs = res.readAloud_userPreferences;
      if (prefs && typeof prefs.rate === 'number' && Number.isFinite(prefs.rate)) {
        currentSpeed = prefs.rate;
        updateSpeedDisplay(currentSpeed);
      }
      if (prefs && typeof prefs.volume === 'number' && Number.isFinite(prefs.volume)) {
        updateVolumeDisplay(prefs.volume);
      }
    } else {
      console.warn('[Popup] Preference hydration failed:', preferencesResult.reason);
      applyTheme('dark');
      isPillVisible = true;
      updatePillToggleText();
    }

    if (playbackResult.status === 'fulfilled') {
      const res = playbackResult.value;
      if (res && res.success && res.state) {
        const state = res.state;
        updatePlayState(
          state.playbackState,
          state.currentSentence,
          state.currentIndex,
          state.totalSentences
        );

        if (state.options && typeof state.options.rate === 'number') {
          currentSpeed = state.options.rate;
          updateSpeedDisplay(currentSpeed);
        }
        if (state.options && typeof state.options.volume === 'number') {
          updateVolumeDisplay(state.options.volume);
        }
      }
    } else {
      console.warn('[Popup] Playback-state hydration failed:', playbackResult.reason);
    }
  } catch (err) {
    console.warn('[Popup] Initial hydration failed:', err);
  } finally {
    // visibility:hidden preserves layout dimensions while preventing default
    // values and the wrong theme from flashing during popup initialization.
    document.body.classList.add('is-hydrated');
  }
}

function updateSpeedDisplay(rate) {
  speedSliderEl.value = String(rate);
  speedSliderEl.setAttribute('aria-valuetext', `${rate.toFixed(1)} times playback speed`);
  speedDisplayEl.textContent = `${rate.toFixed(1)}×`;

  speedChips.forEach(chip => {
    const chipSpeed = parseFloat(chip.dataset.speed);
    if (Math.abs(chipSpeed - rate) < 0.05) {
      chip.classList.add('active');
      chip.setAttribute('aria-pressed', 'true');
    } else {
      chip.classList.remove('active');
      chip.setAttribute('aria-pressed', 'false');
    }
  });
}

// Route fire-and-forget control messages through one rejection boundary.
// Callback-based requests (hydration and active-tab extraction) keep their
// explicit lastError handling in chromeCallbackPromise / their callbacks.
function sendRuntimeMessage(message) {
  try {
    const pending = chrome.runtime.sendMessage(message);
    if (pending && typeof pending.catch === 'function') {
      pending.catch((err) => {
        console.warn(`[Popup] ${message.action || 'Runtime'} message failed:`, err?.message || err);
      });
    }
    return pending;
  } catch (err) {
    console.warn(`[Popup] ${message.action || 'Runtime'} message failed:`, err?.message || err);
    return null;
  }
}

// ── Control Event Handlers ───────────────────────────────────────────

// Play / Pause Button
ctrlPlayBtn.addEventListener('click', async () => {
  if (currentPlaybackState === 'PLAYING') {
    sendRuntimeMessage({ action: 'PAUSE_PLAYBACK' });
  } else if (currentPlaybackState === 'PAUSED') {
    sendRuntimeMessage({ action: 'RESUME_PLAYBACK' });
  } else {
    if (!activeTabId) {
      sentenceBoxEl.textContent = 'No active webpage found to read.';
      return;
    }

    sentenceBoxEl.classList.remove('idle');
    sentenceBoxEl.textContent = 'Scanning article text on webpage…';

    try {
      chrome.tabs.sendMessage(activeTabId, { action: 'TRIGGER_READ_PAGE' }, (res) => {
        if (chrome.runtime.lastError || !res || !res.success) {
          sentenceBoxEl.classList.add('idle');
          sentenceBoxEl.textContent = 'Could not extract text. Refresh the webpage and try again.';
        }
      });
    } catch (err) {
      sentenceBoxEl.textContent = 'Error: ' + err.message;
    }
  }
});

// Skip Backward
ctrlPrevBtn.addEventListener('click', () => {
  sendRuntimeMessage({ action: 'SKIP_BACKWARD' });
});

// Skip Forward
ctrlNextBtn.addEventListener('click', () => {
  sendRuntimeMessage({ action: 'SKIP_FORWARD' });
});

// Stop
ctrlStopBtn.addEventListener('click', () => {
  sendRuntimeMessage({ action: 'STOP_PLAYBACK' });
});

// Voice Select
voiceSelectEl.addEventListener('change', () => {
  const opt = voiceSelectEl.selectedOptions[0];
  if (!opt || !opt.value) return;

  const voiceName = opt.value;
  const extensionId = opt.dataset.extensionId || null;
  const lang = opt.dataset.lang || null;

  sendRuntimeMessage({
    action: 'SET_VOICE',
    voiceName,
    extensionId: extensionId || undefined,
    lang: lang || undefined
  });

  voiceSubstatusEl.textContent = `Active: ${voiceName}`;
});

// Speed Slider — display updates live; the SET_RATE send is debounced because
// the background restarts the current utterance on every rate change while
// playing (an un-debounced drag causes stop/restart stutter).
let rateSendTimer = null;
speedSliderEl.addEventListener('input', () => {
  const rate = parseFloat(speedSliderEl.value);
  currentSpeed = rate;
  updateSpeedDisplay(rate);
  if (rateSendTimer) clearTimeout(rateSendTimer);
  rateSendTimer = setTimeout(() => {
    sendRuntimeMessage({ action: 'SET_RATE', rate: currentSpeed });
  }, 200);
});

// Volume Slider — debounced for the same reason (restart-on-change).
let volumeSendTimer = null;
if (volumeSliderEl) {
  volumeSliderEl.addEventListener('input', () => {
    const vol = parseFloat(volumeSliderEl.value);
    updateVolumeDisplay(vol);
    if (volumeSendTimer) clearTimeout(volumeSendTimer);
    volumeSendTimer = setTimeout(() => {
      sendRuntimeMessage({ action: 'SET_VOLUME', volume: vol });
    }, 200);
  });
}

// Speed Chips
speedChips.forEach(chip => {
  chip.addEventListener('click', () => {
    const rate = parseFloat(chip.dataset.speed);
    currentSpeed = rate;
    updateSpeedDisplay(rate);
    sendRuntimeMessage({ action: 'SET_RATE', rate });
  });
});

// Theme Toggle
themeToggleEl.addEventListener('click', () => {
  const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(nextTheme);
  chrome.storage.local.set({ readAloud_popupTheme: nextTheme }).catch(() => {});
});

// Toggle On-Screen Pill Player
btnTogglePill.addEventListener('click', () => {
  isPillVisible = !isPillVisible;
  updatePillToggleText();
  chrome.storage.local.set({ readAloud_pillVisible: isPillVisible }).catch(() => {});
  sendRuntimeMessage({
    action: 'SET_PLAYER_VISIBILITY',
    visible: isPillVisible
  });
});

// ── Background Broadcast Listener ────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (!message || !message.action) return;

  switch (message.action) {
    case 'SENTENCE_CHANGED': {
      updatePlayState('PLAYING', message.sentence, message.index, message.totalSentences);
      break;
    }

    case 'PLAYBACK_PAUSED': {
      updatePlayState('PAUSED');
      break;
    }

    case 'PLAYBACK_RESUMED': {
      updatePlayState('PLAYING');
      break;
    }

    case 'PLAYBACK_STOPPED':
    case 'PLAYBACK_COMPLETED': {
      updatePlayState('STOPPED');
      break;
    }

    case 'OPTIONS_CHANGED': {
      if (message.options && typeof message.options.rate === 'number') {
        currentSpeed = message.options.rate;
        updateSpeedDisplay(currentSpeed);
      }
      if (message.options && typeof message.options.volume === 'number') {
        updateVolumeDisplay(message.options.volume);
      }
      if (message.options && message.options.voiceName) {
        if (voiceSelectEl) {
          voiceSelectEl.value = message.options.voiceName;
        }
      }
      break;
    }
  }
});

// Boot
loadVoices();
initActiveTabAndState();
