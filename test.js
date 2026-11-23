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

const diagnosticBadgeEl = document.getElementById('engine-diagnostic-badge');
const diagnosticEnvironmentEl = document.getElementById('engine-diagnostic-environment');
const diagnosticProviderVersionEl = document.getElementById('diagnostic-provider-version');
const diagnosticSampleTextEl = document.getElementById('diagnostic-sample-text');
const diagnosticStatusEl = document.getElementById('engine-diagnostic-status');
const diagnosticLogEl = document.getElementById('engine-diagnostic-log');
const btnRunDiagnostic = document.getElementById('btn-run-engine-diagnostic');
const btnStopDiagnostic = document.getElementById('btn-stop-engine-diagnostic');
const btnMarkAudible = document.getElementById('btn-mark-audible');
const btnExportDiagnostic = document.getElementById('btn-export-engine-diagnostic');
const btnClearDiagnostic = document.getElementById('btn-clear-engine-diagnostic');

let activeDiagnosticRequestId = null;
let diagnosticTimeoutId = null;
let diagnosticReport = null;
let diagnosticStartPerf = null;

const manifestInfo = chrome.runtime.getManifest();
const chromeVersion = navigator.userAgent.match(/Chrome\/(\d+(?:\.\d+)+)/)?.[1] || 'Unknown';
const environmentInfo = {
  capturedAt: new Date().toISOString(),
  extensionVersion: manifestInfo.version,
  browser: 'Chrome',
  browserVersion: chromeVersion,
  userAgent: navigator.userAgent,
  platform: navigator.platform || 'Unknown',
  language: navigator.language || 'Unknown',
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown'
};
diagnosticEnvironmentEl.textContent =
  `NarraTrace ${environmentInfo.extensionVersion} · Chrome ${environmentInfo.browserVersion} · ${environmentInfo.platform} · ${environmentInfo.timeZone}`;

function setDiagnosticStatus(message, tone = 'info') {
  diagnosticStatusEl.textContent = message;
  diagnosticBadgeEl.className = `badge ${tone}`;
  diagnosticBadgeEl.textContent =
    tone === 'success' ? 'Passed' :
    tone === 'warning' ? 'Attention' :
    tone === 'danger' ? 'Failed' : 'Ready';
}

function renderDiagnosticEvents() {
  if (!diagnosticReport || diagnosticReport.events.length === 0) {
    diagnosticLogEl.textContent = 'No diagnostic events recorded.';
    return;
  }

  diagnosticLogEl.textContent = diagnosticReport.events.map((entry) => {
    const event = entry.event;
    const parts = [
      `${String(entry.elapsedMs).padStart(5, ' ')} ms`,
      event.type
    ];
    if (event.charIndex !== null) parts.push(`char=${event.charIndex}`);
    if (event.length !== null) parts.push(`length=${event.length}`);
    if (event.charLength !== null) parts.push(`charLength=${event.charLength}`);
    if (event.errorMessage) parts.push(`error=${event.errorMessage}`);
    return parts.join(' · ');
  }).join('\n');
}

function finishDiagnosticTimeout(requestId) {
  if (activeDiagnosticRequestId !== requestId) return;
  activeDiagnosticRequestId = null;
  diagnosticTimeoutId = null;
  if (diagnosticReport) {
    diagnosticReport.success = false;
    diagnosticReport.resultType = 'client-timeout';
    diagnosticReport.error = 'No completion message arrived within 70 seconds. Check whether Chrome suspended the service worker or the provider stopped responding.';
    diagnosticReport.durationMs = null;
  }
  btnRunDiagnostic.disabled = false;
  btnStopDiagnostic.disabled = true;
  btnMarkAudible.disabled = true;
  btnClearDiagnostic.disabled = false;
  btnExportDiagnostic.disabled = !diagnosticReport;
  setDiagnosticStatus('No completion event arrived within 70 seconds. Export the report and check the service-worker console.', 'danger');
}

