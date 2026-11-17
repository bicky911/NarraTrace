/**
 * NarraTrace - Phase 3 Test Harness
 * Demonstrates Sentence Queue, chrome.storage.session persistence,
 * Skip Back/Forward, Jump-to-Sentence, and immediate Rate/Voice switching.
 */

import './sentence-tokenizer.js';
const { splitIntoChunks } = globalThis.ReadAloudTokenizer;

const badgeEl = document.getElementById('supertonic-badge');
const statusMessageEl = document.getElementById('status-message');
const voiceSelectEl = document.getElementById('voice-select');
const rateSliderEl = document.getElementById('rate-slider');
const rateDisplayEl = document.getElementById('rate-display');
const articleTextEl = document.getElementById('article-text');
const queueStatusBadgeEl = document.getElementById('queue-status-badge');
const sentenceCounterEl = document.getElementById('sentence-counter');
const sentencesPreviewEl = document.getElementById('sentences-preview');
const storageDisplayEl = document.getElementById('storage-display');

const btnPlayQueue = document.getElementById('btn-play-queue');
const btnPauseQueue = document.getElementById('btn-pause-queue');
const btnResumeQueue = document.getElementById('btn-resume-queue');
const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');
const btnStopQueue = document.getElementById('btn-stop-queue');
const btnInspectStorage = document.getElementById('btn-inspect-storage');

let currentSentences = [];
let activeSentenceIndex = -1;

// Render sentence list preview
function renderSentenceList(sentences, activeIndex = -1) {
  currentSentences = sentences;
  activeSentenceIndex = activeIndex;

  sentencesPreviewEl.innerHTML = '';
  if (!sentences || sentences.length === 0) {
    sentencesPreviewEl.innerHTML = '<em>No sentences loaded.</em>';
    sentenceCounterEl.textContent = '0 / 0';
    return;
  }

  sentenceCounterEl.textContent = `${activeIndex >= 0 ? activeIndex + 1 : 0} / ${sentences.length}`;

  sentences.forEach((s, idx) => {
    const span = document.createElement('span');
    span.className = `sentence-item ${idx === activeIndex ? 'active' : ''}`;
    span.textContent = s.text + ' ';
    span.title = `Click to jump to sentence ${idx + 1}`;
    span.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'JUMP_TO_INDEX', index: idx });
    });
    sentencesPreviewEl.appendChild(span);
  });
}

// Update highlighting on sentence change
function updateActiveSentence(index) {
  activeSentenceIndex = index;
  sentenceCounterEl.textContent = `${index + 1} / ${currentSentences.length}`;
  const spans = sentencesPreviewEl.querySelectorAll('.sentence-item');
  spans.forEach((span, idx) => {
    if (idx === index) {
      span.classList.add('active');
      span.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      span.classList.remove('active');
    }
  });
}

// Load and populate voices
async function loadVoices() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'GET_VOICES' });
    if (!response || !response.success) return;

    const report = response.data;
    if (report.engineId) {
      badgeEl.className = 'badge success';
      badgeEl.textContent = `${report.engineLabel} Active`;
    } else {
      badgeEl.className = 'badge warning';
      badgeEl.textContent = 'System Voice Fallback';
    }
    statusMessageEl.textContent = report.statusMessage;

    voiceSelectEl.innerHTML = '';

    (report.engines || []).forEach((engine) => {
      if (!engine.voices || engine.voices.length === 0) return;
      const isActive = engine.id === report.engineId;
      const group = document.createElement('optgroup');
      group.label = isActive ? `★ ${engine.fullLabel}` : engine.fullLabel;
      engine.voices.forEach((v) => {
        const opt = document.createElement('option');
        opt.value = v.voiceName;
        opt.textContent = `${v.voiceName} (${v.lang || 'en'})`;
        opt.dataset.extensionId = v.extensionId || '';
        opt.dataset.lang = v.lang || '';
        if (report.selectedVoice && report.selectedVoice.voiceName === v.voiceName) {
          opt.selected = true;
        }
        group.appendChild(opt);
      });
      voiceSelectEl.appendChild(group);
    });

    if (report.localSystemVoices && report.localSystemVoices.length > 0) {
      const sysGroup = document.createElement('optgroup');
      sysGroup.label = '💻 Windows Local Voices';
      report.localSystemVoices.forEach((v) => {
        const opt = document.createElement('option');
        opt.value = v.voiceName;
        opt.textContent = `${v.voiceName}`;
        opt.dataset.extensionId = '';
        opt.dataset.lang = v.lang || '';
        if (report.selectedVoice && report.selectedVoice.voiceName === v.voiceName && (!report.selectedVoice.extensionId)) {
          opt.selected = true;
        }
        sysGroup.appendChild(opt);
      });
      voiceSelectEl.appendChild(sysGroup);
    }
  } catch (err) {
    console.warn('Voice loading error:', err);
  }
}