async function runEngineDiagnostic() {
  if (activeDiagnosticRequestId) return;

  const option = voiceSelectEl.selectedOptions[0];
  if (!option || !option.value) {
    setDiagnosticStatus('Select an available Chrome TTS voice first.', 'warning');
    return;
  }

  const sampleText = diagnosticSampleTextEl.value.trim();
  if (!sampleText || sampleText.length > 500) {
    setDiagnosticStatus('Enter a sample between 1 and 500 characters.', 'warning');
    return;
  }

  const requestPerfStart = performance.now();
  const requestId = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `diag-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const selectedExtensionId = option.dataset.extensionId || null;
  const selectedLang = option.dataset.lang || null;
  const engineGroup = option.parentElement?.label || 'Unknown / system';
  const startedAt = new Date().toISOString();

  diagnosticReport = {
    schemaVersion: 1,
    environment: environmentInfo,
    provider: {
      group: engineGroup,
      voiceName: option.value,
      extensionId: selectedExtensionId,
      language: selectedLang,
      version: diagnosticProviderVersionEl.value.trim() || null
    },
    test: {
      startedAt,
      rate: Number.parseFloat(rateSliderEl.value),
      sampleCharacterCount: sampleText.length,
      sampleTextIncluded: false,
      audibleStartMarkedMs: null,
      audibleStartMarkedAt: null
    },
    events: [],
    success: null,
    resultType: null,
    durationMs: null,
    error: null
  };

  activeDiagnosticRequestId = requestId;
  diagnosticStartPerf = requestPerfStart;
  btnRunDiagnostic.disabled = true;
  btnStopDiagnostic.disabled = true;
  btnMarkAudible.disabled = true;
  btnClearDiagnostic.disabled = true;
  btnExportDiagnostic.disabled = true;
  setDiagnosticStatus('Starting audible test…', 'warning');
  diagnosticLogEl.textContent = 'Waiting for the Chrome TTS provider…';

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'RUN_TTS_DIAGNOSTIC',
      requestId,
      text: sampleText,
      voiceName: option.value,
      extensionId: selectedExtensionId,
      lang: selectedLang,
      rate: Number.parseFloat(rateSliderEl.value)
    });

    if (activeDiagnosticRequestId !== requestId) return;
    if (!response?.success) {
      activeDiagnosticRequestId = null;
      btnRunDiagnostic.disabled = false;
      btnStopDiagnostic.disabled = true;
      btnMarkAudible.disabled = true;
      btnClearDiagnostic.disabled = false;
      diagnosticReport.success = false;
      diagnosticReport.resultType = 'request-rejected';
      diagnosticReport.error = response?.error || 'Background service worker rejected the test request.';
      btnExportDiagnostic.disabled = false;
      setDiagnosticStatus(diagnosticReport.error, 'danger');
      return;
    }

    diagnosticReport.test.startedAt = response.startedAt || startedAt;
    btnStopDiagnostic.disabled = false;
    btnMarkAudible.disabled = false;
    diagnosticReport.provider.voiceName = response.voice?.voiceName || option.value;
    diagnosticReport.provider.extensionId = response.voice?.extensionId || null;
    diagnosticReport.provider.language = response.voice?.lang || selectedLang;

    diagnosticTimeoutId = setTimeout(
      () => finishDiagnosticTimeout(requestId),
      70000
    );
    setDiagnosticStatus('Speaking through the selected provider. Listen for gaps and compare the highlight on a normal article separately.', 'warning');
  } catch (error) {
    if (activeDiagnosticRequestId !== requestId) return;
    activeDiagnosticRequestId = null;
    btnRunDiagnostic.disabled = false;
    btnStopDiagnostic.disabled = true;
    btnMarkAudible.disabled = true;
    btnClearDiagnostic.disabled = false;
    diagnosticReport.success = false;
    diagnosticReport.resultType = 'message-error';
    diagnosticReport.error = String(error?.message || error);
    btnExportDiagnostic.disabled = false;
    setDiagnosticStatus(diagnosticReport.error, 'danger');
  }
}

btnRunDiagnostic.addEventListener('click', runEngineDiagnostic);

btnStopDiagnostic.addEventListener('click', async () => {
  if (!activeDiagnosticRequestId) return;
  btnStopDiagnostic.disabled = true;
  setDiagnosticStatus('Stopping the diagnostic utterance…', 'warning');
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'STOP_TTS_DIAGNOSTIC',
      requestId: activeDiagnosticRequestId
    });
    if (!response?.success && activeDiagnosticRequestId) {
      btnStopDiagnostic.disabled = false;
      setDiagnosticStatus(response?.error || 'The diagnostic could not be stopped.', 'warning');
    }
  } catch (error) {
    btnStopDiagnostic.disabled = false;
    setDiagnosticStatus(String(error?.message || error), 'danger');
  }
});

btnMarkAudible.addEventListener('click', () => {
  if (!diagnosticReport || !activeDiagnosticRequestId || diagnosticStartPerf === null) return;
  diagnosticReport.test.audibleStartMarkedMs = Math.max(
    0,
    Math.round(performance.now() - diagnosticStartPerf)
  );
  diagnosticReport.test.audibleStartMarkedAt = new Date().toISOString();
  btnMarkAudible.disabled = true;
  setDiagnosticStatus(
    `First audible output marked at approximately ${diagnosticReport.test.audibleStartMarkedMs} ms after starting the test.`,
    'warning'
  );
});

btnExportDiagnostic.addEventListener('click', () => {
  if (!diagnosticReport) return;
  const blob = new Blob([JSON.stringify(diagnosticReport, null, 2)], {
    type: 'application/json'
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `narratrace-tts-diagnostic-${Date.now()}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

btnClearDiagnostic.addEventListener('click', () => {
  if (activeDiagnosticRequestId) return;
  diagnosticReport = null;
  diagnosticStartPerf = null;
  btnStopDiagnostic.disabled = true;
  btnMarkAudible.disabled = true;
  btnExportDiagnostic.disabled = true;
  diagnosticLogEl.textContent = 'No diagnostic events recorded.';
  setDiagnosticStatus('Diagnostic report cleared. Select a voice and run the test when ready.', 'info');
});

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
    case 'TTS_DIAGNOSTIC_EVENT': {
      console.info('[NarraTrace diagnostics] Event received', {
        type: message.event?.type,
        elapsedMs: message.elapsedMs,
        hasReport: Boolean(diagnosticReport),
        messageRequestId: message.requestId,
        activeRequestId: activeDiagnosticRequestId,
        requestMatches: message.requestId === activeDiagnosticRequestId
      });
      if (!diagnosticReport || message.requestId !== activeDiagnosticRequestId || !message.event) break;
      const event = {
        type: String(message.event.type || 'unknown'),
        charIndex: Number.isFinite(message.event.charIndex) ? message.event.charIndex : null,
        length: Number.isFinite(message.event.length) ? message.event.length : null,
        charLength: Number.isFinite(message.event.charLength) ? message.event.charLength : null,
        errorMessage: typeof message.event.errorMessage === 'string' ? message.event.errorMessage : null
      };
      diagnosticReport.events.push({
        elapsedMs: Number.isFinite(message.elapsedMs) ? message.elapsedMs : null,
        event
      });
      renderDiagnosticEvents();
      break;
    }
    case 'TTS_DIAGNOSTIC_COMPLETE': {
      console.info('[NarraTrace diagnostics] Completion received', {
        resultType: message.resultType,
        success: message.success,
        hasReport: Boolean(diagnosticReport),
        messageRequestId: message.requestId,
        activeRequestId: activeDiagnosticRequestId,
        requestMatches: message.requestId === activeDiagnosticRequestId
      });
      if (!diagnosticReport || message.requestId !== activeDiagnosticRequestId) break;
      if (diagnosticTimeoutId) clearTimeout(diagnosticTimeoutId);
      diagnosticTimeoutId = null;
      activeDiagnosticRequestId = null;
      diagnosticReport.resultType = message.resultType || 'unknown';
      diagnosticReport.durationMs = Number.isFinite(message.durationMs) ? message.durationMs : null;
      const audibleWasMarked = Number.isFinite(diagnosticReport.test.audibleStartMarkedMs);
      diagnosticReport.success = message.success === true && audibleWasMarked;
      diagnosticReport.error = typeof message.error === 'string'
        ? message.error
        : (message.success === true && !audibleWasMarked
          ? 'Chrome returned an end event, but audible output was not manually confirmed.'
          : null);
      diagnosticReport.test.completedAt = new Date().toISOString();
      btnRunDiagnostic.disabled = false;
      btnStopDiagnostic.disabled = true;
      btnMarkAudible.disabled = true;
      btnClearDiagnostic.disabled = false;
      btnExportDiagnostic.disabled = false;
      setDiagnosticStatus(
        diagnosticReport.success
          ? `Passed: ${diagnosticReport.resultType} after ${diagnosticReport.durationMs} ms; first audible output marked at approximately ${diagnosticReport.test.audibleStartMarkedMs} ms.`
          : (message.success === true
            ? `Chrome TTS completed after ${diagnosticReport.durationMs} ms, but audible output was not confirmed. Repeat the test and click “I Hear Audio” while the sample is playing.`
            : `Diagnostic did not complete cleanly: ${diagnosticReport.error || diagnosticReport.resultType}.`),
        diagnosticReport.success ? 'success' : (message.success === true ? 'warning' : 'danger')
      );
      break;
    }
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