// Slider rate handler - applies immediately
rateSliderEl.addEventListener('input', () => {
  const rate = parseFloat(rateSliderEl.value);
  rateDisplayEl.textContent = `${rate.toFixed(1)}x`;
  chrome.runtime.sendMessage({ action: 'SET_RATE', rate });
});

// Voice select handler - applies immediately
voiceSelectEl.addEventListener('change', () => {
  const opt = voiceSelectEl.selectedOptions[0];
  if (!opt) return;
  chrome.runtime.sendMessage({
    action: 'SET_VOICE',
    voiceName: opt.value,
    extensionId: opt.dataset.extensionId || null,
    lang: opt.dataset.lang || null
  });
});

// Play Queue button
btnPlayQueue.addEventListener('click', () => {
  const text = articleTextEl.value.trim();
  const sentences = splitIntoChunks(text);
  if (sentences.length === 0) return;

  renderSentenceList(sentences, 0);
  queueStatusBadgeEl.className = 'badge success';
  queueStatusBadgeEl.textContent = 'Playing';

  const opt = voiceSelectEl.selectedOptions[0];
  chrome.runtime.sendMessage({
    action: 'START_PLAYBACK',
    sentences,
    startIndex: 0,
    options: {
      rate: parseFloat(rateSliderEl.value),
      voiceName: opt ? opt.value : null,
      extensionId: opt?.dataset.extensionId || null,
      lang: opt?.dataset.lang || null
    }
  });
});

// Pause button
btnPauseQueue.addEventListener('click', () => {
  queueStatusBadgeEl.className = 'badge warning';
  queueStatusBadgeEl.textContent = 'Paused';
  chrome.runtime.sendMessage({ action: 'PAUSE_PLAYBACK' });
});

// Resume button
btnResumeQueue.addEventListener('click', () => {
  queueStatusBadgeEl.className = 'badge success';
  queueStatusBadgeEl.textContent = 'Playing';
  chrome.runtime.sendMessage({ action: 'RESUME_PLAYBACK' });
});

// Prev button
btnPrev.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'SKIP_BACKWARD' });
});

// Next button
btnNext.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'SKIP_FORWARD' });
});

// Stop button
btnStopQueue.addEventListener('click', () => {
  queueStatusBadgeEl.className = 'badge info';
  queueStatusBadgeEl.textContent = 'Stopped';
  updateActiveSentence(-1);
  chrome.runtime.sendMessage({ action: 'STOP_PLAYBACK' });
});

// Inspect chrome.storage.session directly
btnInspectStorage.addEventListener('click', async () => {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'GET_SESSION_STORAGE' });
    if (res && res.success) {
      storageDisplayEl.textContent = JSON.stringify(res.data, null, 2);
    } else {
      storageDisplayEl.textContent = 'Failed to inspect session storage: ' + (res?.error || 'Unknown error');
    }
  } catch (err) {
    storageDisplayEl.textContent = 'Inspection error: ' + err.message;
  }
});

// Listen for playback updates broadcasted by background worker
chrome.runtime.onMessage.addListener((message) => {
  if (!message || !message.action) return;

  switch (message.action) {
    case 'SENTENCE_CHANGED': {
      updateActiveSentence(message.index);
      queueStatusBadgeEl.className = 'badge success';
      queueStatusBadgeEl.textContent = 'Playing';
      break;
    }
    case 'PLAYBACK_PAUSED': {
      queueStatusBadgeEl.className = 'badge warning';
      queueStatusBadgeEl.textContent = 'Paused';
      break;
    }
    case 'PLAYBACK_RESUMED': {
      queueStatusBadgeEl.className = 'badge success';
      queueStatusBadgeEl.textContent = 'Playing';
      break;
    }
    case 'PLAYBACK_STOPPED':
    case 'PLAYBACK_COMPLETED': {
      queueStatusBadgeEl.className = 'badge info';
      queueStatusBadgeEl.textContent = message.action === 'PLAYBACK_COMPLETED' ? 'Finished' : 'Stopped';
      updateActiveSentence(-1);
      break;
    }
    case 'OPTIONS_CHANGED': {
      if (message.options && typeof message.options.rate === 'number') {
        rateSliderEl.value = message.options.rate;
        rateDisplayEl.textContent = `${message.options.rate.toFixed(1)}x`;
      }
      break;
    }
  }
});

// Initial boot
loadVoices();

// Pre-render default text sentences
renderSentenceList(splitIntoChunks(articleTextEl.value), -1);

// Sync with existing background state if any
chrome.runtime.sendMessage({ action: 'GET_PLAYBACK_STATE' }, (res) => {
  if (res && res.success && res.state && res.state.hasQueue) {
    const state = res.state;
    queueStatusBadgeEl.textContent = state.playbackState;
    if (state.playbackState === 'PLAYING') {
      queueStatusBadgeEl.className = 'badge success';
    } else if (state.playbackState === 'PAUSED') {
      queueStatusBadgeEl.className = 'badge warning';
    }
    if (state.options && state.options.rate) {
      rateSliderEl.value = state.options.rate;
      rateDisplayEl.textContent = `${state.options.rate.toFixed(1)}x`;
    }
  }
});
