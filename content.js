/**
 * NarraTrace - Content Script, Floating Player & Synced Word Tracing
 * 
 * HARD RULES RESPECTED:
 * 1. Strictly uses chrome.tts via background messaging. Zero prohibited APIs.
 * 2. Communicates with background worker strictly via chrome.runtime messages.
 * 3. Encapsulated in Shadow DOM so website styles never conflict.
 * 4. Highlighting driven from our own sentence queue via native CSS Custom Highlight API.
 * 5. Highlight stays in sync across pause, resume, skip, speed, and voice changes.
 */

(function () {
  // Prevent duplicate injection
  if (document.getElementById('read-aloud-player-host')) {
    return;
  }

  // -----------------------------------------------------------------
  // Safe messaging & storage helpers to eliminate "Extension context invalidated"
  // -----------------------------------------------------------------
  function isExtensionValid() {
    return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
  }

  let _notifiedInvalid = false;
  // Hoisted to avoid TDZ: these are referenced early via handleContextInvalidated / applyCollapsedState / updatePageHighlightStyle
  let tuckTimer = null;
  let heartbeatTimer = null;
  let wordBoxEl = null;
  let activeWordRange = null;
  let lastBoxTop = -1;

  // ─── Spring-Physics Word-Capsule Engine ─────────────────────────────────────
  // Simulates Hooke's Law: F = -k·x  with damping.
  // Each property (x, y, w, h) is an independent spring that settles to a
  // target value with organic over/undershoot depending on stiffness + damping.
  //
  //   stiffness  (k)  220  — higher = snappier, bouncier
  //   damping    (d)   24  — higher = more viscous, less bounce
  //   mass       (m)    1  — kept at 1; affects convergence speed vs. mass
  //
  // The loop runs only while any spring has not yet settled (velocity > ε or
  // |delta| > ε), so it costs zero when the capsule is idle.
  const SPRING = { k: 220, d: 24, m: 1 };
  const SPRING_EPSILON = 0.08; // px — below this velocity+delta we settle

  // ─── Golden Gaze Sight-Line Scroll Engine ───────────────────────────────────
  // Friction-damped scroll that locks active sentence to 38% from viewport top.
  // Friction coefficient: each frame we close (target − current) by GAZE_FRICTION.
  // Loop exits when |delta| < GAZE_EPSILON and |velocity| < GAZE_EPSILON.
  const GAZE_ANCHOR   = 0.38;   // fraction from viewport top
  const GAZE_FRICTION = 0.10;   // per-frame lerp coefficient (10% approach)
  const GAZE_EPSILON  = 0.5;    // px — stop ticking below this residual

  let _gazeRafId   = null;
  let _gazeTarget  = null;   // { y: number, container: Element|null }
  let _gazeVel     = 0;      // current scroll velocity (px/frame)

  /**
   * Schedule a Golden Gaze scroll toward targetY on the page (container=null)
   * or inside a scroll container (for the Focus Reader overlay).
   * @param {number}       targetY    – absolute scrollY destination (page) OR
   *                                    scrollTop destination (container)
   * @param {Element|null} container  – scrollable element, or null for window
   */
  function gazeScrollTo(targetY, container) {
    _gazeTarget = { y: targetY, container: container || null };
    if (!_gazeRafId) _gazeRafId = requestAnimationFrame(_gazeLoop);
  }

  function _gazeLoop() {
    _gazeRafId = null;
    if (!_gazeTarget) return;

    const { y: tgt, container } = _gazeTarget;
    const cur = container ? container.scrollTop : window.scrollY;
    const delta = tgt - cur;

    if (Math.abs(delta) < GAZE_EPSILON) {
      // Arrived — snap to exact target and stop
      if (container) container.scrollTop = tgt;
      else window.scrollTo(0, tgt);
      _gazeTarget = null;
      _gazeVel    = 0;
      return;
    }

    // Critically-damped approach: lerp a fixed fraction per frame
    const step = delta * GAZE_FRICTION;
    const next = cur + step;
    if (container) container.scrollTop = next;
    else window.scrollTo(0, next);

    _gazeRafId = requestAnimationFrame(_gazeLoop);
  }

  /** Cancel any in-flight Golden Gaze scroll. */
  function gazeCancelScroll() {
    if (_gazeRafId) { cancelAnimationFrame(_gazeRafId); _gazeRafId = null; }
    _gazeTarget = null;
    _gazeVel    = 0;
  }

  // Per-property spring state
  const _sp = {
    x:  { cur: 0, vel: 0, tgt: 0 },
    y:  { cur: 0, vel: 0, tgt: 0 },
    w:  { cur: 0, vel: 0, tgt: 0 },
    h:  { cur: 0, vel: 0, tgt: 0 },
  };
  let _springRafId = null;
  let _springRunning = false;

  /**
   * Advance one spring by dt seconds (Euler integration).
   * Returns true if the spring still needs ticking.
   */
  function _tickSpring(s, dt) {
    const force = -SPRING.k * (s.cur - s.tgt) - SPRING.d * s.vel;
    const acc   = force / SPRING.m;
    s.vel += acc * dt;
    s.cur += s.vel * dt;
    return Math.abs(s.vel) > SPRING_EPSILON || Math.abs(s.cur - s.tgt) > SPRING_EPSILON;
  }

  let _lastRafTime = null;
  function _springLoop(ts) {
    if (!wordBoxEl) { _springRunning = false; return; }
    const dt = _lastRafTime !== null ? Math.min((ts - _lastRafTime) / 1000, 0.05) : 0.016;
    _lastRafTime = ts;

    const xAlive = _tickSpring(_sp.x, dt);
    const yAlive = _tickSpring(_sp.y, dt);
    const wAlive = _tickSpring(_sp.w, dt);
    const hAlive = _tickSpring(_sp.h, dt);

    // Kinetic squish: while moving horizontally on the same line the capsule
    // slightly squishes in the direction of travel, then springs back.
    // We derive scaleX from X velocity relative to current width.
    const vxNorm  = _sp.w.cur > 4 ? _sp.x.vel / _sp.w.cur : 0;
    const squishX = 1 + Math.tanh(vxNorm * 0.14) * 0.09;  // ±9% max stretch
    const squishY = 1 / (squishX || 1);                    // volume-preserve

    wordBoxEl.style.transform =
      `translate3d(${_sp.x.cur.toFixed(2)}px, ${_sp.y.cur.toFixed(2)}px, 0) ` +
      `scaleX(${squishX.toFixed(4)}) scaleY(${squishY.toFixed(4)})`;
    wordBoxEl.style.width  = `${Math.max(0, _sp.w.cur).toFixed(2)}px`;
    wordBoxEl.style.height = `${Math.max(0, _sp.h.cur).toFixed(2)}px`;

    if (xAlive || yAlive || wAlive || hAlive) {
      _springRafId = requestAnimationFrame(_springLoop);
    } else {
      // Settle exactly on target to avoid sub-pixel drift
      _sp.x.cur = _sp.x.tgt; _sp.y.cur = _sp.y.tgt;
      _sp.w.cur = _sp.w.tgt; _sp.h.cur = _sp.h.tgt;
      wordBoxEl.style.transform =
        `translate3d(${_sp.x.tgt.toFixed(2)}px, ${_sp.y.tgt.toFixed(2)}px, 0)`;
      wordBoxEl.style.width  = `${_sp.w.tgt}px`;
      wordBoxEl.style.height = `${_sp.h.tgt}px`;
      _springRunning = false;
      _lastRafTime = null;
    }
  }

  /**
   * Drive the word capsule to a new target rect.
   * @param {number} x  left in viewport px (after padding)
   * @param {number} y  top  in viewport px (after padding)
   * @param {number} w  width  in px
   * @param {number} h  height in px
   * @param {boolean} snap  when true, teleport instantly (new line, first word)
   */
  function _springMoveTo(x, y, w, h, snap) {
    if (snap) {
      _sp.x.cur = _sp.x.tgt = x; _sp.x.vel = 0;
      _sp.y.cur = _sp.y.tgt = y; _sp.y.vel = 0;
      _sp.w.cur = _sp.w.tgt = w; _sp.w.vel = 0;
      _sp.h.cur = _sp.h.tgt = h; _sp.h.vel = 0;
      if (wordBoxEl) {
        wordBoxEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        wordBoxEl.style.width  = `${w}px`;
        wordBoxEl.style.height = `${h}px`;
      }
      if (_springRafId) { cancelAnimationFrame(_springRafId); _springRafId = null; }
      _springRunning = false;
      _lastRafTime = null;
    } else {
      _sp.x.tgt = x; _sp.y.tgt = y; _sp.w.tgt = w; _sp.h.tgt = h;
      if (!_springRunning) {
        _springRunning = true;
        _lastRafTime = null;
        _springRafId = requestAnimationFrame(_springLoop);
      }
    }
  }
  // ────────────────────────────────────────────────────────────────────────────
  function handleContextInvalidated() {
    if (_notifiedInvalid) return;
    _notifiedInvalid = true;
    console.log('[ReadAloud] Extension context invalidated (extension was reloaded). Refresh the page to reconnect.');
    if (typeof stopHeartbeat === 'function') stopHeartbeat();
    if (typeof stopMutationObserver === 'function') stopMutationObserver();
    if (typeof stopZoomTracking === 'function') stopZoomTracking();
    if (typeof clearHighlight === 'function') clearHighlight();
    if (typeof hideHoverPlayBtn === 'function') hideHoverPlayBtn();
    if (typeof hideSelectionTooltip === 'function') hideSelectionTooltip();
    const playBtnEl = shadow?.getElementById('ra-play');
    if (playBtnEl) {
      playBtnEl.title = 'Extension reloaded — refresh page to reconnect';
      playBtnEl.style.opacity = '0.5';
    }
    const ledEl = shadow?.getElementById('ra-led');
    if (ledEl) {
      ledEl.style.background = '#666666';
      ledEl.title = 'Extension reloaded — refresh page';
    }
    // Page-visible notice — the dimmed pill alone reads as "the extension is
    // broken" rather than "refresh the page". One toast, once per page
    // (_notifiedInvalid above guards against repeat firing).
    if (typeof showToast === 'function') {
      showToast('NarraTrace was updated — refresh this page (F5) to reactivate it.');
    }
  }

  function safeSendMessage(message, callback) {
    if (!isExtensionValid()) {
      handleContextInvalidated();
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (res) => {
        if (!isExtensionValid()) {
          handleContextInvalidated();
          return;
        }
        if (chrome.runtime?.lastError) return;
        if (callback) callback(res);
      });
    } catch (_) {
      handleContextInvalidated();
    }
  }

  function safeStorageGet(keys, callback) {
    if (!isExtensionValid()) {
      handleContextInvalidated();
      return;
    }
    try {
      chrome.storage.local.get(keys, (res) => {
        if (!isExtensionValid() || chrome.runtime?.lastError) return;
        if (callback) callback(res);
      });
    } catch (_) {
      handleContextInvalidated();
    }
  }

  function safeStorageSet(data) {
    if (!isExtensionValid()) {
      handleContextInvalidated();
      return;
    }
    try {
      chrome.storage.local.set(data).catch(() => {});
    } catch (_) {
      handleContextInvalidated();
    }
  }

  // -----------------------------------------------------------------
  // 1. Inject Page-Level Highlight Styles (for CSS Custom Highlight API)
  // -----------------------------------------------------------------
  let currentHighlightColor = 'orange';

  // Highlight tint options for the settings-panel swatches.
  const HIGHLIGHT_COLORS = {
    orange: { tint: 'rgba(255, 92, 0, 0.16)', word: '#FF5C00', border: '#FF5C00', dim: 'rgba(255, 92, 0, 0.22)' },
    indigo: { tint: 'rgba(92, 107, 192, 0.20)', word: '#5C6BC0', border: '#5C6BC0', dim: 'rgba(92, 107, 192, 0.22)' },
    green:  { tint: 'rgba(46, 158, 79, 0.18)', word: '#2E9E4F', border: '#2E9E4F', dim: 'rgba(46, 158, 79, 0.20)' },
    pink:   { tint: 'rgba(224, 85, 154, 0.18)', word: '#E0559A', border: '#E0559A', dim: 'rgba(224, 85, 154, 0.20)' }
  };

  function updatePageHighlightStyle(colorKey = 'orange') {
    currentHighlightColor = colorKey;
    const c = HIGHLIGHT_COLORS[colorKey] || HIGHLIGHT_COLORS.orange;
    let pageStyle = document.getElementById('read-aloud-page-styles');
    if (!pageStyle) {
      pageStyle = document.createElement('style');
      pageStyle.id = 'read-aloud-page-styles';
      (document.head || document.documentElement).appendChild(pageStyle);
    }
    // Dual-highlight: soft sentence tint background + punchy word tracking
    pageStyle.textContent = `
      ::highlight(read-aloud-sentence) {
        background-color: ${c.tint} !important;
        color: inherit !important;
      }
      ::highlight(read-aloud-word) {
        background-color: ${c.tint} !important;
        color: inherit !important;
      }
    `;
    if (wordBoxEl) {
      wordBoxEl.style.borderColor = c.border;
      wordBoxEl.style.backgroundColor = c.dim;
      wordBoxEl.style.boxShadow = `0 0 14px ${c.dim}, inset 0 0 4px ${c.dim}`;
      wordBoxEl.style.setProperty('--ra-accent', c.border);
      wordBoxEl.style.setProperty('--ra-accent-dim', c.dim);
    }
  }

  // Initial injection (TE orange text highlight)
  updatePageHighlightStyle();

  // -----------------------------------------------------------------
  // 2. Sentence Tokenizer — shared dual-loadable module (manifest loads
  //    sentence-tokenizer.js before this script; background imports the
  //    same file, so tokenization can never drift between contexts).
  // -----------------------------------------------------------------
  const { splitIntoSentences, splitIntoChunks } = globalThis.ReadAloudTokenizer;

  // -----------------------------------------------------------------
  // 3. Sentence DOM Range Mapper
  // -----------------------------------------------------------------
  let currentSentenceRanges = []; // Array of { index, text, range, element }
  // Char offset into the current sentence where resumed playback started
  // (0 during normal playback) — word events are relative to the remainder.
  let currentResumeOffset = 0;
  // True once we have tried to map ranges for the current queue and failed.
  // Without this, a page with no extractable text re-runs the whole extraction
  // (including a Readability clone) for EVERY sentence that arrives.
  let rangeMapAttempted = false;

  /**
   * Build a whitespace-normalised index of an element's text plus a map back
   * into raw DOM offsets.
   *
   * The tokenizer works on whitespace-collapsed text (see
   * ReadAloudTokenizer.normalizeWhitespace), so sentences have to be matched
   * against the SAME canonical form. normToRaw[i] holds the raw offset — in
   * the concatenation of the element's text nodes — of normalised character
   * i, which is what lets us build an exact DOM Range afterwards.
   *
   * @param {Element} element Root element to index
   * @returns {{ normText: string, normToRaw: number[], nodes: Array }}
   */
  function buildTextIndex(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    const normToRaw = [];
    let normText = '';
    let rawOffset = 0;
    let node;

    while ((node = walker.nextNode())) {
      const raw = node.textContent;
      if (raw.length === 0) continue;
      const nodeStart = rawOffset;
      rawOffset += raw.length;
      nodes.push({ node, start: nodeStart, end: rawOffset });

      for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (/\s/.test(ch)) {
          // Collapse a whitespace run into ONE space. The run may span two
          // text nodes, so only emit the space when we are not already on one.
          if (normText.length > 0 && !normText.endsWith(' ')) {
            normText += ' ';
            normToRaw.push(nodeStart + i);
          }
          continue;
        }
        normText += ch;
        normToRaw.push(nodeStart + i);
      }
    }

    // The element may end with whitespace — drop it so the normalised text
    // matches the tokenizer's trimmed output exactly.
    while (normText.endsWith(' ')) {
      normText = normText.slice(0, -1);
      normToRaw.pop();
    }

    return { normText, normToRaw, nodes };
  }

  /** Escape a string for safe use inside a RegExp. */
  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function findRangesInElement(element, sentenceTexts) {
    const { normText, normToRaw, nodes } = buildTextIndex(element);
    if (nodes.length === 0 || normText.length === 0) {
      return [];
    }

    const ranges = [];
    let searchOffset = 0;

    for (const rawSentence of sentenceTexts) {
      const cleanSentence = (typeof rawSentence === 'string' ? rawSentence : '').trim();
      if (!cleanSentence) continue;

      let foundIndex = normText.indexOf(cleanSentence, searchOffset);
      let matchedLength = cleanSentence.length;

      if (foundIndex === -1) {
        // Fallback: match the sentence word-by-word, tolerating any whitespace
        // variation. The old "first 24 characters only" heuristic produced a
        // range that stopped in the middle of the sentence, which visually
        // highlighted a fragment and broke the word-level offsets inside it.
        const pattern = cleanSentence
          .split(/\s+/)
          .filter(Boolean)
          .map(escapeRegExp)
          .join('\\s+');
        if (pattern) {
          try {
            const re = new RegExp(pattern, 'g');
            re.lastIndex = searchOffset;
            const match = re.exec(normText);
            if (match) {
              foundIndex = match.index;
              matchedLength = match[0].length;
            }
          } catch (_) {
            foundIndex = -1;
          }
        }
      }

      if (foundIndex === -1) continue;

      // Map the normalised match back onto raw DOM offsets.
      const normEnd = foundIndex + matchedLength;
      const lastNorm = Math.min(normEnd, normToRaw.length) - 1;
      if (lastNorm < foundIndex) continue;

      const rawStart = normToRaw[foundIndex];
      const rawEnd = normToRaw[lastNorm] + 1;
      searchOffset = normEnd;

      const startNodeInfo = nodes.find(nd => rawStart >= nd.start && rawStart < nd.end) || nodes[0];
      const startOffset = Math.max(0, rawStart - startNodeInfo.start);

      const endNodeInfo = nodes.find(nd => rawEnd > nd.start && rawEnd <= nd.end) || nodes[nodes.length - 1];
      const endOffset = Math.min(endNodeInfo.node.textContent.length, rawEnd - endNodeInfo.start);

      try {
        const range = document.createRange();
        range.setStart(startNodeInfo.node, startOffset);
        range.setEnd(endNodeInfo.node, endOffset);
        ranges.push({
          text: cleanSentence,
          range,
          element
        });
      } catch (e) {
        console.warn('[ReadAloud] Failed to create range for sentence:', cleanSentence, e);
      }
    }

    return ranges;
  }

  /**
   * Build a whitespace-normalised view of a DOM Range with a map from every
   * normalised character back to its (text node, offset) in the document.
   *
   * The TTS engine reports word offsets against the text we handed it, and
   * that text is whitespace-collapsed. Counting raw characters here instead
   * would drift by one position for every newline or double space inside the
   * sentence, and the word highlight would walk off the end of the text.
   */
  function buildRangeIndex(baseRange) {
    const root = baseRange.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? baseRange.commonAncestorContainer.parentNode
      : baseRange.commonAncestorContainer;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const positions = [];
    let normText = '';
    let node;

    while ((node = walker.nextNode())) {
      let nodeStart = 0;
      let nodeEnd = node.textContent.length;

      if (node === baseRange.startContainer) {
        nodeStart = baseRange.startOffset;
      }
      if (node === baseRange.endContainer) {
        nodeEnd = baseRange.endOffset;
      }

      if (node !== baseRange.startContainer && baseRange.comparePoint(node, node.textContent.length) < 0) {
        continue;
      }
      if (node !== baseRange.endContainer && baseRange.comparePoint(node, 0) > 0) {
        break;
      }

      const raw = node.textContent.substring(nodeStart, nodeEnd);
      for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (/\s/.test(ch)) {
          if (normText.length > 0 && !normText.endsWith(' ')) {
            normText += ' ';
            positions.push({ node, offset: nodeStart + i });
          }
          continue;
        }
        normText += ch;
        positions.push({ node, offset: nodeStart + i });
      }
    }

    return { normText, positions };
  }

  /**
   * Resolve a word sub-range within a sentence range using text offset.
   */
  function createSubRangeFromSentence(item, charIndex, charLength) {
    if (!item || !item.range) return null;
    const baseRange = item.range;
    const text = item.text || '';
    if (charIndex < 0 || charIndex >= text.length) return null;

    let targetStart = charIndex;
    let len = typeof charLength === 'number' ? charLength : 0;

    // Advance past leading punctuation or quotes so the highlight centers cleanly on the word
    while (targetStart < text.length && /^["'“‘(\[\{<«]/.test(text[targetStart])) {
      targetStart++;
      if (len > 1) len--;
    }

    if (!len || len <= 0) {
      const match = text.substring(targetStart).match(/^[^\s.,!?:;"'”’)\]\}»]+/);
      len = match ? match[0].length : 1;
    }

    // Strip trailing punctuation from word boundary
    while (len > 1 && /[.,!?:;"'”’)\]\}»]$/.test(text.substring(targetStart, targetStart + len))) {
      len--;
    }

    const targetEnd = Math.min(targetStart + Math.max(1, len), text.length);

    const { positions } = buildRangeIndex(baseRange);
    if (positions.length === 0) return null;

    const lastIndex = positions.length - 1;
    const startPos = positions[Math.min(targetStart, lastIndex)];
    const endIndex = Math.min(Math.max(targetEnd - 1, targetStart), lastIndex);
    const endPos = positions[endIndex];
    if (!startPos || !endPos) return null;

    try {
      const sub = document.createRange();
      sub.setStart(startPos.node, Math.min(startPos.offset, startPos.node.textContent.length));
      sub.setEnd(endPos.node, Math.min(endPos.offset + 1, endPos.node.textContent.length));
      return sub;
    } catch (_) {}
    return null;
  }

  function updateWordBoxPosition() {
    if (!wordBoxEl || !activeWordRange) {
      if (wordBoxEl) wordBoxEl.classList.remove('visible');
      lastBoxTop = -1;
      return;
    }
    try {
      const rect = activeWordRange.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) {
        const padX = 5;
        const padY = 2;
        const left = rect.left - padX;
        const top  = rect.top  - padY;
        const w    = rect.width  + padX * 2;
        const h    = rect.height + padY * 2;

        // Line-wrap detection: vertical jump > 7px → snap, no physics sweep
        // across the page. Same line → let spring physics glide & squish.
        // Also snap immediately when OS prefers reduced motion.
        const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const isNewLine = (lastBoxTop !== -1) && (Math.abs(top - lastBoxTop) > 7);
        const isFirst   = lastBoxTop === -1;

        _springMoveTo(left, top, w, h, isNewLine || isFirst || prefersReducedMotion);

        lastBoxTop = top;
        wordBoxEl.classList.add('visible');
      } else {
        wordBoxEl.classList.remove('visible');
        lastBoxTop = -1;
      }
    } catch (_) {
      if (wordBoxEl) wordBoxEl.classList.remove('visible');
      lastBoxTop = -1;
    }
  }

  function applyWordHighlight(index, charIndex, charLength) {
    if (isReaderOpen) {
      updateReaderWordHighlight(index, charIndex, charLength);
    }
    if (index < 0 || index >= currentSentenceRanges.length) return;
    const item = currentSentenceRanges[index];
    if (!item) return;

    const wordRange = createSubRangeFromSentence(item, charIndex, charLength);
    activeWordRange = wordRange;
    if (wordRange) {
      updateWordBoxPosition();
      if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
        try {
          CSS.highlights.set('read-aloud-word', new Highlight(wordRange));
        } catch (_) {}
      }
    }
  }

  function clearWordHighlight() {
    activeWordRange = null;
    lastBoxTop = -1;
    // Stop any running spring RAF loop
    if (_springRafId) {
      cancelAnimationFrame(_springRafId);
      _springRafId = null;
      _springRunning = false;
      _lastRafTime = null;
    }
    // Cancel any in-flight Golden Gaze scroll
    gazeCancelScroll();
    if (wordBoxEl) {
      wordBoxEl.classList.remove('visible');
    }
    if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
      try {
        CSS.highlights.delete('read-aloud-word');
      } catch (_) {}
    }
  }

  function applyHighlight(index) {
    currentSentenceIndex = index;
    clearWordHighlight();

    if (isReaderOpen) {
      updateReaderHighlight(index);
    }

    if (index < 0 || index >= currentSentenceRanges.length) {
      currentSentenceText = '';
      clearHighlight();
      return;
    }

    const item = currentSentenceRanges[index];
    currentSentenceText = (item && item.text) ? item.text : '';
    if (!item || !item.range) return;

    // Guard against stale ranges whose endpoints have been removed from the
    // document (SPA re-render, dynamic DOM mutation). If detached, attempt
    // to dynamically re-locate the sentence in the updated DOM before giving up.
    try {
      const startNode = item.range.startContainer;
      const endNode = item.range.endContainer;
      if (!document.contains(startNode) || !document.contains(endNode)) {
        if (!remapCurrentSentence()) {
          console.warn('[ReadAloud] Highlight range endpoints detached — skipping.');
          return;
        }
      }
    } catch (_) {
      return;
    }

    // Apply CSS Custom Highlight
    if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
      try {
        const highlight = new Highlight(item.range);
        CSS.highlights.set('read-aloud-sentence', highlight);
      } catch (err) {
        console.warn('[ReadAloud] CSS.highlights error:', err);
      }
    }

    // Golden Gaze: friction-damped scroll anchoring active sentence at 38% from top
    try {
      const rect = item.range.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const anchorY   = window.innerHeight * GAZE_ANCHOR;
        const sentMidY  = rect.top + rect.height / 2;
        const inBand    = sentMidY >= anchorY - 80 && sentMidY <= anchorY + 80;
        if (!inBand) {
          const targetScrollY = Math.max(0, window.scrollY + sentMidY - anchorY);
          gazeScrollTo(targetScrollY, null);
        }
      }
    } catch (_) {}
  }

  function clearHighlight() {
    if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
      try {
        CSS.highlights.delete('read-aloud-sentence');
        CSS.highlights.delete('read-aloud-word');
      } catch (_) {}
    }
    clearReaderHighlight();
  }

  // -----------------------------------------------------------------
  // 3b. DOM Mutation Watch (stale highlight ranges)
  // -----------------------------------------------------------------
  // Pages that re-render while you read (React/Vue apps, infinite scroll,
  // live blogs) replace the nodes our Range objects point at. The Highlight
  // API then refuses the detached range (InvalidStateError /
  // NoModificationAllowedError) and the sentence stops being highlighted for
  // the rest of the session. Watch for those mutations and re-locate the
  // current sentence instead.

  let currentSentenceIndex = -1;
  let currentSentenceText = '';
  let mutationObserver = null;
  let mutationTimer = null;

  /**
   * Find a range for `text` anywhere in the document.
   * @param {string} text Sentence text to locate
   * @returns {Range|null}
   */
  function locateTextInDocument(text) {
    if (!text || !document.body) return null;
    const needle = (typeof text === 'string' ? text : '').trim();
    if (needle.length < 4) return null;

    // The sentence text is whitespace-collapsed (see
    // ReadAloudTokenizer.normalizeWhitespace) while the page's text nodes keep
    // their own line breaks and double spaces. Matching the raw substring
    // therefore failed on every hard-wrapped paragraph, and the highlight was
    // lost after the first DOM mutation. Match whitespace-insensitively
    // against the same canonical text the tokenizer produced.
    const { normText, normToRaw, nodes } = buildTextIndex(document.body);
    if (!normText) return null;

    let foundIndex = normText.indexOf(needle);
    let matchedLength = needle.length;

    if (foundIndex === -1) {
      const pattern = needle
        .split(/\s+/)
        .filter(Boolean)
        .map(escapeRegExp)
        .join('\\s+');
      try {
        const re = new RegExp(pattern);
        const match = re.exec(normText);
        if (match) {
          foundIndex = match.index;
          matchedLength = match[0].length;
        }
      } catch (_) {
        return null;
      }
    }

    if (foundIndex === -1) return null;

    const lastNorm = Math.min(foundIndex + matchedLength, normToRaw.length) - 1;
    if (lastNorm < foundIndex) return null;

    const rawStart = normToRaw[foundIndex];
    const rawEnd = normToRaw[lastNorm] + 1;

    const startNodeInfo = nodes.find(nd => rawStart >= nd.start && rawStart < nd.end);
    const endNodeInfo = nodes.find(nd => rawEnd > nd.start && rawEnd <= nd.end);
    if (!startNodeInfo || !endNodeInfo) return null;

    try {
      const range = document.createRange();
      range.setStart(startNodeInfo.node, rawStart - startNodeInfo.start);
      range.setEnd(endNodeInfo.node, rawEnd - endNodeInfo.start);
      return range;
    } catch (_) { /* node detached mid-walk — give up */ }
    return null;
  }

  /**
   * Re-anchor the current sentence's range after the DOM changed under it.
   * @returns {boolean} true when the sentence was found again
   */
  function remapCurrentSentence() {
    if (currentSentenceIndex < 0) return false;
    const text = (currentSentenceText || '').trim();
    if (!text) return false;

    const range = locateTextInDocument(text);
    if (!range) return false;

    const existing = currentSentenceRanges[currentSentenceIndex];
    currentSentenceRanges[currentSentenceIndex] = {
      index: currentSentenceIndex,
      text,
      range,
      element: existing ? existing.element : undefined
    };
    return true;
  }

  let mutationRequiresRemap = false;

  /** Called (throttled) after a mutation that can invalidate the active range. */
  function handleDomMutation(forceRemap = false) {
    if (currentSentenceIndex < 0) return;
    const item = currentSentenceRanges[currentSentenceIndex];
    const startNode = item && item.range ? item.range.startContainer : null;
    const endNode = item && item.range ? item.range.endContainer : null;

    // Still attached and untouched? The live Range remains valid.
    if (!forceRemap && startNode && endNode &&
        document.contains(startNode) && document.contains(endNode)) return;

    if (remapCurrentSentence()) {
      applyHighlight(currentSentenceIndex);
    } else {
      // The sentence is genuinely gone — drop the highlight rather than
      // pointing it at the wrong text.
      clearHighlight();
    }
  }

  function scheduleMutationCheck(records) {
    if (currentSentenceIndex < 0) return;

    const item = currentSentenceRanges[currentSentenceIndex];
    const range = item && item.range;
    const startNode = range ? range.startContainer : null;
    const endNode = range ? range.endContainer : null;
    const endpointsAttached = Boolean(
      startNode && endNode &&
      document.contains(startNode) && document.contains(endNode)
    );
    // A live DOM Range may be auto-adjusted to an attached ancestor when its
    // original text node is removed. In that case endpoint connectivity alone
    // lies: the element used to build this sentence range is the reliable
    // ownership anchor and remains detached after a framework replacement.
    const ownerElement = item && item.element ? item.element : null;
    const ownerDetached = Boolean(ownerElement && !document.contains(ownerElement));
    const activeSentenceText = (currentSentenceText || '').replace(/\s+/g, ' ').trim();
    // Some extractors anchor every sentence to a broad article container.
    // Detect removal of a descendant block containing the active sentence as
    // well, because the browser may move Range endpoints to the still-attached
    // article element before MutationObserver runs.
    const activeSentenceRemoved = Boolean(
      activeSentenceText &&
      Array.isArray(records) &&
      records.some(record => {
        if (record.type !== 'childList') return false;
        return Array.from(record.removedNodes || []).some(node => {
          const removedText = typeof node.textContent === 'string'
            ? node.textContent.replace(/\s+/g, ' ').trim()
            : '';
          return removedText.includes(activeSentenceText);
        });
      })
    );

    // Ignore unrelated page churn. A detached endpoint or a removed owner /
    // active sentence needs re-anchoring; changed text inside the range needs
    // a fresh lookup so the highlight cannot drift to stale offsets.
    let textChangedInsideRange = false;
    if (endpointsAttached && range && Array.isArray(records)) {
      for (const record of records) {
        if (record.type !== 'characterData') continue;
        try {
          if (range.intersectsNode(record.target)) {
            textChangedInsideRange = true;
            break;
          }
        } catch (_) {
          // A node may be detached between the observer callback and this test.
        }
      }
    }

    if (endpointsAttached && !ownerDetached && !activeSentenceRemoved && !textChangedInsideRange) return;
    mutationRequiresRemap = mutationRequiresRemap || ownerDetached ||
      activeSentenceRemoved || textChangedInsideRange;

    // Throttle, don't debounce: a page that mutates constantly must still get
    // its repair pass instead of postponing it forever.
    if (mutationTimer) return;
    mutationTimer = setTimeout(() => {
      mutationTimer = null;
      const forceRemap = mutationRequiresRemap;
      mutationRequiresRemap = false;
      handleDomMutation(forceRemap);
    }, 800);
  }

  /** Start watching for DOM mutations (only while a queue is live). */
  function startMutationObserver() {
    if (mutationObserver || !document.body) return;
    try {
      mutationObserver = new MutationObserver(scheduleMutationCheck);
      mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });
    } catch (_) {
      mutationObserver = null;
    }
  }

  /** Stop watching and release the observer. */
  function stopMutationObserver() {
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    if (mutationTimer) {
      clearTimeout(mutationTimer);
      mutationTimer = null;
    }
    mutationRequiresRemap = false;
  }

  // -----------------------------------------------------------------
  // 3c. Website Zoom Counter-Scaling
  // -----------------------------------------------------------------
  //
  // The pill is drawn inside the page, so browser page zoom (Ctrl +/-) makes
  // it bigger. To keep it the same physical size we counter-scale it with
  // `transform: scale(1 / pageZoom)`.
  //
  // Finding the page zoom took some measuring (Chrome 156, desktop):
  //
  //   svg.currentScale        -> always 1, does NOT follow page zoom
  //   visualViewport.scale    -> always 1, does NOT follow page zoom
  //   window.devicePixelRatio -> DOES follow it (devicePixelRatio =
  //                               displayScale x pageZoom)
  //
  // devicePixelRatio alone cannot separate the page zoom from the operating
  // system's display scaling, so the background asks Chrome for the tab's real
  // zoom factor (chrome.tabs.getZoom — no extra permission required). From
  // that and the devicePixelRatio we derive the display scale once, and from
  // then on the page can follow zoom changes on its own.
  let displayScale = 1;       // operating system display scaling
  let zoomKnown = false;     // has the background answered yet?

  function currentPageZoom() {
    if (!zoomKnown) return 1;
    const dpr = (typeof window.devicePixelRatio === 'number' && window.devicePixelRatio > 0)
      ? window.devicePixelRatio
      : 1;
    const zoom = dpr / (displayScale || 1);
    return (typeof zoom === 'number' && isFinite(zoom) && zoom > 0) ? zoom : 1;
  }

  let lastAppliedZoom = null;

  function updateZoomCompensation() {
    const zoom = currentPageZoom();
    if (zoom === lastAppliedZoom) return;
    lastAppliedZoom = zoom;
    if (typeof host !== 'undefined' && host) {
      host.style.setProperty('--ra-page-zoom', String(zoom));
    }
  }

  function initZoomTracking() {
    safeSendMessage({ action: 'GET_PAGE_ZOOM' }, (res) => {
      if (res && res.success && res.data && typeof res.data.zoom === 'number' && res.data.zoom > 0) {
        // displayScale = devicePixelRatio / pageZoom
        const dpr = (typeof window.devicePixelRatio === 'number' && window.devicePixelRatio > 0)
          ? window.devicePixelRatio
          : 1;
        displayScale = dpr / res.data.zoom;
      } else {
        // No answer from the background: fall back to a 100% display scale,
        // which is exact on a standard-DPI screen.
        displayScale = (typeof window.devicePixelRatio === 'number' && window.devicePixelRatio > 0)
          ? window.devicePixelRatio
          : 1;
      }
      zoomKnown = true;
      updateZoomCompensation();
    });
  }

  // Browser zoom normally emits resize; resolution media queries also
  // catch device-pixel-ratio changes when moving the window between displays.
  let zoomMediaQuery = null;
  let zoomMediaQueryHandler = null;

  function removeZoomMediaQueryListener() {
    if (zoomMediaQuery && zoomMediaQueryHandler) {
      if (typeof zoomMediaQuery.removeEventListener === 'function') {
        zoomMediaQuery.removeEventListener('change', zoomMediaQueryHandler);
      } else if (typeof zoomMediaQuery.removeListener === 'function') {
        zoomMediaQuery.removeListener(zoomMediaQueryHandler);
      }
    }
    zoomMediaQuery = null;
    zoomMediaQueryHandler = null;
  }

  function watchDevicePixelRatioChanges() {
    removeZoomMediaQueryListener();
    if (typeof window.matchMedia !== 'function') return;

    const dpr = (typeof window.devicePixelRatio === 'number' && window.devicePixelRatio > 0)
      ? window.devicePixelRatio
      : 1;
    try {
      const query = window.matchMedia(`(resolution: ${dpr}dppx)`);
      const onChange = () => {
        // Re-arm for the new DPR and ask Chrome for the actual tab zoom again.
        // This keeps OS display scaling separate from browser page zoom.
        watchDevicePixelRatioChanges();
        initZoomTracking();
      };
      if (typeof query.addEventListener === 'function') {
        query.addEventListener('change', onChange);
      } else if (typeof query.addListener === 'function') {
        query.addListener(onChange);
      } else {
        return;
      }
      zoomMediaQuery = query;
      zoomMediaQueryHandler = onChange;
    } catch (_) {
      zoomMediaQuery = null;
      zoomMediaQueryHandler = null;
    }
  }

  function stopZoomTracking() {
    window.removeEventListener('resize', updateZoomCompensation);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', updateZoomCompensation);
    }
    removeZoomMediaQueryListener();
  }

  window.addEventListener('resize', updateZoomCompensation);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateZoomCompensation);
  }
  watchDevicePixelRatioChanges();

  // -----------------------------------------------------------------
  // 4. Create Host Element & Shadow DOM Player UI
  // -----------------------------------------------------------------
  const host = document.createElement('div');
  host.id = 'read-aloud-player-host';
  document.documentElement.appendChild(host);
  updateZoomCompensation();
  // Ask the background for the tab's real zoom factor so the counter-scale
  // also works on a display that is not at 100% scaling.
  initZoomTracking();

  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: var(--ra-font, ui-monospace, 'SF Mono', 'Cascadia Mono', Consolas, monospace);
      font-variant-numeric: tabular-nums;
      user-select: none;
    }

    :host {
      all: initial;
      --pill-scale: 1;
      --ra-page-zoom: 1;
      --pill-opacity: 0.96;
      --ra-bg:        #0F0F0F;
      --ra-surface:   #181818;
      --ra-border:    #2A2A2A;
      --ra-line:      #000000;
      --ra-text:      #F0F0F0;
      --ra-muted:     #8A8A8A;  /* boosted from #737373 for WCAG AA contrast */
      --ra-accent:    #FF5C00;
      --ra-accent-hover: #E65300;
      --ra-accent-dim: rgba(255, 92, 0, 0.16);
      --ra-led-green: #00FF66;
      --ra-font:      ui-monospace, 'SF Mono', 'Cascadia Mono', Consolas, 'Liberation Mono', Menlo, monospace;
      --ra-progress-pct: 0%;
    }

    :host(.theme-light), :host(.light) {
      --ra-bg:        #F5F4F0;
      --ra-surface:   #ECEAE4;
      --ra-border:    #D0CEC8;
      --ra-line:      #000000;
      --ra-text:      #1A1A1A;
      --ra-muted:     #686862;  /* boosted from #888880 for WCAG AA contrast on light bg */
      --ra-accent:    #FF5C00;
      --ra-accent-hover: #E65300;
      --ra-accent-dim: rgba(255, 92, 0, 0.16);
    }

    :host(.theme-te-field) {
      --ra-bg:        #141414;
      --ra-surface:   #1E1E1E;
      --ra-border:    #333333;
      --ra-line:      #000000;
      --ra-text:      #F5F5F5;
      --ra-muted:     #8A8A8A;
      --ra-accent:    #FF5C00;
      --ra-accent-hover: #E65300;
      --ra-accent-dim: rgba(255, 92, 0, 0.16);
    }

    /* ── Modern Frosted Glass Floating Player Pill ─────────── */
    .player-pill {
      position: fixed;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 4px 8px;
      background: rgba(20, 20, 22, 0.88);
      backdrop-filter: blur(20px) saturate(160%);
      -webkit-backdrop-filter: blur(20px) saturate(160%);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 12px;
      box-shadow:
        0 10px 32px -4px rgba(0, 0, 0, 0.65),
        0 2px 8px rgba(0, 0, 0, 0.4),
        inset 0 1px 0 rgba(255, 255, 255, 0.15);
      color: var(--ra-text);
      font-family: var(--ra-font);
      bottom: 24px;
      right: 24px;
      transform: scale(calc(var(--pill-scale, 1) / var(--ra-page-zoom, 1)));
      transform-origin: bottom right;
      opacity: var(--pill-opacity);
      overflow: hidden;
      transition:
        transform 0.22s cubic-bezier(0.16, 1, 0.3, 1),
        box-shadow 0.2s ease,
        opacity 0.2s ease,
        border-color 0.2s ease;
    }

    .player-pill:hover {
      box-shadow:
        0 14px 42px -4px rgba(0, 0, 0, 0.75),
        0 0 18px var(--ra-accent-dim),
        inset 0 1px 0 rgba(255, 255, 255, 0.22);
      border-color: rgba(255, 255, 255, 0.24);
      opacity: 1 !important;
    }

    :host(.theme-light) .player-pill {
      background: rgba(248, 247, 244, 0.92);
      border: 1px solid rgba(0, 0, 0, 0.12);
      box-shadow:
        0 10px 32px -4px rgba(0, 0, 0, 0.18),
        0 2px 8px rgba(0, 0, 0, 0.08),
        inset 0 1px 0 rgba(255, 255, 255, 0.95);
    }

    /* ── Magnetic Edge Docking Styles ── */
    .player-pill.is-docked-right {
      border-top-right-radius: 0 !important;
      border-bottom-right-radius: 0 !important;
      border-right: none !important;
      box-shadow: -2.5px 2.5px 0 rgba(0, 0, 0, 0.75) !important;
      transition: transform 260ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 120ms ease, opacity 120ms ease, background 120ms ease !important;
    }

    .player-pill.is-docked-left {
      border-top-left-radius: 0 !important;
      border-bottom-left-radius: 0 !important;
      border-left: none !important;
      box-shadow: 2.5px 2.5px 0 rgba(0, 0, 0, 0.75) !important;
      transition: transform 260ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 120ms ease, opacity 120ms ease, background 120ms ease !important;
    }

    /* Magnetic Snap Guide while dragging near edge */
    .player-pill.snap-guide-left {
      box-shadow: 0 0 16px rgba(255, 92, 0, 0.95), 2.5px 2.5px 0 #000000 !important;
      border-color: var(--ra-accent) !important;
      transition: none !important;
    }

    .player-pill.snap-guide-right {
      box-shadow: 0 0 16px rgba(255, 92, 0, 0.95), -2.5px 2.5px 0 #000000 !important;
      border-color: var(--ra-accent) !important;
      transition: none !important;
    }

    /* Tucked tab on right edge: slides partially into the screen border */
    .player-pill.is-docked-right.is-tucked:not(:hover) {
      transform: scale(calc(var(--pill-scale, 1) / var(--ra-page-zoom, 1))) translateX(calc(100% - 36px)) !important;
      opacity: 0.85 !important;
      cursor: pointer;
    }

    /* Tucked tab on left edge: slides partially into the screen border */
    .player-pill.is-docked-left.is-tucked:not(:hover) {
      transform: scale(calc(var(--pill-scale, 1) / var(--ra-page-zoom, 1))) translateX(calc(-100% + 36px)) !important;
      opacity: 0.85 !important;
      cursor: pointer;
    }

    /* Hover or active expansion: spring out completely */
    .player-pill.is-docked-right:hover,
    .player-pill.is-docked-left:hover {
      transform: scale(calc(var(--pill-scale, 1) / var(--ra-page-zoom, 1))) translateX(0) !important;
      opacity: 1 !important;
    }

    /* ── Magnetic Edge-Docking 24px Bead Mode ── */
    .player-pill.beaded {
      width: 24px !important;
      min-width: 24px !important;
      max-width: 24px !important;
      height: 38px !important;
      padding: 0 !important;
      overflow: hidden !important;
      border-radius: 12px !important;
      cursor: pointer !important;
      background: var(--ra-panel-bg, #1A1A1A) !important;
      border: 1.5px solid var(--ra-accent) !important;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4), 0 0 10px rgba(255, 92, 0, 0.4) !important;
      transition: width 240ms cubic-bezier(0.16, 1, 0.3, 1),
                  max-width 240ms cubic-bezier(0.16, 1, 0.3, 1),
                  padding 200ms ease,
                  box-shadow 200ms ease,
                  transform 240ms cubic-bezier(0.16, 1, 0.3, 1) !important;
    }
    .player-pill.beaded.is-docked-left {
      border-top-left-radius: 0 !important;
      border-bottom-left-radius: 0 !important;
      border-left: none !important;
      transform: none !important;
    }
    .player-pill.beaded.is-docked-right {
      border-top-right-radius: 0 !important;
      border-bottom-right-radius: 0 !important;
      border-right: none !important;
      transform: none !important;
    }
    .player-pill.beaded .pill-body,
    .player-pill.beaded .info-label,
    .player-pill.beaded .progress-pill,
    .player-pill.beaded .progress-track,
    .player-pill.beaded .speed-badge,
    .player-pill.beaded .drag-handle,
    .player-pill.beaded .ra-brand {
      display: none !important;
      opacity: 0 !important;
      pointer-events: none !important;
    }
    .player-pill.beaded .edge-chevron {
      display: flex !important;
      align-items: center;
      justify-content: center;
      width: 100% !important;
      height: 100% !important;
      font-size: 16px;
      font-weight: 700;
      color: var(--ra-accent);
      user-select: none;
    }
    .player-pill.beaded:hover {
      width: auto !important;
      min-width: 260px !important;
      max-width: none !important;
      padding: 6px 10px !important;
      overflow: visible !important;
      border-radius: 20px !important;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45) !important;
    }
    .player-pill.beaded:hover .pill-body,
    .player-pill.beaded:hover .progress-track {
      display: flex !important;
      opacity: 1 !important;
      pointer-events: auto !important;
    }
    .player-pill.beaded:hover .edge-chevron {
      display: none !important;
    }

    /* Interactive Seekable Progress Bar Track on bottom edge */
    .progress-track {
      position: absolute;
      bottom: 0;
      left: 0;
      width: 100%;
      height: 3px;
      background: rgba(0, 0, 0, 0.5);
      cursor: pointer;
      z-index: 15;
      transition: height 120ms ease;
    }
    .player-pill:hover .progress-track,
    .progress-track:hover {
      height: 6px;
    }
    .progress-fill {
      height: 100%;
      width: var(--ra-progress-pct, 0%);
      background: var(--ra-accent);
      pointer-events: none;
      transition: width 0.15s ease-out;
    }

    /* ── Resume Reading Notification Toast ─────────────── */
    .resume-toast {
      position: fixed;
      z-index: 2147483646;
      display: none;
      align-items: center;
      gap: 8px;
      padding: 5px 10px;
      background: var(--ra-bg);
      border: 1.5px solid var(--ra-accent);
      border-radius: 4px;
      box-shadow: 2.5px 2.5px 0 rgba(0, 0, 0, 0.75);
      color: var(--ra-text);
      font-size: 11px;
      font-family: var(--ra-font);
      bottom: 70px;
      right: 24px;
    }
    .resume-toast.visible {
      display: flex;
    }
    .resume-act-btn {
      background: var(--ra-accent);
      color: #000000;
      border: 1px solid var(--ra-line);
      border-radius: 2px;
      padding: 2px 7px;
      font-size: 10px;
      font-weight: 700;
      cursor: pointer;
      font-family: var(--ra-font);
    }
    .resume-act-btn:hover {
      background: var(--ra-accent-hover);
    }
    .resume-close-btn {
      background: transparent;
      color: var(--ra-muted);
      border: none;
      cursor: pointer;
      font-size: 12px;
      padding: 0 3px;
      line-height: 1;
      font-family: var(--ra-font);
    }
    .resume-close-btn:hover {
      color: var(--ra-text);
    }

    /* Knurled grip edge like a machined dial skirt */
    .player-pill::before {
      content: '';
      width: 3px;
      align-self: stretch;
      margin: 2px 2px 2px 0;
      background: repeating-linear-gradient(180deg, var(--ra-line) 0 1px, transparent 1px 3px);
      opacity: 0.5;
      border-radius: 1px;
      flex-shrink: 0;
    }

    /* Idle Dimming during active reading */
    .player-pill.is-playing:not(:hover) {
      opacity: calc(var(--pill-opacity) * 0.65) !important;
    }

    /* Compact Mode (Default): hides bulky info label and stop button */
    .player-pill.pill-compact .info-label,
    .player-pill.pill-compact .progress-pill,
    .player-pill.pill-compact #ra-stop {
      display: none !important;
    }

    /* Mini Mode: ultra-compact hardware block */
    .player-pill.pill-mini {
      padding: 3px;
      border-radius: 4px;
      overflow: hidden;
      width: 48px;
      height: 34px;
      justify-content: center;
    }
    .player-pill.pill-mini:not(:hover) .drag-handle,
    .player-pill.pill-mini:not(:hover) #ra-prev,
    .player-pill.pill-mini:not(:hover) #ra-next,
    .player-pill.pill-mini:not(:hover) #ra-stop,
    .player-pill.pill-mini:not(:hover) #ra-speed,
    .player-pill.pill-mini:not(:hover) #ra-settings,
    .player-pill.pill-mini:not(:hover) #ra-collapse,
    .player-pill.pill-mini:not(:hover) .ra-brand,
    .player-pill.pill-mini:not(:hover) .info-label,
    .player-pill.pill-mini:not(:hover) .progress-pill,
    .player-pill.pill-mini:not(:hover)::before {
      display: none !important;
    }
    .player-pill.pill-mini:hover {
      width: auto;
      height: auto;
      padding: 4px 7px;
    }

    /* ── Samsung Galaxy S26 Ultra Edge Handle (Collapsed State) ── */
    .player-pill.collapsed {
      padding: 0 !important;
      width: 6px !important;
      min-width: 6px !important;
      max-width: 6px !important;
      height: 72px !important;
      border-radius: 6px 0 0 6px !important;
      border: 1px solid rgba(255, 255, 255, 0.22) !important;
      border-right: none !important;
      background: rgba(20, 20, 20, 0.88) !important;
      backdrop-filter: blur(10px) !important;
      -webkit-backdrop-filter: blur(10px) !important;
      box-shadow: -2px 0 10px rgba(0, 0, 0, 0.6) !important;
      display: flex !important;
      flex-direction: column !important;
      align-items: center !important;
      justify-content: center !important;
      cursor: pointer !important;
      gap: 0 !important;
      overflow: hidden !important;
      transform-origin: center right !important;
      transition: width 160ms cubic-bezier(0.16, 1, 0.3, 1), background 160ms ease, box-shadow 160ms ease !important;
    }

    .player-pill.collapsed.dock-left {
      border-radius: 0 6px 6px 0 !important;
      border-left: none !important;
      border-right: 1px solid rgba(255, 255, 255, 0.22) !important;
      box-shadow: 2px 0 10px rgba(0, 0, 0, 0.6) !important;
      transform-origin: center left !important;
    }

    .player-pill.collapsed:hover {
      width: 18px !important;
      min-width: 18px !important;
      max-width: 18px !important;
      background: rgba(28, 28, 28, 0.96) !important;
      box-shadow: -3px 0 14px rgba(0, 0, 0, 0.75), 0 0 10px rgba(255, 92, 0, 0.45) !important;
    }

    .player-pill.collapsed::before {
      display: none !important;
    }

    .player-pill.collapsed .pill-body,
    .player-pill.collapsed .drag-handle,
    .player-pill.collapsed .progress-track,
    .player-pill.collapsed #ra-collapse {
      display: none !important;
    }

    .player-pill.collapsed .ra-led {
      display: block !important;
      width: 3px !important;
      height: 38px !important;
      border-radius: 2px !important;
      margin: 0 !important;
      border: none !important;
      background: var(--ra-accent) !important;
      box-shadow: 0 0 6px var(--ra-accent) !important;
      transition: height 160ms ease, opacity 160ms ease !important;
    }

    .player-pill.collapsed:hover .ra-led {
      height: 22px !important;
      width: 3.5px !important;
    }

    .edge-chevron {
      display: none;
      font-size: 11px;
      font-weight: 700;
      color: var(--ra-accent);
      line-height: 1;
      margin-top: 3px;
      user-select: none;
      pointer-events: none;
    }

    .player-pill.collapsed:hover .edge-chevron {
      display: block !important;
    }

    .pill-body {
      display: flex;
      align-items: center;
      gap: 3px;
    }

    .drag-handle {
      cursor: grab;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1px 2px;
      color: var(--ra-muted);
      border-radius: 2px;
      transition: color 80ms;
    }
    .drag-handle:hover { color: var(--ra-text); }
    .drag-handle:active { cursor: grabbing; }

    /* Status LED */
    .ra-led {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #444444;
      border: 1px solid var(--ra-line);
      margin: 0 2px;
      flex-shrink: 0;
    }
    .player-pill.is-playing .ra-led {
      background: var(--ra-accent);
      border-color: var(--ra-line);
      box-shadow: 0 0 6px rgba(255, 92, 0, 0.85);
      animation: te-led-pulse 1.4s ease-in-out infinite;
    }
    @keyframes te-led-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.35; }
    }

    /* Fluid tactile glassmorphic icon buttons */
    button.icon-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--ra-text);
      width: 28px;
      height: 28px;
      border-radius: 7px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: transform 0.14s cubic-bezier(0.16, 1, 0.3, 1), background 0.14s ease, color 0.14s ease;
      outline: none;
      padding: 0;
      font-family: var(--ra-font);
    }
    button.icon-btn:hover {
      background: rgba(255, 255, 255, 0.12);
      transform: scale(1.08);
      border-color: rgba(255, 255, 255, 0.16);
    }
    button.icon-btn:active {
      transform: scale(0.92);
      background: rgba(255, 255, 255, 0.18);
    }
    :host(.theme-light) button.icon-btn:hover {
      background: rgba(0, 0, 0, 0.08);
      border-color: rgba(0, 0, 0, 0.12);
    }

    /* Play Key: Signature glowing action key */
    button.play-btn {
      background: linear-gradient(135deg, #FF7A00 0%, #FF5C00 100%);
      color: #000000;
      border: 1px solid rgba(255, 255, 255, 0.22);
      border-radius: 8px;
      width: 30px;
      height: 30px;
      box-shadow: 0 2px 10px rgba(255, 92, 0, 0.4);
      transition: transform 0.16s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.2s ease, background 0.2s ease;
    }
    button.play-btn:hover {
      background: linear-gradient(135deg, #FF8C1A 0%, #E65300 100%);
      box-shadow: 0 4px 16px rgba(255, 92, 0, 0.6);
      transform: scale(1.12);
    }
    button.play-btn:active {
      transform: scale(0.92);
      box-shadow: 0 1px 4px rgba(255, 92, 0, 0.3);
    }

    /* Modern Speed Badge */
    .speed-badge {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: var(--ra-accent);
      font-size: 11px;
      font-weight: 700;
      border-radius: 6px;
      padding: 2px 6px;
      letter-spacing: 0.03em;
      cursor: pointer;
      min-width: 32px;
      text-align: center;
      transition: transform 0.14s ease, background 0.14s ease, border-color 0.14s ease;
    }
    .speed-badge:hover {
      transform: scale(1.08);
      background: rgba(255, 255, 255, 0.16);
      border-color: var(--ra-accent);
      color: #ffffff;
    }
    .speed-badge:active {
      transform: scale(0.94);
    }

    .progress-pill {
      background: #000000;
      border: 1px solid var(--ra-line);
      color: #ffffff;
      font-size: 9px;
      font-weight: 700;
      border-radius: 2px;
      padding: 1px 5px;
      letter-spacing: 0.05em;
    }

    .ra-brand {
      font-size: 8px;
      font-weight: 700;
      letter-spacing: 0.16em;
      color: var(--ra-muted);
      padding: 0 2px;
      text-transform: uppercase;
    }

    .info-label {
      font-size: 9px;
      color: var(--ra-muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      padding: 0 3px;
      max-width: 75px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    svg {
      width: 14px;
      height: 14px;
      fill: currentColor;
    }
    .play-btn svg {
      width: 15px;
      height: 15px;
      fill: #000000;
    }

    /* ── Settings Panel (Modern Frosted Glass Card) ─────────────── */
    .settings-panel {
      position: fixed;
      z-index: 2147483646;
      width: 290px;
      max-height: calc(100vh - 32px);
      overflow-y: auto;
      background: rgba(18, 18, 20, 0.94);
      backdrop-filter: blur(24px) saturate(180%);
      -webkit-backdrop-filter: blur(24px) saturate(180%);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 14px;
      box-shadow:
        0 20px 50px -8px rgba(0, 0, 0, 0.75),
        0 4px 16px rgba(0, 0, 0, 0.4),
        inset 0 1px 0 rgba(255, 255, 255, 0.16);
      color: var(--ra-text);
      padding: 16px;
      opacity: 0;
      transform: scale(calc(1 / var(--ra-page-zoom, 1))) translateY(8px);
      transform-origin: bottom right;
      pointer-events: none;
      transition:
        opacity 0.18s cubic-bezier(0.16, 1, 0.3, 1),
        transform 0.18s cubic-bezier(0.16, 1, 0.3, 1);
      font-size: 12px;
      font-family: var(--ra-font);
    }
    .settings-panel::-webkit-scrollbar {
      width: 4px;
    }
    .settings-panel::-webkit-scrollbar-track {
      background: transparent;
    }
    .settings-panel::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.2);
      border-radius: 4px;
    }
    .settings-panel.open {
      opacity: 1;
      transform: scale(calc(1 / var(--ra-page-zoom, 1))) translateY(0);
      pointer-events: all;
    }
    :host(.theme-light) .settings-panel {
      background: rgba(248, 247, 244, 0.96);
      border: 1px solid rgba(0, 0, 0, 0.12);
      box-shadow:
        0 20px 50px -8px rgba(0, 0, 0, 0.18),
        0 4px 16px rgba(0, 0, 0, 0.08),
        inset 0 1px 0 rgba(255, 255, 255, 0.95);
    }

    .settings-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .settings-title {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--ra-text);
    }
    button.settings-close {
      background: transparent;
      border: 1px solid transparent;
      color: var(--ra-muted);
      width: 24px;
      height: 24px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 0;
      transition: all 0.12s ease;
    }
    button.settings-close:hover {
      background: rgba(255, 255, 255, 0.1);
      color: var(--ra-text);
      transform: scale(1.08);
    }

    .settings-section {
      margin-bottom: 10px;
    }
    .settings-label {
      display: block;
      font-size: 9px;
      font-weight: 700;
      color: var(--ra-muted);
      text-transform: uppercase;
      letter-spacing: 0.12em;
      margin-bottom: 5px;
    }

    .settings-action-btn {
      flex: 1;
      padding: 7px 10px;
      background: rgba(255, 255, 255, 0.07);
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: var(--ra-text);
      border-radius: 8px;
      font-size: 10px;
      font-weight: 700;
      cursor: pointer;
      font-family: var(--ra-font);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.14s ease;
    }
    .settings-action-btn:hover {
      background: rgba(255, 255, 255, 0.13);
      border-color: rgba(255, 255, 255, 0.24);
      transform: translateY(-1px);
    }
    .settings-action-btn.stop-action-btn {
      color: #FF5C00;
      border-color: rgba(255, 92, 0, 0.3);
    }
    .settings-action-btn.stop-action-btn:hover {
      background: rgba(255, 92, 0, 0.15);
      border-color: #FF5C00;
    }

    .settings-select {
      width: 100%;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 8px;
      color: var(--ra-text);
      padding: 7px 28px 7px 10px;
      font-size: 11px;
      font-family: var(--ra-font);
      outline: none;
      cursor: pointer;
      appearance: none;
      -webkit-appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='%238A8A8A'%3E%3Cpath d='M7 10l5 5 5-5z'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 8px center;
      transition: border-color 0.14s ease, background-color 0.14s ease;
    }
    .settings-select:hover, .settings-select:focus {
      border-color: var(--ra-accent);
      background-color: rgba(255, 255, 255, 0.09);
    }
    .settings-select option {
      background: #18181a;
      color: var(--ra-text);
    }
    .voice-status {
      font-size: 9px;
      color: var(--ra-muted);
      margin-top: 4px;
      letter-spacing: 0.04em;
      line-height: 1.3;
    }
    .voice-status.ok { color: var(--ra-led-green); }
    .voice-status.warn { color: var(--ra-accent); }

    .speed-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .speed-min-max {
      font-size: 9px;
      color: var(--ra-muted);
      flex-shrink: 0;
    }
    .speed-range {
      flex: 1;
      appearance: none;
      -webkit-appearance: none;
      height: 4px;
      background: rgba(255, 255, 255, 0.14);
      border-radius: 2px;
      outline: none;
      cursor: pointer;
    }
    .speed-range::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--ra-accent);
      border: 1.5px solid #ffffff;
      cursor: pointer;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
      transition: transform 0.1s ease;
    }
    .speed-range::-webkit-slider-thumb:hover {
      transform: scale(1.2);
    }
    .speed-display {
      font-size: 11px;
      font-weight: 700;
      color: var(--ra-accent);
      min-width: 32px;
      text-align: right;
      flex-shrink: 0;
      padding: 1px 4px;
      border-radius: 4px;
    }

    .theme-row {
      display: flex;
      gap: 5px;
    }
    button.theme-btn {
      padding: 5px 12px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.06);
      color: var(--ra-muted);
      font-size: 9px;
      font-weight: 700;
      font-family: var(--ra-font);
      cursor: pointer;
      transition: all 0.14s ease;
      text-align: center;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    button.theme-btn.active {
      background: var(--ra-accent);
      border-color: var(--ra-accent);
      color: #000000;
      box-shadow: 0 0 10px var(--ra-accent-dim);
    }
    button.theme-btn:hover:not(.active) {
      border-color: rgba(255, 255, 255, 0.25);
      color: var(--ra-text);
      background: rgba(255, 255, 255, 0.1);
    }
    .settings-divider {
      border: none;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      margin: 9px 0;
    }
    :host(.theme-light) .settings-divider {
      border-top-color: rgba(0, 0, 0, 0.08);
    }

    button.color-swatch {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      border: 2px solid transparent;
      cursor: pointer;
      padding: 0;
      transition: transform 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease;
    }
    button.color-swatch:hover {
      transform: scale(1.15);
    }
    button.color-swatch.active {
      border-color: #ffffff;
      box-shadow: 0 0 0 2px var(--ra-bg), 0 0 0 3.5px var(--ra-accent);
      transform: scale(1.1);
    }

    /* Modern Sliding Toggle Switch */
    .ra-toggle-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 5px 0;
      cursor: pointer;
    }
    .ra-toggle-label {
      font-size: 11px;
      font-weight: 500;
      color: var(--ra-text);
      letter-spacing: 0.02em;
      cursor: pointer;
      user-select: none;
    }
    .ra-switch {
      position: relative;
      display: inline-block;
      width: 32px;
      height: 18px;
      flex-shrink: 0;
    }
    .ra-switch input {
      opacity: 0;
      width: 0;
      height: 0;
      position: absolute;
    }
    .ra-switch-slider {
      position: absolute;
      cursor: pointer;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(255, 255, 255, 0.16);
      transition: 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      border-radius: 20px;
    }
    .ra-switch-slider:before {
      position: absolute;
      content: "";
      height: 12px;
      width: 12px;
      left: 3px;
      bottom: 3px;
      background-color: #ffffff;
      transition: 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      border-radius: 50%;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
    }
    .ra-switch input:checked + .ra-switch-slider {
      background: var(--ra-accent);
      box-shadow: 0 0 10px var(--ra-accent-dim);
    }
    .ra-switch input:checked + .ra-switch-slider:before {
      transform: translateX(14px);
    }

    /* ── Speechify-Style Selection Listen Floating Capsule ── */
    .selection-play-btn {
      position: fixed;
      z-index: 2147483645;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 28px;
      padding: 0 12px;
      background: linear-gradient(135deg, #FF7A00 0%, #FF5C00 100%);
      color: #000000;
      border: 1px solid rgba(255, 255, 255, 0.25);
      border-radius: 20px;
      box-shadow: 0 4px 14px rgba(255, 92, 0, 0.4), 0 1px 3px rgba(0, 0, 0, 0.3);
      font-family: var(--ra-font);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.04em;
      cursor: pointer;
      opacity: 0;
      pointer-events: none;
      transform: translateY(6px) scale(0.92);
      transition:
        opacity 0.16s cubic-bezier(0.16, 1, 0.3, 1),
        transform 0.16s cubic-bezier(0.16, 1, 0.3, 1),
        box-shadow 0.16s ease;
      outline: none;
      user-select: none;
    }
    .selection-play-btn.visible {
      opacity: 1;
      pointer-events: all;
      transform: translateY(0) scale(1);
    }
    .selection-play-btn:hover {
      background: linear-gradient(135deg, #FF8C1A 0%, #E65300 100%);
      box-shadow: 0 6px 20px rgba(255, 92, 0, 0.55), 0 2px 6px rgba(0, 0, 0, 0.3);
      transform: translateY(-1px) scale(1.05);
    }
    .selection-play-btn:active {
      transform: scale(0.95);
      box-shadow: 0 2px 8px rgba(255, 92, 0, 0.3);
    }
    .selection-play-btn svg {
      width: 12px;
      height: 12px;
      fill: #000000;
    }

    /* ── Paragraph Gutter Play Button (Stationary, Calm) ── */
    .hover-play-btn {
      position: fixed;
      z-index: 2147483645;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: linear-gradient(135deg, #FF7A00 0%, #FF5C00 100%);
      color: #000000;
      border: 1px solid rgba(255, 255, 255, 0.25);
      box-shadow: 0 4px 14px rgba(255, 92, 0, 0.4), 0 1px 3px rgba(0, 0, 0, 0.3);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      opacity: 0;
      pointer-events: none;
      transform: translateX(-4px) scale(0.9);
      transition:
        opacity 0.16s cubic-bezier(0.16, 1, 0.3, 1),
        transform 0.16s cubic-bezier(0.16, 1, 0.3, 1),
        box-shadow 0.16s ease;
      outline: none;
      padding: 0;
    }
    .hover-play-btn.visible {
      opacity: 0.55;
      pointer-events: all;
      transform: translateX(0) scale(1);
    }
    .hover-play-btn:hover {
      opacity: 1;
      transform: scale(1.12);
      box-shadow: 0 6px 18px rgba(255, 92, 0, 0.6);
    }
    .hover-play-btn:active {
      transform: scale(0.92);
    }
    .hover-play-btn svg {
      width: 13px;
      height: 13px;
      fill: #000000;
      margin-left: 1px;
    }

    /* ── Focus Reader Mode Overlay ───────────────────────── */
    .reader-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      display: flex;
      flex-direction: column;
      background: var(--r-bg, #FBF0D9);
      color: var(--r-text, #2A2421);
      opacity: 0;
      pointer-events: none;
      transform: translateY(12px) scale(0.99);
      transition: opacity 220ms ease, transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
    }

    .reader-overlay.open,
    .reader-overlay.is-open {
      opacity: 1;
      pointer-events: all;
      transform: translateY(0) scale(1);
    }

    .reader-overlay.theme-cream {
      --r-bg: #FBF0D9;
      --r-text: #2A2421;
      --r-meta: #7F7368;
      --r-hdr-bg: rgba(251, 240, 217, 0.88);
      --r-hdr-border: rgba(42, 36, 33, 0.1);
      --r-sentence-bg: rgba(255, 92, 0, 0.12);
    }
    .reader-overlay.theme-dark {
      --r-bg: #161616;
      --r-text: #E6E6E6;
      --r-meta: #8C8C8C;
      --r-hdr-bg: rgba(22, 22, 22, 0.88);
      --r-hdr-border: rgba(255, 255, 255, 0.1);
      --r-sentence-bg: rgba(255, 120, 40, 0.16);
    }
    .reader-overlay.theme-sepia {
      --r-bg: #F3EBD9;
      --r-text: #4F3E2F;
      --r-meta: #8A7561;
      --r-hdr-bg: rgba(243, 235, 217, 0.88);
      --r-hdr-border: rgba(79, 62, 47, 0.1);
      --r-sentence-bg: rgba(255, 92, 0, 0.13);
    }
    .reader-overlay.theme-oled {
      --r-bg: #000000;
      --r-text: #F2F2F2;
      --r-meta: #737373;
      --r-hdr-bg: rgba(0, 0, 0, 0.9);
      --r-hdr-border: rgba(255, 255, 255, 0.12);
      --r-sentence-bg: rgba(255, 120, 40, 0.18);
    }

    .reader-overlay.font-sans .reader-body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .reader-overlay.font-serif .reader-body {
      font-family: Charter, "Bitstream Charter", Cambria, Georgia, serif;
    }
    .reader-overlay.font-mono .reader-body {
      font-family: ui-monospace, "SF Mono", Consolas, monospace;
    }
    .reader-overlay.font-dyslexic .reader-body {
      font-family: "OpenDyslexic", "Comic Sans MS", sans-serif;
      letter-spacing: 0.04em;
      word-spacing: 0.08em;
    }

    .reader-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 20px;
      background: var(--r-hdr-bg);
      border-bottom: 1px solid var(--r-hdr-border);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      flex-shrink: 0;
      z-index: 10;
    }

    .reader-header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .reader-hdr-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid var(--r-hdr-border);
      border-radius: 20px;
      color: var(--r-text);
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      font-family: var(--ra-font);
      letter-spacing: 0.06em;
      transition: all 140ms ease;
    }
    .reader-overlay.theme-cream .reader-hdr-btn,
    .reader-overlay.theme-sepia .reader-hdr-btn {
      background: rgba(0, 0, 0, 0.04);
    }
    .reader-hdr-btn:hover {
      background: rgba(128, 128, 128, 0.2);
      transform: scale(1.04);
    }
    .reader-hdr-btn:active {
      transform: scale(0.96);
    }
    .reader-hdr-btn svg {
      width: 13px;
      height: 13px;
      fill: currentColor;
    }

    .reader-brand {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.14em;
      color: var(--r-meta);
      font-family: var(--ra-font);
    }

    .reader-header-right {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .reader-tool-group {
      display: flex;
      align-items: center;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--r-hdr-border);
      border-radius: 20px;
      padding: 2px 4px;
      overflow: hidden;
    }
    .reader-overlay.theme-cream .reader-tool-group,
    .reader-overlay.theme-sepia .reader-tool-group {
      background: rgba(0, 0, 0, 0.04);
    }
    .reader-tool-btn {
      background: transparent;
      border: none;
      color: var(--r-text);
      font-size: 11px;
      font-weight: 700;
      padding: 4px 10px;
      border-radius: 14px;
      cursor: pointer;
      font-family: var(--ra-font);
      transition: all 120ms ease;
    }
    .reader-tool-btn:hover {
      background: rgba(128, 128, 128, 0.2);
      transform: scale(1.08);
    }
    .reader-tool-btn:active {
      transform: scale(0.92);
    }
    .reader-tool-val {
      font-size: 10px;
      font-weight: 700;
      padding: 0 4px;
      color: var(--r-meta);
      min-width: 34px;
      text-align: center;
      font-family: var(--ra-font);
    }

    .reader-select {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--r-hdr-border);
      border-radius: 20px;
      color: var(--r-text);
      font-size: 11px;
      font-weight: 600;
      padding: 5px 12px;
      cursor: pointer;
      outline: none;
      transition: border-color 140ms ease;
    }
    .reader-overlay.theme-cream .reader-select,
    .reader-overlay.theme-sepia .reader-select {
      background: rgba(0, 0, 0, 0.04);
    }
    .reader-select:hover, .reader-select:focus {
      border-color: var(--ra-accent);
    }
    .reader-select option {
      background: #222;
      color: #fff;
    }

    .reader-theme-group {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .reader-th-btn {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      border: 2px solid transparent;
      cursor: pointer;
      font-size: 9px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 140ms ease;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
    }
    .reader-th-btn:hover {
      transform: scale(1.12);
    }
    .reader-th-btn.active {
      border-color: var(--ra-accent) !important;
      transform: scale(1.18);
      box-shadow: 0 0 8px rgba(255, 92, 0, 0.4);
    }

    /* Scrollable Reading Area */
    .reader-scroll-area {
      flex: 1;
      overflow-y: auto;
      padding: 40px 24px 160px 24px;
      display: flex;
      justify-content: center;
    }

    .reader-content-card {
      width: 100%;
      max-width: 720px;
      margin: 0 auto;
    }

    .reader-doc-title {
      font-size: 32px;
      font-weight: 800;
      line-height: 1.25;
      margin-bottom: 8px;
      letter-spacing: -0.015em;
      color: var(--r-text);
    }

    .reader-meta {
      font-size: 12px;
      font-family: var(--ra-font);
      color: var(--r-meta);
      margin-bottom: 28px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--r-hdr-border);
      letter-spacing: 0.04em;
    }

    .reader-body {
      font-size: var(--r-font-size, 19px);
      line-height: 1.8;
      color: var(--r-text);
    }

    .reader-paragraph {
      margin-bottom: 1.6em;
      text-wrap: pretty;
    }

    .reader-sentence {
      position: relative;
      padding: 3px 6px;
      margin: 0 -2px;
      border-radius: 6px;
      cursor: pointer;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
      transition: background 180ms ease, color 180ms ease;
    }
    .reader-sentence:hover {
      background: rgba(255, 92, 0, 0.08);
    }
    .reader-sentence.active-sentence {
      background: var(--r-sentence-bg);
      border-radius: 6px;
    }
    .reader-sentence.active-sentence .reader-word-active {
      display: inline-block;
      background: linear-gradient(135deg, #FF7A00 0%, #FF5C00 100%) !important;
      color: #FFFFFF !important;
      font-weight: 600;
      border-radius: 6px;
      padding: 1px 6px;
      margin: 0 1px;
      box-shadow: 0 2px 10px rgba(255, 92, 0, 0.45);
      transform: translateY(-0.5px);
      transition: transform 120ms ease, box-shadow 120ms ease;
    }

    /* Floating Reader Bar (Bottom Playback Controls) */
    .reader-bar {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 18px;
      background: rgba(20, 20, 24, 0.82);
      backdrop-filter: blur(24px) saturate(180%);
      -webkit-backdrop-filter: blur(24px) saturate(180%);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 36px;
      box-shadow: 0 14px 40px rgba(0, 0, 0, 0.5), 0 2px 10px rgba(0, 0, 0, 0.25);
      z-index: 20;
      color: #ffffff;
      font-family: var(--ra-font);
      transition: transform 200ms ease, opacity 200ms ease, box-shadow 200ms ease;
    }
    .reader-overlay.theme-cream .reader-bar,
    .reader-overlay.theme-sepia .reader-bar {
      background: rgba(250, 246, 238, 0.88);
      border: 1px solid rgba(0, 0, 0, 0.12);
      color: #1a1a1a;
      box-shadow: 0 14px 40px rgba(0, 0, 0, 0.15), 0 2px 10px rgba(0, 0, 0, 0.08);
    }

    .reader-ctrl-btn {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: currentColor;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 140ms ease;
      outline: none;
    }
    .reader-overlay.theme-cream .reader-ctrl-btn,
    .reader-overlay.theme-sepia .reader-ctrl-btn {
      background: rgba(0, 0, 0, 0.05);
      border-color: rgba(0, 0, 0, 0.1);
    }
    .reader-ctrl-btn:hover {
      background: rgba(255, 255, 255, 0.18);
      border-color: rgba(255, 255, 255, 0.25);
      transform: scale(1.08);
    }
    .reader-ctrl-btn:active {
      transform: scale(0.92);
    }
    .reader-ctrl-btn svg {
      width: 14px;
      height: 14px;
      fill: currentColor;
    }

    .reader-play-main {
      background: linear-gradient(135deg, #FF7A00 0%, #FF5C00 100%) !important;
      color: #000000 !important;
      border: 1px solid rgba(255, 255, 255, 0.25) !important;
      border-radius: 50% !important;
      width: 38px !important;
      height: 38px !important;
      box-shadow: 0 4px 14px rgba(255, 92, 0, 0.45);
    }
    .reader-play-main svg {
      fill: #000000 !important;
      width: 16px !important;
      height: 16px !important;
    }
    .reader-play-main:hover {
      background: linear-gradient(135deg, #FF8C1A 0%, #E65300 100%) !important;
      box-shadow: 0 6px 20px rgba(255, 92, 0, 0.6);
      transform: scale(1.1) !important;
    }
    .reader-play-main:active {
      transform: scale(0.92) !important;
    }

    .reader-progress-wrap {
      width: 130px;
      height: 6px;
      background: rgba(255, 255, 255, 0.15);
      border-radius: 3px;
      cursor: pointer;
      position: relative;
      overflow: hidden;
    }
    .reader-overlay.theme-cream .reader-progress-wrap,
    .reader-overlay.theme-sepia .reader-progress-wrap {
      background: rgba(0, 0, 0, 0.1);
    }
    .reader-progress-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #FF7A00, #FF5C00);
      border-radius: 3px;
      pointer-events: none;
      transition: width 0.2s ease;
    }

    .reader-progress-text {
      font-size: 11px;
      font-weight: 700;
      color: var(--r-meta);
      min-width: 44px;
      text-align: center;
      letter-spacing: 0.04em;
    }

    .reader-speed-badge {
      background: rgba(255, 92, 0, 0.12);
      border: 1px solid rgba(255, 92, 0, 0.3);
      color: var(--ra-accent);
      font-size: 11px;
      font-weight: 700;
      border-radius: 12px;
      padding: 3px 8px;
      cursor: pointer;
      transition: all 140ms ease;
    }
    .reader-speed-badge:hover {
      background: rgba(255, 92, 0, 0.22);
      border-color: var(--ra-accent);
      transform: scale(1.06);
    }

    /* ── Keyboard focus rings (WCAG AA) ───────────────────────────── */
    button:focus-visible,
    select:focus-visible,
    input:focus-visible,
    textarea:focus-visible {
      outline: 2px solid var(--ra-accent) !important;
      outline-offset: 2px !important;
    }

    /* ── Animated Word Indicator Box (Modern Gliding Capsule) ─────── */
    .ra-word-box {
      position: fixed;
      top: 0;
      left: 0;
      width: 0;
      height: 0;
      pointer-events: none;
      z-index: 2147483645;
      border-radius: 6px;
      background: rgba(255, 92, 0, 0.18);
      border: 1.5px solid #FF5C00;
      box-shadow: 0 0 16px rgba(255, 92, 0, 0.3), inset 0 0 6px rgba(255, 92, 0, 0.14);
      opacity: 0;
      /* transform, width, height driven by JS spring engine — no CSS transition for those */
      transform: translate3d(0, 0, 0);
      /* Only opacity fades in CSS; spring handles geometry */
      transition: opacity 100ms ease-out;
      will-change: transform, width, height, opacity;
      /* transform-origin centered so kinetic squish expands symmetrically */
      transform-origin: left center;
    }
    .ra-word-box.visible {
      opacity: 1;
    }
    /* Sleek glowing bottom anchor underline */
    .ra-word-box::after {
      content: '';
      position: absolute;
      bottom: -1px;
      left: 2px;
      right: 2px;
      height: 2.5px;
      background: var(--ra-accent);
      border-radius: 2px;
      box-shadow: 0 0 8px var(--ra-accent);
    }
    @media (prefers-reduced-motion: reduce) {
      .ra-word-box {
        /* Spring RAF loop is bypassed in JS when reduced-motion is detected */
        transition: none !important;
        transform: none !important;
      }
    }

    /* ── Interactive Pill & Button Micro-Animations ──────────────── */
    .player-pill {
      transition:
        transform 0.22s cubic-bezier(0.16, 1, 0.3, 1),
        box-shadow 0.2s ease,
        opacity 0.2s ease,
        border-color 0.2s ease;
    }
    .player-pill:hover {
      box-shadow: 0 12px 36px rgba(0, 0, 0, 0.7), 0 0 16px rgba(255, 92, 0, 0.25);
      border-color: rgba(255, 255, 255, 0.24);
    }
    button.icon-btn {
      transition: transform 0.14s cubic-bezier(0.16, 1, 0.3, 1), background 0.14s ease, color 0.14s ease;
    }
    button.icon-btn:hover {
      transform: scale(1.08);
      background: rgba(255, 255, 255, 0.12);
    }
    button.icon-btn:active {
      transform: scale(0.92);
    }
    button.play-btn {
      position: relative;
      transition: transform 0.16s cubic-bezier(0.34, 1.56, 0.64, 1), background 0.2s ease, box-shadow 0.2s ease;
    }
    button.play-btn:hover {
      transform: scale(1.12);
      box-shadow: 0 4px 16px rgba(255, 92, 0, 0.55);
    }
    button.play-btn:active {
      transform: scale(0.92);
    }
    .player-pill.is-playing .play-btn {
      animation: ra-play-pulse 2s infinite ease-in-out;
    }
    @keyframes ra-play-pulse {
      0%, 100% {
        box-shadow: 0 0 0 0 rgba(255, 92, 0, 0.3);
      }
      50% {
        box-shadow: 0 0 14px 3px rgba(255, 92, 0, 0.5);
      }
    }
    .speed-badge {
      transition: transform 0.14s ease, background 0.14s ease, border-color 0.14s ease;
      cursor: pointer;
    }
    .speed-badge:hover {
      transform: scale(1.08);
      background: rgba(255, 255, 255, 0.16);
      border-color: var(--ra-accent);
    }
    .speed-badge:active {
      transform: scale(0.94);
    }
    .progress-track {
      transition: height 0.15s ease, background 0.15s ease;
      cursor: pointer;
    }
    .progress-track:hover {
      height: 6px;
      background: rgba(255, 255, 255, 0.25);
    }
    .progress-fill {
      transition: width 0.1s linear, background-color 0.2s ease;
    }

    /* ── Live Animated Mini Audio Waveform / EQ ──────────────────── */
    .ra-audio-wave {
      display: inline-flex;
      align-items: center;
      gap: 2.5px;
      height: 16px;
      padding: 0 3px;
      opacity: 0.5;
      transition: opacity 0.2s ease;
    }
    .player-pill.is-playing .ra-audio-wave {
      opacity: 1;
    }
    .ra-audio-wave .bar {
      display: inline-block;
      width: 2.5px;
      height: 3px;
      background: var(--ra-accent);
      border-radius: 2px;
      box-shadow: 0 0 4px var(--ra-accent-dim);
      transition: height 0.15s ease, background-color 0.2s ease;
    }
    .player-pill.is-playing .ra-audio-wave .bar-1 {
      animation: ra-wave 0.85s infinite ease-in-out;
      animation-delay: 0.05s;
    }
    .player-pill.is-playing .ra-audio-wave .bar-2 {
      animation: ra-wave 0.75s infinite ease-in-out;
      animation-delay: 0.2s;
    }
    .player-pill.is-playing .ra-audio-wave .bar-3 {
      animation: ra-wave 0.9s infinite ease-in-out;
      animation-delay: 0.35s;
    }
    .player-pill.is-playing .ra-audio-wave .bar-4 {
      animation: ra-wave 0.8s infinite ease-in-out;
      animation-delay: 0.15s;
    }
    @keyframes ra-wave {
      0%, 100% {
        height: 3px;
        opacity: 0.55;
      }
      50% {
        height: 13px;
        opacity: 1;
        box-shadow: 0 0 8px var(--ra-accent);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .ra-audio-wave .bar {
        animation: none !important;
      }
    }
  `;

  const container = document.createElement('div');
  container.className = 'player-pill pill-compact';
  container.setAttribute('role', 'group');
  container.setAttribute('aria-label', 'NarraTrace playback controls');
  container.innerHTML = `
    <div class="drag-handle" title="Drag player anywhere">
      <svg viewBox="0 0 24 24"><path d="M9 5a2 2 0 100-4 2 2 0 000 4zm0 8a2 2 0 100-4 2 2 0 000 4zm0 8a2 2 0 100-4 2 2 0 000 4zm6-16a2 2 0 100-4 2 2 0 000 4zm0 8a2 2 0 100-4 2 2 0 000 4zm0 8a2 2 0 100-4 2 2 0 000 4z"/></svg>
    </div>

    <span class="ra-led" id="ra-led" title="Status LED"></span>
    <div class="ra-audio-wave" id="ra-audio-wave" title="Audio Activity" aria-hidden="true">
      <span class="bar bar-1"></span>
      <span class="bar bar-2"></span>
      <span class="bar bar-3"></span>
      <span class="bar bar-4"></span>
    </div>
    <span class="edge-chevron" id="ra-edge-chevron">‹</span>

    <div class="pill-body">
      <button class="icon-btn" id="ra-prev" title="Previous sentence (Alt+,)" aria-label="Previous sentence">
        <svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
      </button>

      <button class="icon-btn play-btn" id="ra-play" title="Play / Pause (Alt+P)" aria-label="Play or pause reading">
        <svg id="ra-play-icon" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      </button>

      <button class="icon-btn" id="ra-next" title="Next sentence (Alt+.)" aria-label="Next sentence">
        <svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
      </button>

      <span class="speed-badge" id="ra-speed" title="Cycle speed">1.0×</span>

      <button class="icon-btn" id="ra-settings" title="Open configuration" aria-label="Open settings">
        <svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
      </button>
    </div>

    <button class="icon-btn" id="ra-collapse" title="Collapse to edge panel" aria-label="Collapse player">
      <svg id="ra-collapse-icon" viewBox="0 0 24 24"><path d="M19 13H5v-2h14v2z"/></svg>
    </button>

    <div class="progress-track" id="ra-progress-track" title="Click or drag to seek"
      role="slider" tabindex="0" aria-orientation="horizontal" aria-label="Playback progress"
      aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="Not started">
      <div class="progress-fill" id="ra-progress-fill"></div>
    </div>
  `;

  shadow.appendChild(style);
  shadow.appendChild(container);

  // Animated gliding word tracking box
  wordBoxEl = document.createElement('div');
  wordBoxEl.className = 'ra-word-box';
  wordBoxEl.id = 'ra-word-box';
  wordBoxEl.setAttribute('aria-hidden', 'true');
  shadow.appendChild(wordBoxEl);
  updatePageHighlightStyle(currentHighlightColor);

  // Resume Reading Toast
  const resumeToast = document.createElement('div');
  resumeToast.className = 'resume-toast';
  resumeToast.id = 'ra-resume-toast';
  resumeToast.innerHTML = `
    <span id="ra-resume-text">Resume reading?</span>
    <button class="resume-act-btn" id="ra-resume-btn">RESUME</button>
    <button class="resume-close-btn" id="ra-resume-close" title="Dismiss">✕</button>
  `;
  shadow.appendChild(resumeToast);

  // Non-blocking status toast (replaces alert() error popups)
  const statusToast = document.createElement('div');
  statusToast.className = 'resume-toast';
  statusToast.id = 'ra-status-toast';
  statusToast.setAttribute('role', 'status');
  statusToast.setAttribute('aria-live', 'polite');
  statusToast.setAttribute('aria-atomic', 'true');
  statusToast.innerHTML = '<span id="ra-status-toast-text"></span>';
  shadow.appendChild(statusToast);

  // Settings panel (also lives in Shadow DOM so styles never leak)
  const settingsPanel = document.createElement('div');
  settingsPanel.className = 'settings-panel';
  settingsPanel.id = 'ra-settings-panel';
  settingsPanel.innerHTML = `
    <div class="settings-header">
      <span class="settings-title">SETTINGS</span>
      <button class="settings-close" id="ra-settings-close" title="Close" aria-label="Close settings">
        <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
    </div>

    <div class="settings-section" style="margin-bottom:12px;">
      <div style="display:flex; gap:8px;">
        <button type="button" id="ra-settings-reader" title="Focus Reader View (Alt+R)" class="settings-action-btn">
          <svg viewBox="0 0 24 24" style="width:13px;height:13px;"><path d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z"/></svg>
          FOCUS READER
        </button>
        <button type="button" id="ra-settings-stop" title="Stop reading (Alt+X)" class="settings-action-btn stop-action-btn">
          <svg viewBox="0 0 24 24" style="width:13px;height:13px;"><path d="M6 6h12v12H6z"/></svg>
          STOP
        </button>
      </div>
    </div>

    <hr class="settings-divider">

    <div class="settings-section">
      <label class="settings-label" for="ra-voice-select">VOICE</label>
      <select class="settings-select" id="ra-voice-select">
        <option value="">Loading voices…</option>
      </select>
      <div class="voice-status" id="ra-voice-status"></div>
    </div>

    <hr class="settings-divider">

    <div class="settings-section">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">
        <label class="settings-label" for="ra-speed-range" style="margin:0;">SPEED</label>
        <span class="speed-display" id="ra-speed-display">1.0×</span>
      </div>
      <div class="speed-row">
        <span class="speed-min-max">0.5×</span>
        <input type="range" class="speed-range" id="ra-speed-range"
          min="0.5" max="3.0" step="0.1" value="1.0">
        <span class="speed-min-max">3.0×</span>
      </div>
    </div>

    <hr class="settings-divider">

    <div class="settings-section">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">
        <label class="settings-label" for="ra-volume-range" style="margin:0;">VOLUME</label>
        <span class="speed-display" id="ra-volume-display">100%</span>
      </div>
      <div class="speed-row">
        <span class="speed-min-max">0%</span>
        <input type="range" class="speed-range" id="ra-volume-range"
          min="0" max="1" step="0.05" value="1.0">
        <span class="speed-min-max">100%</span>
      </div>
    </div>

    <hr class="settings-divider">

    <div class="settings-section">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div>
          <label class="settings-label">THEME</label>
          <div class="theme-row" style="gap:6px;">
            <button class="theme-btn active" data-theme="te" title="Dark theme">DARK</button>
            <button class="theme-btn" data-theme="light" title="Light theme">LIGHT</button>
          </div>
        </div>
        <div>
          <label class="settings-label">HIGHLIGHT</label>
          <div class="theme-row" style="gap:6px;">
            <button class="color-swatch active" data-color="orange" title="Signal Orange" aria-label="Signal Orange highlight" style="background:#FF5C00;"></button>
            <button class="color-swatch" data-color="indigo" title="Indigo" aria-label="Indigo highlight" style="background:#5C6BC0;"></button>
            <button class="color-swatch" data-color="green" title="Leaf Green" aria-label="Leaf Green highlight" style="background:#2E9E4F;"></button>
            <button class="color-swatch" data-color="pink" title="Magenta" aria-label="Magenta highlight" style="background:#E0559A;"></button>
          </div>
        </div>
      </div>
    </div>

    <hr class="settings-divider">

    <div class="settings-section" style="margin-bottom:0;">
      <label class="ra-toggle-row" for="ra-selection-toggle">
        <span class="ra-toggle-label">Selection Listen Tooltip</span>
        <div class="ra-switch">
          <input type="checkbox" id="ra-selection-toggle" checked>
          <span class="ra-switch-slider"></span>
        </div>
      </label>
      <label class="ra-toggle-row" for="ra-hover-toggle">
        <span class="ra-toggle-label">Paragraph Hover Button</span>
        <div class="ra-switch">
          <input type="checkbox" id="ra-hover-toggle" checked>
          <span class="ra-switch-slider"></span>
        </div>
      </label>
    </div>
  `;
  shadow.appendChild(settingsPanel);

  // Floating Selection Listen button (Speechify highlight-to-read popover)
  const selectionPlayBtn = document.createElement('button');
  selectionPlayBtn.className = 'selection-play-btn';
  selectionPlayBtn.id = 'ra-selection-play';
  selectionPlayBtn.title = 'Listen to selection';
  selectionPlayBtn.innerHTML = `
    <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
    <span>LISTEN</span>
  `;
  shadow.appendChild(selectionPlayBtn);

  // Paragraph Gutter Play button (stationary, non-tracking)
  const hoverPlayBtn = document.createElement('button');
  hoverPlayBtn.className = 'hover-play-btn';
  hoverPlayBtn.id = 'ra-hover-play';
  hoverPlayBtn.title = 'Play this paragraph';
  hoverPlayBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
  shadow.appendChild(hoverPlayBtn);

  // Focus Reader Mode Overlay
  const readerOverlay = document.createElement('div');
  readerOverlay.className = 'reader-overlay theme-cream font-sans';
  readerOverlay.id = 'ra-reader-overlay';
  readerOverlay.setAttribute('role', 'dialog');
  readerOverlay.setAttribute('aria-modal', 'true');
  readerOverlay.setAttribute('aria-labelledby', 'ra-reader-dialog-title');
  readerOverlay.innerHTML = `
    <h2 id="ra-reader-dialog-title" class="sr-only">Focus Reader</h2>
    <div class="reader-header">
      <div class="reader-header-left">
        <button type="button" class="reader-hdr-btn" id="ra-reader-close" title="Exit Focus Reader (Esc)" aria-label="Exit Focus Reader">
          <svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
          <span>EXIT</span>
        </button>
        <span class="reader-brand">NARRATRACE // FOCUS READER</span>
      </div>

      <div class="reader-header-right">
        <!-- Font Size Stepper -->
        <div class="reader-tool-group">
          <button type="button" class="reader-tool-btn" id="ra-font-dec" title="Decrease font size" aria-label="Decrease reader font size">A-</button>
          <span class="reader-tool-val" id="ra-font-size-val">19px</span>
          <button type="button" class="reader-tool-btn" id="ra-font-inc" title="Increase font size" aria-label="Increase reader font size">A+</button>
        </div>

        <!-- Font Family Selector -->
        <select class="reader-select" id="ra-reader-font" title="Select typography font" aria-label="Reader font">
          <option value="sans">Sans-Serif</option>
          <option value="serif">Serif (Editorial)</option>
          <option value="mono">Monospace</option>
          <option value="dyslexic">OpenDyslexic</option>
        </select>

        <!-- Theme Finish -->
        <div class="reader-theme-group">
          <button type="button" class="reader-th-btn active" data-rtheme="cream" title="Warm Cream Book" aria-label="Warm cream theme" aria-pressed="true" style="background:#FBF0D9; color:#2A2421;">Aa</button>
          <button type="button" class="reader-th-btn" data-rtheme="dark" title="Dark Slate" aria-label="Dark slate theme" aria-pressed="false" style="background:#181818; color:#F0F0F0; border-color:#333;">Aa</button>
          <button type="button" class="reader-th-btn" data-rtheme="sepia" title="Vintage Sepia" aria-label="Sepia theme" aria-pressed="false" style="background:#F4ECD8; color:#5B4636;">Aa</button>
          <button type="button" class="reader-th-btn" data-rtheme="oled" title="OLED Midnight" aria-label="OLED midnight theme" aria-pressed="false" style="background:#000000; color:#FFFFFF; border-color:#222;">Aa</button>
        </div>
      </div>
    </div>

    <!-- Scrollable Reader Area -->
    <div class="reader-scroll-area" id="ra-reader-scroll">
      <div class="reader-content-card">
        <h1 class="reader-doc-title" id="ra-reader-title">Reading View</h1>
        <div class="reader-meta" id="ra-reader-meta">Loading article text…</div>
        <div class="reader-body" id="ra-reader-body"></div>
      </div>
    </div>

    <!-- Floating Reader Bar at bottom -->
    <div class="reader-bar">
      <button type="button" class="reader-ctrl-btn" id="ra-rctrl-prev" title="Previous sentence (Alt+,)" aria-label="Previous sentence">
        <svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
      </button>

      <button type="button" class="reader-ctrl-btn reader-play-main" id="ra-rctrl-play" title="Play / Pause (Alt+P)" aria-label="Play or pause reading">
        <svg id="ra-rctrl-play-icon" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      </button>

      <button type="button" class="reader-ctrl-btn" id="ra-rctrl-next" title="Next sentence (Alt+.)" aria-label="Next sentence">
        <svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
      </button>

      <div class="reader-progress-wrap" id="ra-rprogress-track" title="Click or scrub to seek"
        role="slider" tabindex="0" aria-orientation="horizontal" aria-label="Reader playback progress"
        aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="Not started">
        <div class="reader-progress-fill" id="ra-rprogress-fill"></div>
      </div>

      <span class="reader-progress-text" id="ra-rprogress-text">01/00</span>
      <span class="reader-speed-badge" id="ra-rspeed" title="Cycle speed">1.0×</span>
    </div>
  `;
  shadow.appendChild(readerOverlay);

  const playBtn = shadow.getElementById('ra-play');
  const playIcon = shadow.getElementById('ra-play-icon');
  const prevBtn = shadow.getElementById('ra-prev');
  const nextBtn = shadow.getElementById('ra-next');
  const stopBtn = shadow.getElementById('ra-stop');
  const speedBadge = shadow.getElementById('ra-speed');
  const voiceInfo = shadow.getElementById('ra-voice-info');
  const progressPill = shadow.getElementById('ra-progress');
  const collapseBtn = shadow.getElementById('ra-collapse');

  // Settings panel element references
  const settingsCloseBtn  = shadow.getElementById('ra-settings-close');
  const voiceSelect       = shadow.getElementById('ra-voice-select');
  const voiceStatusEl     = shadow.getElementById('ra-voice-status');
  const speedRangeEl      = shadow.getElementById('ra-speed-range');
  const speedDisplayEl    = shadow.getElementById('ra-speed-display');
  const volumeRangeEl     = shadow.getElementById('ra-volume-range');
  const volumeDisplayEl   = shadow.getElementById('ra-volume-display');
  const selectionToggle   = shadow.getElementById('ra-selection-toggle');
  const hoverToggle       = shadow.getElementById('ra-hover-toggle');
  const batchSelectEl     = shadow.getElementById('ra-batch-select');
  const pitchRangeEl      = shadow.getElementById('ra-pitch-range');
  const pitchDisplayEl    = shadow.getElementById('ra-pitch-display');
  const pronTextareaEl    = shadow.getElementById('ra-pron-textarea');

  // Focus Reader references
  const readerBtn          = shadow.getElementById('ra-reader');
  const readerCloseBtn     = shadow.getElementById('ra-reader-close');
  const readerTitleEl      = shadow.getElementById('ra-reader-title');
  const readerMetaEl       = shadow.getElementById('ra-reader-meta');
  const readerBodyEl       = shadow.getElementById('ra-reader-body');
  const readerScrollEl     = shadow.getElementById('ra-reader-scroll');
  const readerFontSelect   = shadow.getElementById('ra-reader-font');
  const readerFontSizeVal  = shadow.getElementById('ra-font-size-val');
  const readerFontDecBtn   = shadow.getElementById('ra-font-dec');
  const readerFontIncBtn   = shadow.getElementById('ra-font-inc');
  const readerThemeBtns    = shadow.querySelectorAll('[data-rtheme]');

  const rctrlPrevBtn       = shadow.getElementById('ra-rctrl-prev');
  const rctrlPlayBtn       = shadow.getElementById('ra-rctrl-play');
  const rctrlPlayIcon      = shadow.getElementById('ra-rctrl-play-icon');
  const rctrlNextBtn       = shadow.getElementById('ra-rctrl-next');
  const rprogressTrackEl   = shadow.getElementById('ra-rprogress-track');
  const rprogressFillEl    = shadow.getElementById('ra-rprogress-fill');
  const rprogressTextEl    = shadow.getElementById('ra-rprogress-text');
  const rspeedBadge        = shadow.getElementById('ra-rspeed');

  let isReaderOpen = false;
  let readerReturnFocus = null;
  let readerFontSize = 19;
  let currentReaderTheme = 'cream';
  let currentReaderFont = 'sans';

  const themeBtns         = shadow.querySelectorAll('[data-theme]');
  const layoutBtns        = shadow.querySelectorAll('[data-layout]');
  const posBtns           = shadow.querySelectorAll('[data-pos]');
  const scaleRangeEl      = shadow.getElementById('ra-scale-range');
  const scaleValEl        = shadow.getElementById('ra-scale-val');
  const opacityRangeEl    = shadow.getElementById('ra-opacity-range');
  const opacityValEl      = shadow.getElementById('ra-opacity-val');

  let currentPlaybackState = 'IDLE';
  let currentSpeed = 1.0;
  let currentVolume = 1.0;
  let isSettingsOpen = false;
  let currentTheme = 'te';
  let currentLayout = 'compact';
  let currentScale = 1.0;
  let currentOpacity = 0.96;
  let selectionTooltipEnabled = true;
  let hoverToPlayEnabled = true;
  let isPillVisible = true;
  let isCollapsed = false;
  // Effective CSS zoom of the pill. The pill is scaled with `zoom`, so
  // viewport pixels (getBoundingClientRect) and the pill's own style
  // coordinates (style.left/style.top) live in two different spaces:
  //     visual = local * pillZoom
  let pillZoom = 1;

  // Voice data cache: [{ voiceName, extensionId, lang, label }]
  let cachedVoices = [];

  const SVG_PLAY    = '<path d="M8 5v14l11-7z"/>';
  const SVG_PAUSE   = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
  const SVG_MINIMIZE = '<path d="M19 13H5v-2h14v2z"/>';
  const SVG_EXPAND  = '<path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>';

  function applyPillVisibility(visible) {
    isPillVisible = Boolean(visible);
    container.style.display = isPillVisible ? 'flex' : 'none';
    if (!isPillVisible) {
      if (isSettingsOpen) closeSettings();
      hideHoverPlayBtn();
      hideSelectionTooltip();
    }
    safeStorageSet({ readAloud_pillVisible: isPillVisible });
  }

  let lastExpandedPos = null;

  function applyCollapsedState(collapsed) {
    isCollapsed = Boolean(collapsed);
    container.classList.toggle('collapsed', isCollapsed);

    const collapseIcon = shadow.getElementById('ra-collapse-icon');
    if (collapseIcon) {
      collapseIcon.innerHTML = isCollapsed ? SVG_EXPAND : SVG_MINIMIZE;
    }
    if (collapseBtn) {
      collapseBtn.title = isCollapsed ? 'Expand player' : 'Collapse player';
    }

    if (isCollapsed) {
      if (isSettingsOpen) closeSettings();
      // A tucked tab slides itself into the screen border; the collapsed edge
      // handle must stay fully visible at the edge instead.
      container.classList.remove('is-tucked');
      if (tuckTimer) clearTimeout(tuckTimer);
      // Record current position before collapsing
      const rect = container.getBoundingClientRect();
      if (rect.width > 20) {
        lastExpandedPos = {
          left: rect.left,
          top: rect.top,
          right: container.style.right,
          bottom: container.style.bottom
        };
      }

      // Determine nearest edge (left vs right)
      const pillCenter = rect.left + rect.width / 2;
      const isCloserToLeft = pillCenter < (window.innerWidth / 2);

      const edgeChevron = shadow.getElementById('ra-edge-chevron');
      if (isCloserToLeft) {
        container.classList.add('dock-left');
        container.classList.remove('dock-right');
        container.style.left = '0px';
        container.style.right = 'auto';
        if (edgeChevron) edgeChevron.textContent = '›';
      } else {
        container.classList.add('dock-right');
        container.classList.remove('dock-left');
        container.style.left = 'auto';
        container.style.right = '0px';
        if (edgeChevron) edgeChevron.textContent = '‹';
      }

      // Keep vertical position within view
      const topY = rect.top > 0 ? rect.top : (window.innerHeight - 120);
      const clampedTop = Math.max(10, Math.min(topY, window.innerHeight - 82));
      container.style.top = `${clampedTop}px`;
      container.style.bottom = 'auto';
    } else {
      container.classList.remove('dock-left', 'dock-right');
      if (lastExpandedPos) {
        container.style.left = `${lastExpandedPos.left}px`;
        container.style.top = `${lastExpandedPos.top}px`;
        container.style.right = lastExpandedPos.right || 'auto';
        container.style.bottom = lastExpandedPos.bottom || 'auto';
      } else {
        container.style.right = '24px';
        container.style.bottom = '24px';
        container.style.left = 'auto';
        container.style.top = 'auto';
      }
    }

    safeStorageSet({ readAloud_isCollapsed: isCollapsed });
  }

  // ── Settings Panel Helpers ────────────────────────────────────────

  /**
   * Position the settings panel optimally.
   * If pill is in lower half of the screen, open ABOVE the pill.
   * Clamps to viewport edges so it NEVER opens off-screen.
   */
  function positionSettingsPanel() {
    const pillRect = container.getBoundingClientRect();
    const panelW = 284;
    const panelH = settingsPanel.offsetHeight || 440;
    const pad = 10;

    let top;
    // Lower half: open ABOVE the pill
    if (pillRect.top > window.innerHeight / 2) {
      top = pillRect.top - panelH - 8;
      if (top < pad) {
        top = pad;
      }
    } else {
      // Upper half: open BELOW the pill
      top = pillRect.bottom + 8;
      if (top + panelH > window.innerHeight - pad) {
        top = window.innerHeight - panelH - pad;
      }
    }

    // Right-align with the pill, clamped to viewport
    let left = pillRect.right - panelW;
    if (left < pad) left = pad;
    if (left + panelW > window.innerWidth - pad) {
      left = window.innerWidth - panelW - pad;
    }

    settingsPanel.style.top  = `${Math.round(top)}px`;
    settingsPanel.style.left = `${Math.round(left)}px`;
    settingsPanel.style.bottom = 'auto';
    settingsPanel.style.right = 'auto';
  }

  /** Open the settings panel (refresh voice list each time). */
  function openSettings() {
    isSettingsOpen = true;
    settingsPanel.classList.add('open');
    positionSettingsPanel();
    requestAnimationFrame(positionSettingsPanel);
    populateVoices();
  }

  /** Close the settings panel. */
  function closeSettings() {
    isSettingsOpen = false;
    settingsPanel.classList.remove('open');
  }

  /**
   * Ask the background for all available voices and populate the <select>.
   * Groups: one per TTS engine extension (the active one first, marked with
   * ★), then the Windows system voices.
   */
  function populateVoices() {
    voiceStatusEl.textContent = 'Loading voices…';
    voiceStatusEl.className = 'voice-status';

    safeSendMessage({ action: 'GET_VOICES' }, (res) => {
      if (!res || !res.success) {
        voiceStatusEl.textContent = 'Could not load voice list.';
        voiceStatusEl.className = 'voice-status warn';
        return;
      }

      const {
        engines, localSystemVoices, selectedVoice, statusMessage, engineId
      } = res.data;
      cachedVoices = [];
      voiceSelect.innerHTML = '';

      // One group per TTS engine extension, the active engine first.
      (engines || []).forEach((engine) => {
        if (!engine.voices || engine.voices.length === 0) return;
        const isActive = engine.id === engineId;
        const grp = document.createElement('optgroup');
        grp.label = isActive ? `★ ${engine.fullLabel}` : engine.fullLabel;
        voiceSelect.appendChild(grp);
        engine.voices.forEach(v => {
          const opt = document.createElement('option');
          opt.value = v.voiceName;
          opt.dataset.extensionId = v.extensionId || '';
          opt.dataset.lang = v.lang || '';
          opt.textContent = isActive ? `★ ${v.voiceName}` : v.voiceName;
          if (selectedVoice && v.voiceName === selectedVoice.voiceName) opt.selected = true;
          grp.appendChild(opt);
          cachedVoices.push({ voiceName: v.voiceName, extensionId: v.extensionId || '', lang: v.lang || '' });
        });
      });

      // System / Windows voices
      if (localSystemVoices && localSystemVoices.length > 0) {
        const grp = document.createElement('optgroup');
        grp.label = 'Windows System Voices';
        voiceSelect.appendChild(grp);
        localSystemVoices.forEach(v => {
          const opt = document.createElement('option');
          opt.value = v.voiceName;
          opt.dataset.extensionId = '';
          opt.dataset.lang = v.lang || '';
          opt.textContent = v.lang ? `${v.voiceName} (${v.lang})` : v.voiceName;
          if (selectedVoice && v.voiceName === selectedVoice.voiceName && !v.extensionId) opt.selected = true;
          grp.appendChild(opt);
          cachedVoices.push({ voiceName: v.voiceName, extensionId: '', lang: v.lang || '' });
        });
      }

      // Status message
      if (selectedVoice) {
        voiceStatusEl.textContent = statusMessage || `Active: ${selectedVoice.voiceName}`;
        voiceStatusEl.className = 'voice-status ok';
        if (voiceInfo) voiceInfo.textContent = selectedVoice.voiceName.split(' ').slice(0, 2).join(' ');
      } else {
        voiceStatusEl.textContent = statusMessage || 'No voices found on this system.';
        voiceStatusEl.className = 'voice-status warn';
      }
    });
  }

  /**
   * Apply the selected voice from the dropdown immediately.
   */
  function applySelectedVoice() {
    const opt = voiceSelect.options[voiceSelect.selectedIndex];
    if (!opt || !opt.value) return;

    const voiceName = opt.value;
    const extensionId = opt.dataset.extensionId || null;
    const lang = opt.dataset.lang || null;

    safeSendMessage({
      action: 'SET_VOICE',
      voiceName,
      extensionId: extensionId || undefined,
      lang: lang || undefined,
    });

    if (voiceInfo) voiceInfo.textContent = voiceName.split(' ').slice(0, 2).join(' ');
    voiceStatusEl.textContent = `Active: ${voiceName}`;
    voiceStatusEl.className = 'voice-status ok';
  }

  /**
   * Apply Theme: te, te-field, midnight, light, sepia, glass, neon, nord, rose, mono.
   */
  function applyTheme(theme) {
    currentTheme = theme;
    host.classList.remove(
      'theme-te', 'theme-te-field', 'theme-light', 'light',
      'theme-midnight', 'theme-sepia', 'theme-glass', 'theme-neon', 'theme-nord', 'theme-rose', 'theme-mono'
    );

    const THEME_KEYS = ['te', 'light', 'te-field'];
    const valid = THEME_KEYS.includes(theme) ? theme : (theme === 'light' ? 'light' : 'te');
    host.classList.add(`theme-${valid}`);

    if (valid === 'light') host.classList.add('light');

    themeBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.theme === valid);
    });

    safeStorageSet({ readAloud_theme: valid });
  }

  function applyPillLayout(layout) {
    currentLayout = layout;
    container.classList.remove('pill-compact', 'pill-full', 'pill-mini');
    const valid = ['compact', 'full', 'mini'].includes(layout) ? layout : 'compact';
    container.classList.add(`pill-${valid}`);

    layoutBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.layout === valid);
    });

    safeStorageSet({ readAloud_pillLayout: valid });
  }

  /**
   * Apply Pill Scale (Size): 0.5 to 1.5.
   */
  function applyPillScale(scale) {
    const s = Math.max(0.5, Math.min(scale, 1.5));
    currentScale = s;
    host.style.setProperty('--pill-scale', String(s));
    pillZoom = 1;

    if (scaleRangeEl) scaleRangeEl.value = String(s);
    if (scaleValEl) scaleValEl.textContent = `${Math.round(s * 100)}%`;
    safeStorageSet({ readAloud_pillScale: s });
  }

  /**
   * Apply Pill Opacity: 0.5 to 1.0.
   */
  function applyPillOpacity(opacity) {
    const op = Math.max(0.5, Math.min(opacity, 1.0));
    currentOpacity = op;
    host.style.setProperty('--pill-opacity', String(op));
    if (opacityRangeEl) opacityRangeEl.value = String(op);
    if (opacityValEl) opacityValEl.textContent = `${Math.round(op * 100)}%`;
    safeStorageSet({ readAloud_pillOpacity: op });
  }

  /**
   * Snap the pill to one of the four viewport corners.
   * Also re-anchors transform-origin so size scaling grows away from that corner,
   * and persists the position like a manual drag would.
   */
  function applyPositionPreset(pos) {
    if (typeof undockFromEdge === 'function') {
      // Pass the pill's current viewport position — undockFromEdge() computes
      // Math.min(undefined, …) → NaN styles and a corrupted saved position
      // when called without arguments.
      const r = container.getBoundingClientRect();
      undockFromEdge(r.left, r.top);
    }
    const m = 24;
    const rect = container.getBoundingClientRect();
    let left, top;
    switch (pos) {
      case 'top-left':     left = m;                                 top = m;                                  break;
      case 'top-right':    left = window.innerWidth - m - rect.width; top = m;                                  break;
      case 'bottom-left':  left = m;                                 top = window.innerHeight - m - rect.height; break;
      case 'bottom-right': left = window.innerWidth - m - rect.width; top = window.innerHeight - m - rect.height; break;
      default: return;
    }
    left = Math.max(10, left);
    top = Math.max(10, top);

    // left/top were computed in viewport pixels — convert to the pill's
    // zoomed style space before assigning.
    container.style.left = `${toLocal(left)}px`;
    container.style.top = `${toLocal(top)}px`;
    container.style.right = 'auto';
    container.style.bottom = 'auto';
    container.style.transformOrigin = {
      'top-left': 'top left',
      'top-right': 'top right',
      'bottom-left': 'bottom left',
      'bottom-right': 'bottom right'
    }[pos];

    setActivePosBtn(left, top);
    safeStorageSet({ readAloud_playerPosition: { left, top } });
    if (isSettingsOpen) positionSettingsPanel();
  }

  /** Highlight the corner button matching the pill's current on-screen position (±60px). */
  function setActivePosBtn(left, top) {
    const m = 24;
    const rect = container.getBoundingClientRect();
    const targets = {
      'top-left':     { x: m,                                 y: m },
      'top-right':    { x: window.innerWidth - m - rect.width, y: m },
      'bottom-left':  { x: m,                                 y: window.innerHeight - m - rect.height },
      'bottom-right': { x: window.innerWidth - m - rect.width, y: window.innerHeight - m - rect.height },
    };
    posBtns.forEach(btn => {
      const t = targets[btn.dataset.pos];
      if (!t) return;
      btn.classList.toggle('active', Math.abs(left - t.x) <= 60 && Math.abs(top - t.y) <= 60);
    });
  }

  // ── Settings Panel Event Wiring ──────────────────────────────────

  // Open settings on ⚙ pill button
  shadow.getElementById('ra-settings').addEventListener('click', () => {
    if (isSettingsOpen) closeSettings(); else openSettings();
  });

  // Close button
  settingsCloseBtn.addEventListener('click', closeSettings);

  // Close panel when clicking outside.
  //
  // This listener is registered in the CAPTURE phase, so it runs BEFORE the
  // click ever reaches the shadow tree. That means stopPropagation() on the
  // panel/pill (bubble phase) cannot prevent it — the panel used to close the
  // instant you touched any control inside it, and the gear button could never
  // close it (capture closed it, then the gear handler saw "closed" and
  // reopened it). composedPath() tells us where the click actually started.
  document.addEventListener('click', (e) => {
    if (!isSettingsOpen) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (path.includes(settingsPanel) || path.includes(container) || path.includes(hoverPlayBtn)) return;
    closeSettings();
  }, { capture: true });

  settingsPanel.addEventListener('click', (e) => e.stopPropagation());
  container.addEventListener('click', (e) => e.stopPropagation());

  // Voice dropdown change
  voiceSelect.addEventListener('change', applySelectedVoice);

  // Speed slider — display updates live, but the SET_RATE send is debounced:
  // the background restarts the current utterance on every rate change while
  // playing, so an un-debounced drag causes stop/restart stutter dozens of
  // times per drag. Same idiom as pronSaveTimer below.
  let rateSendTimer = null;
  speedRangeEl.addEventListener('input', () => {
    const rate = parseFloat(speedRangeEl.value);
    currentSpeed = rate;
    speedDisplayEl.textContent = `${rate.toFixed(1)}×`;
    speedBadge.textContent = `${rate.toFixed(1)}x`;
    if (rateSendTimer) clearTimeout(rateSendTimer);
    rateSendTimer = setTimeout(() => {
      safeSendMessage({ action: 'SET_RATE', rate: currentSpeed });
    }, 200);
  });

  // Volume slider — debounced for the same reason (restart-on-change).
  let volumeSendTimer = null;
  if (volumeRangeEl) {
    volumeRangeEl.addEventListener('input', () => {
      const vol = parseFloat(volumeRangeEl.value);
      currentVolume = vol;
      if (volumeDisplayEl) volumeDisplayEl.textContent = `${Math.round(vol * 100)}%`;
      if (volumeSendTimer) clearTimeout(volumeSendTimer);
      volumeSendTimer = setTimeout(() => {
        safeSendMessage({ action: 'SET_VOLUME', volume: currentVolume });
      }, 200);
    });
  }

  // Pitch slider — debounced for the same reason (restart-on-change).
  let pitchSendTimer = null;
  if (pitchRangeEl) {
    pitchRangeEl.addEventListener('input', () => {
      const p = parseFloat(pitchRangeEl.value);
      if (pitchDisplayEl) pitchDisplayEl.textContent = `${p.toFixed(1)}×`;
      if (pitchSendTimer) clearTimeout(pitchSendTimer);
      pitchSendTimer = setTimeout(() => {
        safeSendMessage({ action: 'SET_PITCH', pitch: p });
      }, 200);
    });
  }

  // Pronunciation overrides (debounced while typing)
  let pronSaveTimer = null;
  if (pronTextareaEl) {
    pronTextareaEl.addEventListener('input', () => {
      if (pronSaveTimer) clearTimeout(pronSaveTimer);
      pronSaveTimer = setTimeout(() => {
        safeSendMessage({ action: 'SET_PRONUNCIATIONS', text: pronTextareaEl.value });
      }, 600);
    });
  }

  // Theme selection buttons
  themeBtns.forEach(btn => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
  });

  // Layout selection buttons (Compact, Full, Mini)
  layoutBtns.forEach(btn => {
    btn.addEventListener('click', () => applyPillLayout(btn.dataset.layout));
  });

  // Position preset buttons (corner snapping)
  posBtns.forEach(btn => {
    btn.addEventListener('click', () => applyPositionPreset(btn.dataset.pos));
  });

  // Size / Scale slider
  if (scaleRangeEl) {
    scaleRangeEl.addEventListener('input', () => {
      applyPillScale(parseFloat(scaleRangeEl.value));
    });
  }

  // Opacity slider
  if (opacityRangeEl) {
    opacityRangeEl.addEventListener('input', () => {
      applyPillOpacity(parseFloat(opacityRangeEl.value));
    });
  }

  // Selection Listen Tooltip toggle
  if (selectionToggle) {
    selectionToggle.addEventListener('change', () => {
      selectionTooltipEnabled = selectionToggle.checked;
      safeStorageSet({ readAloud_selectionTooltip: selectionTooltipEnabled });
      if (!selectionTooltipEnabled) {
        hideSelectionTooltip();
      }
    });
  }

  // Hover to Play toggle
  if (hoverToggle) {
    hoverToggle.addEventListener('change', () => {
      hoverToPlayEnabled = hoverToggle.checked;
      safeStorageSet({ readAloud_hoverToPlay: hoverToPlayEnabled });
      if (!hoverToPlayEnabled) {
        hideHoverPlayBtn();
      }
    });
  }

  // Sentence grouping — how many sentences share one TTS request.
  // 0 = automatic: network voices (Supertonic) group 3 at a time so there is
  // no dead air between sentences; local Windows voices stay at 1 so skipping
  // stays instant.
  if (batchSelectEl) {
    batchSelectEl.addEventListener('change', () => {
      const size = parseInt(batchSelectEl.value, 10);
      const safe = Number.isFinite(size) ? size : 0;
      safeStorageSet({ readAloud_batchSize: safe });
      safeSendMessage({ action: 'SET_BATCH_SIZE', size: safe });
    });
  }

  // Highlight Color Swatches
  const colorSwatches = shadow.querySelectorAll('.color-swatch');
  function setActiveSwatch(colorKey) {
    colorSwatches.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.color === colorKey);
    });
  }

  colorSwatches.forEach(btn => {
    btn.addEventListener('click', () => {
      const colorKey = btn.dataset.color;
      updatePageHighlightStyle(colorKey);
      setActiveSwatch(colorKey);
      safeStorageSet({ readAloud_highlightColor: colorKey });
    });
  });

  // ── Persistent Settings: Load on Init ────────────────────────────

  safeStorageGet([
    'readAloud_theme',
    'readAloud_pillLayout',
    'readAloud_pillScale',
    'readAloud_pillOpacity',
    'readAloud_highlightColor',
    'readAloud_selectionTooltip',
    'readAloud_hoverToPlay',
    'readAloud_userPreferences',
    'readAloud_pillVisible',
    'readAloud_isCollapsed',
    'readAloud_readerTheme',
    'readAloud_readerFont',
    'readAloud_readerFontSize',
    'readAloud_batchSize'
  ], (res) => {
    // Visibility
    if (typeof res?.readAloud_pillVisible === 'boolean') {
      applyPillVisibility(res.readAloud_pillVisible);
    } else {
      applyPillVisibility(true);
    }

    // Collapsed state: defaults to false so player is visible and ready on page load
    applyCollapsedState(
      typeof res?.readAloud_isCollapsed === 'boolean' ? res.readAloud_isCollapsed : false
    );
    // Theme (TE aluminum default)
    applyTheme(res?.readAloud_theme || 'te');

    // Layout — MINI is the default: the player shows only its status LED and
    // the play button (48 x 34 px) and unfolds the full control row while the
    // mouse is over it. The old default (compact) kept every button on screen
    // at all times, which is what made the bar eat so much of the page.
    applyPillLayout(res?.readAloud_pillLayout || 'mini');

    // Size / Scale (100% default)
    applyPillScale(typeof res?.readAloud_pillScale === 'number' ? res.readAloud_pillScale : 1.0);

    // Opacity (96% default)
    applyPillOpacity(typeof res?.readAloud_pillOpacity === 'number' ? res.readAloud_pillOpacity : 0.96);

    // Highlight Tint (signal orange default)
    const savedHighlight = res?.readAloud_highlightColor || 'orange';
    updatePageHighlightStyle(savedHighlight);
    setActiveSwatch(savedHighlight);

    // Selection Listen Tooltip preference
    if (typeof res?.readAloud_selectionTooltip === 'boolean') {
      selectionTooltipEnabled = res.readAloud_selectionTooltip;
      if (selectionToggle) selectionToggle.checked = selectionTooltipEnabled;
    }

    // Hover to Play preference
    if (typeof res?.readAloud_hoverToPlay === 'boolean') {
      hoverToPlayEnabled = res.readAloud_hoverToPlay;
      if (hoverToggle) hoverToggle.checked = hoverToPlayEnabled;
    }

    // Sentence grouping preference — mirror it to the worker so the choice
    // applies to every tab, not just this one.
    if (typeof res?.readAloud_batchSize === 'number') {
      const size = Math.max(0, Math.min(12, Math.trunc(res.readAloud_batchSize)));
      if (batchSelectEl) batchSelectEl.value = String(size);
      safeSendMessage({ action: 'SET_BATCH_SIZE', size });
    }

    // Reader View preferences
    if (res?.readAloud_readerTheme) {
      applyReaderTheme(res.readAloud_readerTheme);
    }
    if (res?.readAloud_readerFont) {
      applyReaderFont(res.readAloud_readerFont);
    }
    if (typeof res?.readAloud_readerFontSize === 'number') {
      applyReaderFontSize(res.readAloud_readerFontSize);
    }

    // Speed
    const prefs = res?.readAloud_userPreferences;
    if (prefs && typeof prefs.rate === 'number') {
      currentSpeed = prefs.rate;
      speedBadge.textContent = `${currentSpeed.toFixed(1)}x`;
      if (rspeedBadge) rspeedBadge.textContent = `${currentSpeed.toFixed(1)}x`;
      speedRangeEl.value = String(currentSpeed);
      speedDisplayEl.textContent = `${currentSpeed.toFixed(1)}×`;
    }

    // Volume
    if (prefs && typeof prefs.volume === 'number') {
      currentVolume = prefs.volume;
      if (volumeRangeEl) volumeRangeEl.value = String(currentVolume);
      if (volumeDisplayEl) volumeDisplayEl.textContent = `${Math.round(currentVolume * 100)}%`;
    }

    // Pitch
    if (prefs && typeof prefs.pitch === 'number') {
      if (pitchRangeEl) pitchRangeEl.value = String(prefs.pitch);
      if (pitchDisplayEl) pitchDisplayEl.textContent = `${prefs.pitch.toFixed(1)}×`;
    }

    // Pronunciation overrides prefill
    if (pronTextareaEl && prefs && typeof prefs.pronunciationText === 'string') {
      pronTextareaEl.value = prefs.pronunciationText;
    }

    // Voice label
    if (voiceInfo && prefs && prefs.voiceName) {
      voiceInfo.textContent = prefs.voiceName.split(' ').slice(0, 2).join(' ');
    }
  });

  function updateProgressBar(index, total) {
    const pct = total > 0 ? Math.round(((index + 1) / total) * 100) : 0;
    container.style.setProperty('--ra-progress-pct', `${pct}%`);
    if (rprogressFillEl) {
      rprogressFillEl.style.width = `${pct}%`;
    }
    if (rprogressTextEl) {
      rprogressTextEl.textContent = `${String(index + 1).padStart(2, '0')}/${String(total).padStart(2, '0')}`;
    }
    // Keep both progress sliders understandable to screen readers.
    const valueText = total > 0
      ? `Sentence ${Math.min(index + 1, total)} of ${total}`
      : 'No active reading session';
    progressTrackEl?.setAttribute('aria-valuenow', pct);
    progressTrackEl?.setAttribute('aria-valuetext', valueText);
    rprogressTrackEl?.setAttribute('aria-valuenow', pct);
    rprogressTrackEl?.setAttribute('aria-valuetext', valueText);
  }

  // ── Seekable Progress Bar Interaction ───────────────────────────
  const progressTrackEl = shadow.getElementById('ra-progress-track');
  let isSeekingProgress = false;

  function seekFromProgressEvent(e) {
    if (!progressTrackEl) return;
    const rect = progressTrackEl.getBoundingClientRect();
    if (rect.width <= 0) return;
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const pct = x / rect.width;
    const total = currentSentenceRanges.length;
    if (total > 0) {
      const targetIndex = Math.min(Math.floor(pct * total), total - 1);
      safeSendMessage({ action: 'JUMP_TO_INDEX', index: targetIndex });
      applyHighlight(targetIndex);
    }
  }

  function handleProgressKeyboard(event) {
    const total = currentSentenceRanges.length;
    if (total <= 0) return;

    const current = currentSentenceIndex >= 0
      ? currentSentenceIndex
      : 0;
    let target = current;

    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        target += 1;
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        target -= 1;
        break;
      case 'PageUp':
        target -= 10;
        break;
      case 'PageDown':
        target += 10;
        break;
      case 'Home':
        target = 0;
        break;
      case 'End':
        target = total - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    target = Math.max(0, Math.min(total - 1, target));
    if (target === currentSentenceIndex) return;

    safeSendMessage({ action: 'JUMP_TO_INDEX', index: target });
    applyHighlight(target);
    updateProgressBar(target, total);
  }

  if (progressTrackEl) {
    progressTrackEl.addEventListener('keydown', handleProgressKeyboard);
  }

  if (rprogressTrackEl) {
    rprogressTrackEl.addEventListener('keydown', handleProgressKeyboard);
  }

  if (progressTrackEl) {
    progressTrackEl.addEventListener('mousedown', (e) => {
      isSeekingProgress = true;
      seekFromProgressEvent(e);
      const onMove = (ev) => { if (isSeekingProgress) seekFromProgressEvent(ev); };
      const onUp = () => {
        isSeekingProgress = false;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  heartbeatTimer = null; // declaration hoisted above IIFE for TDZ safety
  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      if (!isExtensionValid()) {
        stopHeartbeat();
        return;
      }
      if (currentPlaybackState === 'PLAYING') {
        safeSendMessage({ action: 'HEARTBEAT' });
      } else {
        stopHeartbeat();
      }
    }, 15000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  let statusToastTimer = null;
  function showToast(message) {
    const toast = shadow.getElementById('ra-status-toast');
    const text = shadow.getElementById('ra-status-toast-text');
    if (!toast || !text) return;
    text.textContent = message;
    toast.classList.add('visible');
    if (statusToastTimer) clearTimeout(statusToastTimer);
    statusToastTimer = setTimeout(() => toast.classList.remove('visible'), 3500);
  }

  function updatePlayState(state) {
    currentPlaybackState = state;
    if (state === 'PLAYING') {
      playIcon.innerHTML = SVG_PAUSE;
      playBtn.title = 'Pause';
      playBtn.setAttribute('aria-label', 'Pause reading');
      if (rctrlPlayIcon) rctrlPlayIcon.innerHTML = SVG_PAUSE;
      if (rctrlPlayBtn) {
        rctrlPlayBtn.title = 'Pause (Alt+P)';
        rctrlPlayBtn.setAttribute('aria-label', 'Pause reading');
      }
      container.classList.add('is-playing');
      startMutationObserver();
      startHeartbeat();
    } else {
      playIcon.innerHTML = SVG_PLAY;
      playBtn.title = 'Play';
      playBtn.setAttribute('aria-label', 'Play or pause reading');
      if (rctrlPlayIcon) rctrlPlayIcon.innerHTML = SVG_PLAY;
      if (rctrlPlayBtn) {
        rctrlPlayBtn.title = state === 'PAUSED' ? 'Resume (Alt+P)' : 'Play (Alt+P)';
        rctrlPlayBtn.setAttribute('aria-label', state === 'PAUSED' ? 'Resume reading' : 'Play reading');
      }
      container.classList.remove('is-playing');
      stopHeartbeat();
      if (state === 'STOPPED' || state === 'IDLE') {
        stopMutationObserver();
        if (progressPill) progressPill.style.display = 'none';
        container.style.setProperty('--ra-progress-pct', '0%');
        clearHighlight();
        if (rprogressFillEl) rprogressFillEl.style.width = '0%';
        if (rprogressTextEl) rprogressTextEl.textContent = '01/00';
      }
    }
  }

  // -----------------------------------------------------------------
  // 4c. Focus Reader Mode View Controller
  // -----------------------------------------------------------------
  function escapeHtml(str) {
    if (!str) return '';
    // \x22/\x27 are quote and apostrophe — written as escapes so the quote
    // char never appears inside a regex literal (keeps diag_check's parser sane).
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\x22/g, '&quot;')
      .replace(/\x27/g, '&#039;');
  }

  function applyReaderTheme(themeKey) {
    currentReaderTheme = themeKey || 'cream';
    readerOverlay.classList.remove('theme-cream', 'theme-dark', 'theme-sepia', 'theme-oled');
    readerOverlay.classList.add(`theme-${currentReaderTheme}`);
    readerThemeBtns.forEach(btn => {
      const isActive = btn.dataset.rtheme === currentReaderTheme;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', String(isActive));
    });
    safeStorageSet({ readAloud_readerTheme: currentReaderTheme });
  }

  function applyReaderFont(fontKey) {
    currentReaderFont = fontKey || 'sans';
    readerOverlay.classList.remove('font-sans', 'font-serif', 'font-mono', 'font-dyslexic');
    readerOverlay.classList.add(`font-${currentReaderFont}`);
    if (readerFontSelect) readerFontSelect.value = currentReaderFont;
    safeStorageSet({ readAloud_readerFont: currentReaderFont });
  }

  function applyReaderFontSize(sizePx) {
    readerFontSize = Math.max(14, Math.min(32, sizePx || 19));
    readerOverlay.style.setProperty('--r-font-size', `${readerFontSize}px`);
    if (readerFontSizeVal) readerFontSizeVal.textContent = `${readerFontSize}px`;
    safeStorageSet({ readAloud_readerFontSize: readerFontSize });
  }

  function openReaderView() {
    if (currentSentenceRanges.length === 0) {
      buildPlaybackQueue();
    }
    if (currentSentenceRanges.length === 0) {
      showToast('No readable text found on this page.');
      return;
    }

    // Determine article title
    let title = '';
    const h1 = document.querySelector('article h1, main h1, [role="main"] h1, h1');
    if (h1 && h1.textContent.trim()) {
      title = h1.textContent.trim();
    } else {
      title = document.title ? document.title.split(/[-|—·]/)[0].trim() : 'Reading View';
    }
    if (readerTitleEl) readerTitleEl.textContent = title || 'Reading View';

    // Meta details
    const domain = window.location.hostname.replace(/^www\./, '');
    const totalSentences = currentSentenceRanges.length;
    const estMin = Math.max(1, Math.ceil((totalSentences * 18) / (160 * currentSpeed)));
    if (readerMetaEl) {
      readerMetaEl.textContent = `${domain} • ${totalSentences} sentences • ~${estMin} min read`;
    }

    // Build paragraphs & sentences
    if (readerBodyEl) {
      let html = '';
      let currentGroup = [];
      let lastParent = null;

      for (let i = 0; i < currentSentenceRanges.length; i++) {
        const item = currentSentenceRanges[i];
        const parent = item.element || (item.range ? item.range.startContainer.parentElement : null);

        if (lastParent && parent !== lastParent && currentGroup.length > 0) {
          html += `<p class="reader-paragraph">${currentGroup.join(' ')}</p>`;
          currentGroup = [];
        }
        lastParent = parent;

        const safeText = escapeHtml(item.text);
        currentGroup.push(`<span class="reader-sentence" data-idx="${i}" id="ra-rsent-${i}">${safeText}</span>`);
      }

      if (currentGroup.length > 0) {
        html += `<p class="reader-paragraph">${currentGroup.join(' ')}</p>`;
      }

      readerBodyEl.innerHTML = html;
    }

    readerReturnFocus = shadow.activeElement || document.activeElement;
    isReaderOpen = true;
    readerOverlay.classList.add('open');
    readerCloseBtn?.focus();

    // Sync reader playback controls with current state
    if (rctrlPlayIcon) {
      rctrlPlayIcon.innerHTML = (currentPlaybackState === 'PLAYING') ? SVG_PAUSE : SVG_PLAY;
    }
    if (rctrlPlayBtn) {
      const isPlaying = currentPlaybackState === 'PLAYING';
      rctrlPlayBtn.title = isPlaying ? 'Pause (Alt+P)' : 'Play (Alt+P)';
      rctrlPlayBtn.setAttribute('aria-label', isPlaying ? 'Pause reading' : 'Play reading');
    }
    if (rspeedBadge) {
      rspeedBadge.textContent = `${currentSpeed.toFixed(1)}x`;
    }
    updateProgressBar(currentSentenceIndex >= 0 ? currentSentenceIndex : 0, currentSentenceRanges.length);

    // Apply active highlight in reader view if currently playing or paused
    if (currentSentenceIndex >= 0 && currentSentenceIndex < currentSentenceRanges.length) {
      updateReaderHighlight(currentSentenceIndex);
    }
  }

  function closeReaderView() {
    isReaderOpen = false;
    readerOverlay.classList.remove('open');
    const returnTarget = readerReturnFocus;
    readerReturnFocus = null;
    if (returnTarget && returnTarget.isConnected && typeof returnTarget.focus === 'function') {
      returnTarget.focus();
    } else {
      shadow.getElementById('ra-settings')?.focus();
    }
  }

  function toggleReaderView() {
    if (isReaderOpen) {
      closeReaderView();
    } else {
      openReaderView();
    }
  }

  function updateReaderHighlight(index) {
    if (!readerBodyEl) return;
    const prevActive = readerBodyEl.querySelectorAll('.reader-sentence.active-sentence');
    prevActive.forEach(el => {
      el.classList.remove('active-sentence');
      const idx = parseInt(el.dataset.idx, 10);
      if (!isNaN(idx) && currentSentenceRanges[idx]) {
        el.textContent = currentSentenceRanges[idx].text;
      }
    });

    if (index < 0 || index >= currentSentenceRanges.length) return;

    const targetEl = shadow.getElementById(`ra-rsent-${index}`);
    if (targetEl) {
      targetEl.classList.add('active-sentence');
      if (readerScrollEl) {
        const targetRect = targetEl.getBoundingClientRect();
        const scrollRect = readerScrollEl.getBoundingClientRect();
        const sentMidInScroll = targetRect.top - scrollRect.top + readerScrollEl.scrollTop + targetRect.height / 2;
        const anchorOffset    = scrollRect.height * GAZE_ANCHOR;
        const desiredScrollTop = Math.max(0, sentMidInScroll - anchorOffset);
        const curScrollTop     = readerScrollEl.scrollTop;
        const drift = Math.abs(desiredScrollTop - curScrollTop);
        if (drift > 60) {
          gazeScrollTo(desiredScrollTop, readerScrollEl);
        }
      }
    }
  }

  function updateReaderWordHighlight(index, charIndex, charLength) {
    if (!isReaderOpen || !readerBodyEl) return;
    if (index < 0 || index >= currentSentenceRanges.length) return;
    const item = currentSentenceRanges[index];
    if (!item || !item.text) return;

    const targetEl = shadow.getElementById(`ra-rsent-${index}`);
    if (!targetEl) return;

    const text = item.text;
    const start = Math.max(0, Math.min(text.length, charIndex));
    const end = Math.max(start, Math.min(text.length, charIndex + (charLength || 1)));

    const before = escapeHtml(text.slice(0, start));
    const word = escapeHtml(text.slice(start, end));
    const after = escapeHtml(text.slice(end));

    targetEl.innerHTML = `${before}<span class="reader-word-active">${word}</span>${after}`;
  }

  function clearReaderHighlight() {
    if (!readerBodyEl) return;
    const prevActive = readerBodyEl.querySelectorAll('.reader-sentence.active-sentence');
    prevActive.forEach(el => {
      el.classList.remove('active-sentence');
      const idx = parseInt(el.dataset.idx, 10);
      if (!isNaN(idx) && currentSentenceRanges[idx]) {
        el.textContent = currentSentenceRanges[idx].text;
      }
    });
  }

  // Focus Reader is a modal surface: keep keyboard focus inside it while
  // open, and return focus to the invoking control when it closes.
  readerOverlay.addEventListener('keydown', (event) => {
    if (!isReaderOpen || event.key !== 'Tab') return;

    const focusable = Array.from(readerOverlay.querySelectorAll(
      'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
    )).filter(element =>
      !element.hasAttribute('hidden') &&
      element.getAttribute('aria-hidden') !== 'true' &&
      element.getClientRects().length > 0
    );

    if (focusable.length === 0) {
      event.preventDefault();
      readerCloseBtn?.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = shadow.activeElement || document.activeElement;

    if (event.shiftKey && (active === first || active === readerOverlay)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });

  // Reader Event Listeners
  if (readerCloseBtn) {
    readerCloseBtn.addEventListener('click', closeReaderView);
  }

  if (readerBtn) {
    readerBtn.addEventListener('click', toggleReaderView);
  }

  readerThemeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      applyReaderTheme(btn.dataset.rtheme);
    });
  });

  if (readerFontSelect) {
    readerFontSelect.addEventListener('change', () => {
      applyReaderFont(readerFontSelect.value);
    });
  }

  if (readerFontDecBtn) {
    readerFontDecBtn.addEventListener('click', () => {
      applyReaderFontSize(readerFontSize - 1);
    });
  }
  if (readerFontIncBtn) {
    readerFontIncBtn.addEventListener('click', () => {
      applyReaderFontSize(readerFontSize + 1);
    });
  }

  if (readerBodyEl) {
    readerBodyEl.addEventListener('click', (e) => {
      const sentEl = e.target.closest('.reader-sentence');
      if (!sentEl) return;
      const idx = parseInt(sentEl.dataset.idx, 10);
      if (!isNaN(idx) && idx >= 0 && idx < currentSentenceRanges.length) {
        if (currentPlaybackState === 'IDLE' || currentPlaybackState === 'STOPPED') {
          safeSendMessage({
            action: 'START_PLAYBACK',
            sentences: currentSentenceRanges.map(s => s.text),
            startIndex: idx,
            options: { rate: currentSpeed, volume: currentVolume }
          });
        } else {
          safeSendMessage({ action: 'JUMP_TO_INDEX', index: idx });
        }
        applyHighlight(idx);
      }
    });
  }

  if (rctrlPlayBtn) {
    rctrlPlayBtn.addEventListener('click', () => {
      if (currentPlaybackState === 'PLAYING') {
        safeSendMessage({ action: 'PAUSE_PLAYBACK' });
      } else if (currentPlaybackState === 'PAUSED') {
        safeSendMessage({ action: 'RESUME_PLAYBACK' });
      } else {
        if (currentSentenceRanges.length === 0) buildPlaybackQueue();
        if (currentSentenceRanges.length > 0) {
          safeSendMessage({
            action: 'START_PLAYBACK',
            sentences: currentSentenceRanges.map(s => s.text),
            startIndex: currentSentenceIndex >= 0 ? currentSentenceIndex : 0,
            options: { rate: currentSpeed, volume: currentVolume }
          });
        }
      }
    });
  }

  if (rctrlPrevBtn) {
    rctrlPrevBtn.addEventListener('click', () => {
      safeSendMessage({ action: 'SKIP_BACKWARD' });
    });
  }

  if (rctrlNextBtn) {
    rctrlNextBtn.addEventListener('click', () => {
      safeSendMessage({ action: 'SKIP_FORWARD' });
    });
  }

  if (rspeedBadge) {
    rspeedBadge.addEventListener('click', () => {
      let nextIdx = SPEED_STOPS.findIndex(s => Math.abs(s - currentSpeed) < 0.05) + 1;
      if (nextIdx >= SPEED_STOPS.length || nextIdx < 0) nextIdx = 0;
      currentSpeed = SPEED_STOPS[nextIdx];
      rspeedBadge.textContent = `${currentSpeed.toFixed(1)}x`;
      speedBadge.textContent = `${currentSpeed.toFixed(1)}x`;
      speedRangeEl.value = String(currentSpeed);
      speedDisplayEl.textContent = `${currentSpeed.toFixed(1)}×`;
      safeSendMessage({ action: 'SET_RATE', rate: currentSpeed });
    });
  }

  if (rprogressTrackEl) {
    let isRScrubbing = false;

    function handleRScrub(e) {
      if (currentSentenceRanges.length === 0) return;
      const rect = rprogressTrackEl.getBoundingClientRect();
      if (rect.width <= 0) return;
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const pct = x / rect.width;
      const total = currentSentenceRanges.length;
      if (total > 0) {
        const targetIndex = Math.min(total - 1, Math.floor(pct * total));
        if (targetIndex >= 0 && targetIndex !== currentSentenceIndex) {
          safeSendMessage({ action: 'JUMP_TO_INDEX', index: targetIndex });
          applyHighlight(targetIndex);
        }
      }
    }

    rprogressTrackEl.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      isRScrubbing = true;
      handleRScrub(e);

      const onMouseMove = (moveEv) => {
        if (isRScrubbing) handleRScrub(moveEv);
      };
      const onMouseUp = () => {
        isRScrubbing = false;
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });
  }

  // -----------------------------------------------------------------
  // 5. Article Extraction (Readability-guided) + Sentence Queue Builder
  // -----------------------------------------------------------------

  /**
   * Return all visible, substantive content elements inside a container.
   * Skips: hidden elements, very short text, nav/header/footer/aside,
   * Wikipedia toc/navbox/reflist, and our own player host.
   */
  function getContentElements(container) {
    const SKIP = [
      // Semantic regions that are never article text
      'nav', 'header', 'footer', 'aside',
      // ARIA landmarks
      '[role="navigation"]', '[role="banner"]',
      '[role="contentinfo"]', '[role="complementary"]',
      '[role="search"]',
      // Wikipedia-specific chrome
      '.navbox', '.toc', '.reference', '.reflist', '#toc', '.mw-empty-elt',
      // Generic ad / sidebar / cookie markers
      '.sidebar', '.widget', '.ad', '.ads', '.advertisement',
      '.cookie-banner', '.cookie-notice',
      // Common menu patterns
      '.menu', '#menu', '.nav', '#nav', '#navigation',
      // Related / promoted content boxes
      '.related', '.recommended', '.outbrain', '.taboola',
    ].join(', ');

    return Array.from(container.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption'))
      .filter(el => {
        if (host.contains(el)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;

        const text = el.textContent.trim();
        const tag = el.tagName.toLowerCase();
        // Figure captions get a much lower floor — short but valuable
        // ("Fig. 3: Yield response to N rate across four sites.")
        const isCaption = tag === 'figcaption';

        // Raised from 20 → 30 chars: kills short UI labels like "Michelin Guide rating"
        if (isCaption ? text.length < 10 : text.length < 30) return false;

        // For non-heading elements (p, li, blockquote): require ≥5 words.
        // UI labels like "Frequently mentioned in reviews" (4 words) are filtered;
        // real sentences like "French cuisine is served at Daniel." (6 words) pass.
        // Headings and captions are exempt — a section title like "Early life"
        // is legitimately short.
        if (!isCaption && !/^h[1-6]$/.test(tag)) {
          const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
          if (wordCount < 5) return false;
        }

        // Link-density guard: if > 60% of this element's text sits inside <a> tags
        // it is almost certainly a navigation list item, not prose.
        const linkCharCount = Array.from(el.querySelectorAll('a'))
          .reduce((sum, a) => sum + a.textContent.trim().length, 0);
        if (text.length > 0 && linkCharCount / text.length > 0.6) return false;

        if (el.closest(SKIP)) return false;
        return true;
      });
  }

  /**
   * Find the best set of article elements for this page using a three-stage cascade:
   *
   * Stage 1 — Exact container match: try well-known article wrappers in priority order.
   *           Returns immediately if ≥3 content blocks found.
   *
   * Stage 2 — Readability word-frequency filter: clone the document, run Mozilla
   *           Readability, build a set of "article words", then keep only real-page
   *           elements whose text is ≥65% present in that word set.
   *           Falls through if Readability fails or yields <3 elements.
   *
   * Stage 3 — Full-body fallback with the SKIP filter above.
   */
  function getArticleElements() {
    // --- Stage 1: well-known article containers ---
    const CONTAINERS = [
      '#mw-content-text',          // Wikipedia
      'article',
      '[role="main"]',
      'main',
      '.entry-content',            // WordPress
      '.post-content',
      '.article-body',
      '.article-content',
      '.story-body',
      '.story-content',
      '.post-body',
      '.td-post-content',          // TagDiv theme
      '#content .hentry',
      '#content',
    ];

    for (const sel of CONTAINERS) {
      try {
        const el = document.querySelector(sel);
        if (!el) continue;
        const blocks = getContentElements(el);
        if (blocks.length >= 3) {
          console.log(`[ReadAloud] Stage 1 match "${sel}" → ${blocks.length} blocks`);
          return blocks;
        }
      } catch (_) { /* malformed selector on some pages — skip */ }
    }

    // --- Stage 2: Readability word-frequency filter ---
    // Guard: skip Readability on very large documents where cloneNode(true)
    // would spike memory (>5 MB of raw HTML → likely 30 MB+ clone).
    const docSizeBytes = (document.documentElement.outerHTML || '').length * 2; // rough UTF-16
    const MAX_CLONE_BYTES = 5 * 1024 * 1024;
    if (typeof window.Readability !== 'undefined' && docSizeBytes <= MAX_CLONE_BYTES) {
      try {
        const docClone = document.cloneNode(true);
        // Strip our player and any script/style/media noise from the clone to prevent memory spikes
        docClone.getElementById('read-aloud-player-host')?.remove();
        docClone.querySelectorAll('script, style, noscript, iframe, img, video, audio, svg, canvas, object, embed').forEach(n => n.remove());

        const reader = new window.Readability(docClone, {
          charThreshold: 100,  // lower threshold so short articles still parse
          keepClasses: false,
        });
        const article = reader.parse();

        if (article && article.textContent && article.textContent.trim().length > 200) {
          // Build a set of meaningful words from Readability's clean text
          const articleWordSet = new Set(
            article.textContent
              .toLowerCase()
              .replace(/[^a-z0-9\s]/g, ' ')
              .split(/\s+/)
              .filter(w => w.length > 4)
          );

          const allBlocks = Array.from(
            document.body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, figcaption')
          ).filter(el => !host.contains(el));

          const articleBlocks = allBlocks.filter(el => {
            const text = el.textContent.trim();
            const isCaption = el.tagName.toLowerCase() === 'figcaption';
            // Match the tightened getContentElements rules (captions exempt)
            if (isCaption ? text.length < 10 : text.length < 30) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return false;

            const tag = el.tagName.toLowerCase();
            if (!isCaption && !/^h[1-6]$/.test(tag)) {
              const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
              if (wordCount < 5) return false;
            }

            // Link-density guard (same rule as getContentElements)
            const linkCharCount = Array.from(el.querySelectorAll('a'))
              .reduce((sum, a) => sum + a.textContent.trim().length, 0);
            if (text.length > 0 && linkCharCount / text.length > 0.6) return false;

            const words = text
              .toLowerCase()
              .replace(/[^a-z0-9\s]/g, ' ')
              .split(/\s+/)
              .filter(w => w.length > 4);
            if (words.length < 3) return false;

            const matched = words.filter(w => articleWordSet.has(w)).length;
            // Captions exempt from the word-overlap rule (they are dense with
            // short technical words); junk filters above still apply.
            if (el.tagName.toLowerCase() === 'figcaption') return true;
            // Raised from 65% → 72%: fewer false positives on listing/review pages
            return (matched / words.length) >= 0.72;
          });

          if (articleBlocks.length >= 3) {
            console.log(
              `[ReadAloud] Stage 2 Readability: kept ${articleBlocks.length}/${allBlocks.length} blocks` +
              ` (article: "${article.title?.substring(0, 40)}")`
            );
            return articleBlocks;
          }
        }
      } catch (err) {
        console.warn('[ReadAloud] Stage 2 Readability extraction failed:', err.message);
      }
    }

    // --- Stage 3: full-body fallback ---
    const fallback = getContentElements(document.body);
    console.log(`[ReadAloud] Stage 3 fallback → ${fallback.length} blocks from document.body`);
    return fallback;
  }

  /**
   * Drop everything from a References/Bibliography heading onward — having
   * citation lists read aloud is almost never wanted. Operates on the
   * extracted element list, preserving document order.
   */
  function cutAtReferences(elements) {
    const RE = /^(references|reference\s+list|literature\s+cited|bibliography|works\s+cited)$/i;
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (/^h[1-6]$/.test(tag) && RE.test(el.textContent.trim())) {
        console.log('[ReadAloud] Stopping extraction at references heading.');
        return elements.slice(0, i);
      }
    }
    return elements;
  }

  /**
   * Build the sentence queue for playback.
   * Returns an array of { index, text } objects sent to the background worker.
   * Also populates currentSentenceRanges for highlighting.
   *
   * If there is an active text selection, only that selection is queued.
   * Otherwise, getArticleElements() determines what to read.
   */
  function buildPlaybackQueue() {
    currentSentenceRanges = [];
    rangeMapAttempted = false;

    // --- Text selection takes priority ---
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && selection.toString().trim().length > 0) {
      const selectedText = selection.toString().trim();
      const rawSentences = splitIntoChunks(selectedText);
      const selectedRange = selection.getRangeAt(0);
      const containerNode =
        selectedRange.commonAncestorContainer.nodeType === Node.TEXT_NODE
          ? selectedRange.commonAncestorContainer.parentNode
          : selectedRange.commonAncestorContainer;

      const ranges = findRangesInElement(containerNode, rawSentences.map(s => s.text));
      if (ranges.length > 0) {
        currentSentenceRanges = ranges.map((r, idx) => ({ index: idx, text: r.text, range: r.range }));
      } else {
        // Fallback: single range covering the whole selection
        currentSentenceRanges = [{ index: 0, text: selectedText, range: selectedRange.cloneRange() }];
      }
      rangeMapAttempted = currentSentenceRanges.length === 0;
      console.log(`[ReadAloud] Reading selection: ${currentSentenceRanges.length} sentence(s)`);
      return currentSentenceRanges.map(item => ({ index: item.index, text: item.text }));
    }

    // --- Full article extraction ---
    const elements = cutAtReferences(getArticleElements());
    const allQueueSentences = [];

    for (const el of elements) {
      const elText = el.textContent.trim();
      if (elText.length === 0) continue;

      const rawSentences = splitIntoChunks(elText);
      if (rawSentences.length === 0) continue;

      const matchedRanges = findRangesInElement(el, rawSentences.map(s => s.text));
      for (const item of matchedRanges) {
        const idx = allQueueSentences.length;
        allQueueSentences.push({ index: idx, text: item.text });
        currentSentenceRanges.push({ index: idx, text: item.text, range: item.range, element: el });
      }
    }

    rangeMapAttempted = currentSentenceRanges.length === 0;
    console.log(`[ReadAloud] Queue built: ${allQueueSentences.length} sentences from ${elements.length} blocks`);
    return allQueueSentences;
  }

  // -----------------------------------------------------------------
  // 6. Player Control Handlers
  // -----------------------------------------------------------------
  playBtn.addEventListener('click', () => {
    // If user has actively selected text, always start reading the new selection immediately!
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) {
      const sentences = buildPlaybackQueue();
      if (sentences && sentences.length > 0) {
        safeSendMessage({
          action: 'START_PLAYBACK',
          sentences,
          startIndex: 0,
          options: { rate: currentSpeed }
        });
        return;
      }
    }

    if (currentPlaybackState === 'PLAYING') {
      safeSendMessage({ action: 'PAUSE_PLAYBACK' });
    } else if (currentPlaybackState === 'PAUSED') {
      safeSendMessage({ action: 'RESUME_PLAYBACK' });
    } else {
      const sentences = buildPlaybackQueue();
      if (!sentences || sentences.length === 0) {
        showToast('No readable text found on this page.');
        return;
      }
      safeSendMessage({
        action: 'START_PLAYBACK',
        sentences,
        startIndex: 0,
        options: { rate: currentSpeed }
      });
    }
  });

  prevBtn.addEventListener('click', () => {
    safeSendMessage({ action: 'SKIP_BACKWARD' });
  });

  nextBtn.addEventListener('click', () => {
    safeSendMessage({ action: 'SKIP_FORWARD' });
  });

  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      clearHighlight();
      safeSendMessage({ action: 'STOP_PLAYBACK' });
    });
  }

  const settingsReaderBtn = shadow.getElementById('ra-settings-reader');
  if (settingsReaderBtn) {
    settingsReaderBtn.addEventListener('click', () => {
      closeSettings();
      toggleReaderView();
    });
  }

  const settingsStopBtn = shadow.getElementById('ra-settings-stop');
  if (settingsStopBtn) {
    settingsStopBtn.addEventListener('click', () => {
      closeSettings();
      clearHighlight();
      safeSendMessage({ action: 'STOP_PLAYBACK' });
    });
  }

  const SPEED_STOPS = [0.8, 1.0, 1.2, 1.5, 2.0];
  speedBadge.addEventListener('click', () => {
    let nextIdx = SPEED_STOPS.findIndex(s => Math.abs(s - currentSpeed) < 0.05) + 1;
    if (nextIdx >= SPEED_STOPS.length || nextIdx < 0) nextIdx = 0;
    currentSpeed = SPEED_STOPS[nextIdx];
    speedBadge.textContent = `${currentSpeed.toFixed(1)}x`;
    // Keep settings slider in sync with pill badge
    speedRangeEl.value = String(currentSpeed);
    speedDisplayEl.textContent = `${currentSpeed.toFixed(1)}×`;
    safeSendMessage({ action: 'SET_RATE', rate: currentSpeed });
  });

  collapseBtn.addEventListener('click', () => {
    applyCollapsedState(!isCollapsed);
  });

  // -----------------------------------------------------------------
  // 7. Draggable Mechanics & Magnetic Edge Snapping
  // -----------------------------------------------------------------
  let isDragging = false;
  let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;
  let isDocked = false;
  let dockedEdge = null; // 'left' | 'right'
  tuckTimer = null; // declaration hoisted above IIFE for TDZ safety

  function scheduleTuck(delayMs = 2500) {
    if (tuckTimer) clearTimeout(tuckTimer);
    if (!isDocked) return;
    tuckTimer = setTimeout(() => {
      if (container.matches(':hover') || isSettingsOpen || isDragging) return;
      container.classList.add('is-tucked', 'beaded');
    }, delayMs);
  }

  function untuck() {
    if (tuckTimer) clearTimeout(tuckTimer);
    container.classList.remove('is-tucked', 'beaded');
  }

  function dockToEdge(edge, topY, asBead = false) {
    isDocked = true;
    dockedEdge = edge;
    container.classList.remove('is-docked-left', 'is-docked-right', 'is-tucked', 'beaded', 'snap-guide-left', 'snap-guide-right');
    container.classList.add(edge === 'left' ? 'is-docked-left' : 'is-docked-right');
    if (asBead) {
      container.classList.add('beaded');
    }

    const chevron = shadow.getElementById('ra-edge-chevron');
    if (chevron) {
      chevron.textContent = edge === 'left' ? '›' : '‹';
    }

    const rect = container.getBoundingClientRect();
    const clampedTop = Math.max(10, Math.min(topY, window.innerHeight - rect.height - 10));
    container.style.top = `${toLocal(clampedTop)}px`;
    container.style.bottom = 'auto';

    if (edge === 'left') {
      container.style.left = '0px';
      container.style.right = 'auto';
    } else {
      container.style.left = 'auto';
      container.style.right = '0px';
    }

    if (!asBead) {
      scheduleTuck(2000);
    }

    safeStorageSet({
      readAloud_dockState: { isDocked: true, edge, top: clampedTop, isBead: asBead }
    });
  }

  function undockFromEdge(leftX, topY) {
    isDocked = false;
    dockedEdge = null;
    if (tuckTimer) clearTimeout(tuckTimer);
    container.classList.remove('is-docked-left', 'is-docked-right', 'is-tucked', 'beaded', 'snap-guide-left', 'snap-guide-right');

    const rect = container.getBoundingClientRect();
    const clampedLeft = Math.max(10, Math.min(leftX, window.innerWidth - rect.width - 10));
    const clampedTop = Math.max(10, Math.min(topY, window.innerHeight - rect.height - 10));

    container.style.left = `${toLocal(clampedLeft)}px`;
    container.style.top = `${toLocal(clampedTop)}px`;
    container.style.right = 'auto';
    container.style.bottom = 'auto';

    setActivePosBtn(clampedLeft, clampedTop);

    safeStorageSet({
      readAloud_dockState: { isDocked: false },
      readAloud_playerPosition: { left: clampedLeft, top: clampedTop }
    });
  }

  // Hover expansion and auto-tuck on leave
  container.addEventListener('mouseenter', () => {
    if (container.classList.contains('beaded')) {
      container.classList.remove('beaded');
    }
    if (isDocked) untuck();
  });

  container.addEventListener('mouseleave', () => {
    if (isDocked && !isDragging) scheduleTuck(2500);
  });

  // Clicking a tucked tab or collapsed handle expands it immediately
  container.addEventListener('click', (e) => {
    if (container.classList.contains('beaded')) {
      container.classList.remove('beaded');
      e.stopPropagation();
      return;
    }
    if (isCollapsed) {
      applyCollapsedState(false);
      e.stopPropagation();
      return;
    }
    if (isDocked && container.classList.contains('is-tucked')) {
      untuck();
    }
  });

  /**
   * Convert a viewport (visual) length into the pill's own zoomed style space.
   * `zoom` scales the element's layout, so style.left/style.top are expressed
   * in unzoomed local units while getBoundingClientRect() reports viewport px.
   */
  function toLocal(px) {
    return px / (pillZoom || 1);
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    if (isCollapsed) {
      applyCollapsedState(false);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.target.closest('button') || e.target.closest('.speed-badge') || e.target.closest('#ra-progress-track')) return;

    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;

    untuck();

    const rect = container.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;

    // Convert to the pill's local space, otherwise the pill jumps on grab
    // whenever the size slider is away from 100%.
    container.style.left = `${toLocal(initialLeft)}px`;
    container.style.top = `${toLocal(initialTop)}px`;
    container.style.right = 'auto';
    container.style.bottom = 'auto';

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    e.preventDefault();
  }

  function onMouseMove(e) {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    // If currently docked and user moved inward away from the edge, break docking
    if (isDocked && (Math.abs(dx) > 25 || Math.abs(dy) > 25)) {
      container.classList.remove('is-docked-left', 'is-docked-right', 'is-tucked');
      isDocked = false;
    }

    const rect = container.getBoundingClientRect();
    const pad = 2;
    const maxLeft = window.innerWidth - rect.width - pad;
    const maxTop = window.innerHeight - rect.height - pad;

    const newLeft = Math.max(pad, Math.min(initialLeft + dx, maxLeft));
    const newTop = Math.max(pad, Math.min(initialTop + dy, maxTop));

    // Magnetic snap guide threshold (< 20px proximity to edge)
    const BEAD_SNAP_THRESHOLD = 20;
    const isNearLeft = newLeft <= BEAD_SNAP_THRESHOLD;
    const isNearRight = (window.innerWidth - (newLeft + rect.width)) <= BEAD_SNAP_THRESHOLD;

    container.classList.toggle('snap-guide-left', isNearLeft);
    container.classList.toggle('snap-guide-right', isNearRight);

    container.style.left = `${toLocal(newLeft)}px`;
    container.style.top = `${toLocal(newTop)}px`;
  }

  function onMouseUp() {
    if (!isDragging) return;
    isDragging = false;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);

    container.classList.remove('snap-guide-left', 'snap-guide-right');

    const rect = container.getBoundingClientRect();
    const BEAD_SNAP_THRESHOLD = 20;
    const isNearLeft = rect.left <= BEAD_SNAP_THRESHOLD;
    const isNearRight = (window.innerWidth - rect.right) <= BEAD_SNAP_THRESHOLD;

    if (isNearLeft) {
      dockToEdge('left', rect.top, true);
    } else if (isNearRight) {
      dockToEdge('right', rect.top, true);
    } else {
      undockFromEdge(rect.left, rect.top);
    }

    if (isSettingsOpen) positionSettingsPanel();
  }

  container.addEventListener('mousedown', onMouseDown);

  safeStorageGet(['readAloud_dockState', 'readAloud_playerPosition'], (res) => {
    const dock = res?.readAloud_dockState;
    if (dock && dock.isDocked) {
      const topY = typeof dock.top === 'number' ? dock.top : (window.innerHeight - 80);
      dockToEdge(dock.edge || 'right', topY, Boolean(dock.isBead));
    } else {
      const pos = res?.readAloud_playerPosition;
      if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
        const pad = 10;
        const maxLeft = window.innerWidth - 150;
        const maxTop = window.innerHeight - 50;
        if (pos.left >= 0 && pos.left <= maxLeft && pos.top >= 0 && pos.top <= maxTop) {
          container.style.left = `${toLocal(pos.left)}px`;
          container.style.top = `${toLocal(pos.top)}px`;
          container.style.right = 'auto';
          container.style.bottom = 'auto';
          setActivePosBtn(pos.left, pos.top);
        } else {
          const r = container.getBoundingClientRect();
          setActivePosBtn(r.left, r.top);
        }
      } else {
        const r = container.getBoundingClientRect();
        setActivePosBtn(r.left, r.top);
      }
    }
  });

  // -----------------------------------------------------------------
  // 7b. Paragraph Hover-to-Play (Speechify-style)
  // -----------------------------------------------------------------
  let currentHoverBlock = null;
  let hoverDwellTimer = null;
  let hoverHideTimeout = null;
  let isMouseOverHoverButton = false;

  // -----------------------------------------------------------------
  // 7b. Speechify-Style Text Selection Tooltip (Highlight-to-Read)
  // -----------------------------------------------------------------
  function positionSelectionTooltip() {
    if (!selectionTooltipEnabled) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      hideSelectionTooltip();
      return;
    }

    const text = sel.toString().trim();
    if (text.length < 3) {
      hideSelectionTooltip();
      return;
    }

    try {
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        hideSelectionTooltip();
        return;
      }

      // Center horizontally over the selection, clamped within the viewport
      const btnW = 86;
      let left = rect.left + (rect.width / 2) - (btnW / 2);
      left = Math.max(8, Math.min(left, window.innerWidth - btnW - 8));

      // Prefer placing 28px above the top of the selection; flip below if too close to viewport top
      let top = rect.top - 28;
      if (top < 10) {
        top = rect.bottom + 6;
      }

      selectionPlayBtn.style.left = `${Math.round(left)}px`;
      selectionPlayBtn.style.top = `${Math.round(top)}px`;
      selectionPlayBtn.classList.add('visible');
    } catch (_) {
      hideSelectionTooltip();
    }
  }

  function hideSelectionTooltip() {
    selectionPlayBtn.classList.remove('visible');
  }

  // Trigger selection tooltip on mouseup after highlighting text
  document.addEventListener('mouseup', (e) => {
    if (host.contains(e.target)) return;
    setTimeout(() => {
      positionSelectionTooltip();
    }, 20);
  });

  // Hide selection tooltip when clicking anywhere else
  document.addEventListener('mousedown', (e) => {
    if (host.contains(e.target)) return;
    hideSelectionTooltip();
  });

  // Click on selection play button to read selected text
  selectionPlayBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    hideSelectionTooltip();
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) {
      const sentences = buildPlaybackQueue();
      if (sentences && sentences.length > 0) {
        safeSendMessage({
          action: 'START_PLAYBACK',
          sentences,
          startIndex: 0,
          options: { rate: currentSpeed }
        });
      }
    }
  });

  // -----------------------------------------------------------------
  // 7c. Speechify-Style Paragraph Gutter Play Button (Calm, Stationary)
  // -----------------------------------------------------------------

  /**
   * Find the paragraph-ish block the cursor is hovering over.
   *
   * Two paths:
   *  1. Fast path — the cursor is inside a genuine <p>/<blockquote>
   *     (classic articles).
   *  2. Generic path — social media & app-style sites (Medium, Reddit, X,
   *     Notion, docs sites…) put body text in plain <div>/<span> blocks with
   *     no <p> anywhere, so path 1 never fires there and the button appeared
   *     on some pages only. Climb from the hovered node to the DEEPEST
   *     ancestor holding substantive text: that tightest block is the
   *     "paragraph" the user perceives.
   *
   * Either way: never match headers, table cells, form fields, navigation,
   * or link-dense (nav-like) blocks.
   */
  function findEligibleParagraph(node) {
    if (!node || node === document.body || node === document.documentElement) return null;
    if (host.contains(node)) return null;

    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!el || host.contains(el)) return null;

    const SKIP = 'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], .navbox, .toc, .reflist, #toc, form, input, textarea, button';

    // Shared substantive-prose test for both paths.
    const isEligibleBlock = (block) => {
      if (!block || host.contains(block)) return false;
      if (block.closest(SKIP)) return false;
      const style = window.getComputedStyle(block);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const text = block.textContent.trim();
      // Substantive prose: 40 chars / 6 words (was 60 / 8). Social-media posts
      // are routinely shorter than article paragraphs, and a slightly noisier
      // hover button is harmless — it only shows after a 350 ms dwell.
      if (text.length < 40) return false;
      if (text.split(/\s+/).filter(w => w.length > 0).length < 6) return false;
      // Link-density guard (same rule as article extraction): >60% of the text
      // inside <a> tags means navigation, not prose.
      const linkChars = Array.from(block.querySelectorAll('a'))
        .reduce((sum, a) => sum + a.textContent.trim().length, 0);
      if (text.length > 0 && linkChars / text.length > 0.6) return false;
      return true;
    };

    // Fast path: genuine <p>/<blockquote> under the cursor.
    const para = el.closest('p, blockquote');
    if (para && isEligibleBlock(para)) return para;

    // Generic path: deepest ancestor with paragraph-scale substantive text.
    const MIN_BLOCK_CHARS = 40;    // short posts are readable too
    const MAX_BLOCK_CHARS = 3000;  // paragraph/post scale, not article scale
    let candidate = el;
    while (candidate && candidate !== document.body && candidate.nodeType === Node.ELEMENT_NODE) {
      const text = candidate.textContent.trim();
      if (text.length >= MIN_BLOCK_CHARS) {
        // First (deepest) ancestor past the threshold wins. If even that one is
        // container-scale, every ancestor above it is bigger — no button.
        if (text.length <= MAX_BLOCK_CHARS && isEligibleBlock(candidate)) {
          return candidate;
        }
        return null;
      }
      candidate = candidate.parentElement;
    }
    return null;
  }

  /**
   * Position the play button INSIDE the paragraph's left edge, vertically
   * aligned with the line the cursor is actually hovering.
   *
   * Placement rules:
   *  - Horizontal: always just inside the block's left edge. It overlays the
   *    first characters of the hovered line, so it renders semi-transparent
   *    until the pointer is on it (see .hover-play-btn.visible).
   *  - Vertical: the hovered line (pointer Y), clamped INSIDE the block — the
   *    button appears beside the text being read, not up at a comment header
   *    or the block top.
   *  - Never directly under the pointer. A button that pops up under the mouse
   *    steals the hover (the page sees mouseout -> shadow host), the paragraph
   *    looks abandoned, the button hides and re-shows — a flicker loop. If a
   *    placement lands under the pointer it is nudged one line away ONCE, at
   *    placement time; it never chases the cursor afterwards.
   */
  function positionHoverPlayBtn(block, pointerX, pointerY) {
    if (!hoverToPlayEnabled || currentPlaybackState === 'PLAYING') return;
    if (!block || !block.isConnected) return;
    const rect = block.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const BTN = 26; // keep in sync with .hover-play-btn width/height in CSS

    // Vertical: the hovered line, clamped inside the block.
    let top;
    if (typeof pointerY === 'number' && Number.isFinite(pointerY)) {
      top = pointerY - BTN / 2;
    } else {
      top = rect.top + 2;
    }
    top = Math.max(rect.top, Math.min(top, rect.bottom - BTN));
    top = Math.max(8, Math.min(top, window.innerHeight - BTN - 8));

    // Horizontal: inside the block's left edge.
    let left = rect.left + 6;
    left = Math.max(4, Math.min(left, window.innerWidth - BTN - 4));

    // One-time nudge if parked directly under the pointer.
    if (typeof pointerX === 'number' && Number.isFinite(pointerX) &&
        typeof pointerY === 'number' && Number.isFinite(pointerY)) {
      const cx = left + BTN / 2;
      const cy = top + BTN / 2;
      if (Math.abs(pointerX - cx) < BTN && Math.abs(pointerY - cy) < BTN) {
        const roomBelow = rect.bottom - (top + BTN) >= BTN + 6;
        top += roomBelow ? (BTN + 6) : -(BTN + 6);
        top = Math.max(8, Math.min(top, window.innerHeight - BTN - 8));
      }
    }

    hoverPlayBtn.style.left = `${Math.round(left)}px`;
    hoverPlayBtn.style.top = `${Math.round(top)}px`;
    hoverPlayBtn.classList.add('visible');
    currentHoverBlock = block;
  }

  function hideHoverPlayBtn() {
    hoverPlayBtn.classList.remove('visible');
    currentHoverBlock = null;
    if (hoverDwellTimer) {
      clearTimeout(hoverDwellTimer);
      hoverDwellTimer = null;
    }
  }

  /**
   * Start playback from a given paragraph element immediately.
   */
  function playFromElement(targetEl) {
    if (!targetEl) return;

    let queue = currentSentenceRanges;
    if (!queue || queue.length === 0) {
      buildPlaybackQueue();
      queue = currentSentenceRanges;
    }

    let targetIndex = -1;

    if (queue && queue.length > 0) {
      targetIndex = queue.findIndex(item =>
        item.element === targetEl ||
        targetEl.contains(item.element) ||
        (item.element && item.element.contains(targetEl))
      );
    }

    if (targetIndex === -1 && queue && queue.length > 0) {
      const targetText = targetEl.textContent.trim().toLowerCase();
      targetIndex = queue.findIndex(item => {
        const itemText = item.text.trim().toLowerCase();
        return targetText.includes(itemText.substring(0, Math.min(30, itemText.length)));
      });
    }

    if (targetIndex !== -1) {
      console.log(`[ReadAloud] Playing from clicked paragraph, sentence #${targetIndex + 1}`);

      safeSendMessage({
        action: 'START_PLAYBACK',
        sentences: queue.map(item => ({ index: item.index, text: item.text })),
        startIndex: targetIndex,
        options: { rate: currentSpeed }
      });

      applyHighlight(targetIndex);
      hideHoverPlayBtn();
    } else {
      const rawSentences = splitIntoChunks(targetEl.textContent.trim());
      if (rawSentences.length > 0) {
        currentSentenceRanges = findRangesInElement(targetEl, rawSentences.map(s => s.text));
        safeSendMessage({
          action: 'START_PLAYBACK',
          sentences: rawSentences,
          startIndex: 0,
          options: { rate: currentSpeed }
        });
        applyHighlight(0);
        hideHoverPlayBtn();
      }
    }
  }

  // Mousemove with 350ms dwell timer: does NOT track cursor or jump around
  //
  // The paragraph lookup calls getComputedStyle() (forces a style recalc) and
  // reads textContent (allocates a copy of the paragraph). Doing that on every
  // mousemove event — up to ~120 Hz — is the most expensive thing this content
  // script does on a heavy page, so the lookup is throttled to ~60ms. The 350ms
  // dwell timer already hides any perceptible lag.
  let hoverThrottleTimer = null;
  let hoverPendingTarget = null;

  function resolveHoverTarget(target, pointerX, pointerY) {
    // Bail out if the page state changed while we were throttled.
    if (!hoverToPlayEnabled || currentPlaybackState === 'PLAYING') {
      if (currentHoverBlock) hideHoverPlayBtn();
      return;
    }
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      hideHoverPlayBtn();
      return;
    }

    // SPA content swap: the block we anchored to is gone — start over.
    if (currentHoverBlock && !currentHoverBlock.isConnected) {
      hideHoverPlayBtn();
    }

    // STICKINESS: once the button is showing for a block it does not move
    // again while the cursor stays within that block. The block finder, run
    // from a different child node at a different pixel, would otherwise
    // return a narrower inner block or a wider outer one, and the button
    // would hop between them — on nested markup (a comment body inside a
    // comment container) it fled the pointer and could never be clicked.
    if (currentHoverBlock && currentHoverBlock.contains(target)) {
      clearTimeout(hoverHideTimeout);
      return;
    }

    const block = findEligibleParagraph(target);

    // Same reading unit at a different nesting depth (e.g. comment text vs.
    // the whole comment incl. its name row) — keep the button parked.
    if (block && currentHoverBlock &&
        (block === currentHoverBlock ||
         block.contains(currentHoverBlock) ||
         currentHoverBlock.contains(block))) {
      clearTimeout(hoverHideTimeout);
      return;
    }

    // Cancel pending dwell on moving away
    if (hoverDwellTimer) {
      clearTimeout(hoverDwellTimer);
      hoverDwellTimer = null;
    }

    if (!block) {
      // Grace period before hiding so the cursor can reach the button
      clearTimeout(hoverHideTimeout);
      hoverHideTimeout = setTimeout(() => {
        if (!isMouseOverHoverButton) {
          hideHoverPlayBtn();
        }
      }, 300);
      return;
    }

    // Cursor entered a new eligible paragraph: dwell for 350ms before showing.
    // Casual cursor movements across the screen will never trigger it.
    // Pointer coords are captured NOW so placement uses the line the user
    // was actually hovering when the dwell began.
    clearTimeout(hoverHideTimeout);
    hoverDwellTimer = setTimeout(() => {
      hoverDwellTimer = null;
      // The cursor may have moved on during the 350 ms dwell — only show the
      // button if it is still over the same block.
      const now = hoverPendingTarget;
      if (now && now.target && !block.contains(now.target)) return;
      positionHoverPlayBtn(block, pointerX, pointerY);
    }, 350);
  }

  document.addEventListener('mousemove', (e) => {
    if (!hoverToPlayEnabled || currentPlaybackState === 'PLAYING') {
      if (currentHoverBlock) hideHoverPlayBtn();
      return;
    }
    if (host.contains(e.target) || isMouseOverHoverButton) {
      // Pointer moved onto our own UI — cancel any pending dwell so the
      // button does not pop up for a block the cursor has already left.
      if (hoverDwellTimer) {
        clearTimeout(hoverDwellTimer);
        hoverDwellTimer = null;
      }
      return;
    }

    // Suppress while user is selecting text. isCollapsed is O(1); toString()
    // would copy the entire selection on every event.
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      hideHoverPlayBtn();
      return;
    }

    // Throttle the expensive paragraph resolution. The payload always holds
    // the NEWEST pointer position so the dwell timer can re-check that the
    // cursor is still over the same block when it fires.
    hoverPendingTarget = { target: e.target, x: e.clientX, y: e.clientY };
    if (hoverThrottleTimer) return;
    hoverThrottleTimer = setTimeout(() => {
      hoverThrottleTimer = null;
      const pending = hoverPendingTarget;
      if (pending) resolveHoverTarget(pending.target, pending.x, pending.y);
    }, 60);
  }, { passive: true });

  document.addEventListener('mouseout', (e) => {
    if (!hoverToPlayEnabled) return;
    if (isMouseOverHoverButton || host.contains(e.target)) return;

    // Departures that stay INSIDE the shown block (moving between its child
    // nodes) must not hide the button — without this the button vanished
    // whenever the cursor paused ~300 ms mid-paragraph, right before the user
    // tried to click it. Moving onto the button itself retargets to the
    // shadow host, which counts as "staying" too.
    const to = e.relatedTarget;
    if (currentHoverBlock && to &&
        (currentHoverBlock.contains(to) || to === host || host.contains(to))) {
      clearTimeout(hoverHideTimeout);
      return;
    }

    clearTimeout(hoverHideTimeout);
    hoverHideTimeout = setTimeout(() => {
      if (!isMouseOverHoverButton) {
        hideHoverPlayBtn();
      }
    }, 300);
  }, { passive: true });

  hoverPlayBtn.addEventListener('mouseenter', () => {
    isMouseOverHoverButton = true;
    clearTimeout(hoverHideTimeout);
  });

  hoverPlayBtn.addEventListener('mouseleave', () => {
    isMouseOverHoverButton = false;
    clearTimeout(hoverHideTimeout);
    hoverHideTimeout = setTimeout(hideHoverPlayBtn, 300);
  });

  // Click on hover button to play from this paragraph
  hoverPlayBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (currentHoverBlock) {
      playFromElement(currentHoverBlock);
    }
  });

  // Alt + Click on any paragraph directly jumps/plays from there
  document.addEventListener('click', (e) => {
    if (e.altKey && !host.contains(e.target)) {
      const block = findEligibleParagraph(e.target);
      if (block) {
        e.preventDefault();
        e.stopPropagation();
        playFromElement(block);
      }
    }
  }, { capture: true });

  // ── Speechify Tap-to-Listen / Click-to-Jump ────────────────────────
  // When playback is active (PLAYING or PAUSED), clicking any article text jumps reading to that sentence
  document.addEventListener('click', (e) => {
    if (host.contains(e.target)) return;
    if (currentPlaybackState !== 'PLAYING' && currentPlaybackState !== 'PAUSED') return;
    if (e.defaultPrevented || e.button !== 0 || e.altKey) return;
    if (e.target.closest('a, button, input, textarea, select, [contenteditable="true"]')) return;

    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) return;

    let clickedNode = null;
    let clickedOffset = 0;

    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
      if (pos) {
        clickedNode = pos.offsetNode;
        clickedOffset = pos.offset;
      }
    } else if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (range) {
        clickedNode = range.startContainer;
        clickedOffset = range.startOffset;
      }
    }

    let targetIndex = -1;

    if (clickedNode && currentSentenceRanges.length > 0) {
      targetIndex = currentSentenceRanges.findIndex(item => {
        if (!item.range) return false;
        try {
          return item.range.isPointInRange(clickedNode, clickedOffset);
        } catch (_) {
          return false;
        }
      });
    }

    if (targetIndex === -1 && currentSentenceRanges.length > 0) {
      const el = e.target.nodeType === Node.ELEMENT_NODE ? e.target : e.target.parentElement;
      const block = el ? el.closest('p, h1, h2, h3, h4, h5, h6, li, blockquote') : null;
      if (block) {
        targetIndex = currentSentenceRanges.findIndex(item =>
          item.element === block || (item.range && block.contains(item.range.commonAncestorContainer))
        );
      }
    }

    if (targetIndex !== -1 && targetIndex !== currentSentenceIndex) {
      console.log(`[ReadAloud] Tap-to-listen jumped to sentence #${targetIndex + 1}`);
      safeSendMessage({ action: 'JUMP_TO_INDEX', index: targetIndex });
      applyHighlight(targetIndex);
    }
  });

  // Track right-clicked element for "Read from here" context menu action
  let lastContextMenuTarget = null;
  document.addEventListener('contextmenu', (e) => {
    if (!host.contains(e.target)) {
      lastContextMenuTarget = e.target;
    }
  }, { capture: true });

  // ── Reading Position Memory per URL ────────────────────────────────
  function saveReadingProgress(index, total) {
    if (index <= 0 || !total) return;
    const urlKey = location.origin + location.pathname;
    safeStorageGet(['readAloud_readingHistory'], (res) => {
      const history = res?.readAloud_readingHistory || {};
      history[urlKey] = {
        index,
        total,
        title: document.title || 'Untitled',
        timestamp: Date.now()
      };
      const keys = Object.keys(history);
      if (keys.length > 50) {
        keys.sort((a, b) => (history[a].timestamp || 0) - (history[b].timestamp || 0));
        for (let i = 0; i < keys.length - 50; i++) {
          delete history[keys[i]];
        }
      }
      safeStorageSet({ readAloud_readingHistory: history });
    });
  }

  function checkResumeProgress() {
    const urlKey = location.origin + location.pathname;
    safeStorageGet(['readAloud_readingHistory'], (res) => {
      const record = res?.readAloud_readingHistory?.[urlKey];
      if (record && typeof record.index === 'number' && record.index > 0 && record.index < record.total - 1) {
        const toast = shadow.getElementById('ra-resume-toast');
        const text = shadow.getElementById('ra-resume-text');
        if (toast && text) {
          text.textContent = `Resume at sentence ${record.index + 1}/${record.total}?`;
          toast.classList.add('visible');

          const resumeBtn = shadow.getElementById('ra-resume-btn');
          const resumeClose = shadow.getElementById('ra-resume-close');

          const onResumeClick = () => {
            toast.classList.remove('visible');
            const sentences = buildPlaybackQueue();
            if (sentences && sentences.length > 0) {
              const safeIdx = Math.min(record.index, sentences.length - 1);
              safeSendMessage({
                action: 'START_PLAYBACK',
                sentences,
                startIndex: safeIdx,
                options: { rate: currentSpeed, volume: currentVolume }
              });
            }
          };

          const onCloseClick = () => {
            toast.classList.remove('visible');
          };

          resumeBtn?.addEventListener('click', onResumeClick, { once: true });
          resumeClose?.addEventListener('click', onCloseClick, { once: true });
        }
      }
    });
  }

  // Reposition floating word box and hide tooltips on window scroll or resize
  window.addEventListener('scroll', () => {
    if (activeWordRange) {
      updateWordBoxPosition();
    }
    if (hoverPlayBtn.classList.contains('visible')) {
      hideHoverPlayBtn();
    }
    if (selectionPlayBtn.classList.contains('visible')) {
      hideSelectionTooltip();
    }
  }, { passive: true });

  window.addEventListener('resize', () => {
    if (activeWordRange) {
      updateWordBoxPosition();
    }
    if (hoverPlayBtn.classList.contains('visible')) {
      hideHoverPlayBtn();
    }
    if (selectionPlayBtn.classList.contains('visible')) {
      hideSelectionTooltip();
    }
    // Keep the open settings panel clamped to the new viewport.
    if (isSettingsOpen) {
      positionSettingsPanel();
    }
  }, { passive: true });

  // -----------------------------------------------------------------
  // 7d. SPA Soft Navigation Detection
  // -----------------------------------------------------------------
  // On pushState/replaceState-driven page changes the content script stays
  // alive but the DOM is replaced. Invalidate stale ranges and stop playback
  // so dead highlights don't throw and the user isn't stuck hearing the old page.
  let _lastHref = location.href;
  let _lastRoute = location.pathname + location.search;
  let _spaTimer = null;

  function onSPANavigation() {
    // Routers fire several history calls in a burst (redirect + URL
    // normalisation + query sync). Coalesce them into one pass so we react to
    // the final URL instead of to every intermediate one.
    if (_spaTimer) clearTimeout(_spaTimer);
    _spaTimer = setTimeout(() => {
      _spaTimer = null;
      handleSPANavigation();
    }, 150);
  }

  function handleSPANavigation() {
    if (location.href === _lastHref) return;
    const newRoute = location.pathname + location.search;
    const routeChanged = newRoute !== _lastRoute;
    _lastHref = location.href;
    _lastRoute = newRoute;

    // The nodes our ranges pointed at are gone either way — drop the stale
    // ranges so the Highlight API is never handed a detached range.
    currentSentenceRanges = [];
    rangeMapAttempted = false;
    currentSentenceIndex = -1;
    currentSentenceText = '';
    clearHighlight();
    hideHoverPlayBtn();
    hideSelectionTooltip();

    if (!routeChanged) {
      // Hash-only change (in-page anchor): the document is the same, so there
      // is no reason to interrupt the reading.
      return;
    }

    console.log('[ReadAloud] SPA navigation detected — clearing stale state.');
    stopMutationObserver();
    stopHeartbeat();
    // Tell the background to stop; it will broadcast PLAYBACK_STOPPED
    // back to us, resetting the pill UI.
    safeSendMessage({ action: 'STOP_PLAYBACK' });
  }

  window.addEventListener('popstate', onSPANavigation);

  // Chrome 102+ Navigation API (fires in isolated world on page pushState/replaceState!)
  if (typeof window.navigation !== 'undefined' && window.navigation.addEventListener) {
    window.navigation.addEventListener('navigate', () => {
      setTimeout(onSPANavigation, 0);
    });
  }

  // Intercept pushState/replaceState directly if called in this context
  try {
    const _origPush = history.pushState.bind(history);
    const _origReplace = history.replaceState.bind(history);
    history.pushState = function (...args) { _origPush(...args); onSPANavigation(); };
    history.replaceState = function (...args) { _origReplace(...args); onSPANavigation(); };
  } catch (_) { /* sandboxed iframe — ignore */ }

  // Clean up timers & observers on page unload / tab discard
  window.addEventListener('pagehide', () => {
    stopHeartbeat();
    stopMutationObserver();
    clearHighlight();
    hideHoverPlayBtn();
    hideSelectionTooltip();
  }, { passive: true });

  // -----------------------------------------------------------------
  // 7c. In-Page Keyboard Shortcuts (Intercepts Alt+Left/Right & Alt+P/X)
  // -----------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    // Escape closes focus reader overlay
    if (e.key === 'Escape' && isReaderOpen) {
      e.preventDefault();
      closeReaderView();
      return;
    }

    // Skip when actively typing inside form inputs or editable content
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
      return;
    }

    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      // Playback shortcuts (Alt+P/X/./,) are owned by the MV3 command router
      // in background.js — handling them here too double-triggered playback
      // (double extraction + restart glitch). Only reader shortcuts stay here.
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        toggleReaderView();
      } else if (e.key === 'ArrowRight') {
        // Not an MV3 command — prevent Chrome's history Forward navigation
        e.preventDefault();
        safeSendMessage({ action: 'SKIP_FORWARD' });
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        safeSendMessage({ action: 'SKIP_BACKWARD' });
      }
    }
  });

  // -----------------------------------------------------------------
  // 8. Background & Popup Event Listener (Highlighting & State Sync)
  // -----------------------------------------------------------------
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Guard: after an extension reload the listener stays registered but the
    // context is dead — bail out so we don't throw on every incoming message.
    if (!isExtensionValid()) return false;
    if (!message || !message.action) return false;

    switch (message.action) {
      case 'TOGGLE_READER_VIEW': {
        toggleReaderView();
        sendResponse({ success: true, isOpen: isReaderOpen });
        return false;
      }

      case 'TRIGGER_READ_PAGE': {
        const sentences = buildPlaybackQueue();
        if (!sentences || sentences.length === 0) {
          sendResponse({ success: false, message: 'No readable article content found.' });
          return false;
        }
        safeSendMessage({
          action: 'START_PLAYBACK',
          sentences,
          startIndex: 0,
          options: { rate: currentSpeed, volume: currentVolume }
        });
        sendResponse({ success: true, count: sentences.length });
        return false;
      }

      case 'TRIGGER_READ_FROM_HERE': {
        const target = lastContextMenuTarget || document.activeElement;
        const block = findEligibleParagraph(target) || (target && target.closest ? target.closest('p, h1, h2, h3, h4, h5, h6, li, blockquote') : null);
        if (block) {
          playFromElement(block);
        } else {
          const sentences = buildPlaybackQueue();
          if (sentences && sentences.length > 0) {
            safeSendMessage({
              action: 'START_PLAYBACK',
              sentences,
              startIndex: 0,
              options: { rate: currentSpeed, volume: currentVolume }
            });
          }
        }
        sendResponse({ success: true });
        return false;
      }

      case 'TTS_EVENT': {
        // aligned === false → pronunciation overrides rewrote this sentence;
        // word offsets then index the rewritten text and can't be mapped.
        if (message.event && message.event.type === 'word' && typeof message.event.charIndex === 'number' && message.aligned !== false) {
          const rawLength = (typeof message.event.length === 'number' && message.event.length > 0)
            ? message.event.length
            : ((typeof message.event.charLength === 'number' && message.event.charLength > 0) ? message.event.charLength : 0);
          applyWordHighlight(
            typeof message.index === 'number' ? message.index : currentSentenceIndex,
            message.event.charIndex + (currentResumeOffset || 0),
            rawLength
          );
        }
        break;
      }

      case 'PLAYER_VISIBILITY_CHANGED': {
        applyPillVisibility(Boolean(message.visible));
        break;
      }

      case 'TOGGLE_PLAYER_VISIBILITY': {
        applyPillVisibility(!isPillVisible);
        sendResponse({ success: true, visible: isPillVisible });
        return false;
      }

      case 'SELECTION_READ_STARTED': {
        updatePlayState('PLAYING');
        if (Array.isArray(message.sentences) && message.sentences.length > 0 && progressPill) {
          progressPill.textContent = `01/${String(message.sentences.length).padStart(2, '0')}`;
          progressPill.style.display = 'inline-block';
        }
        break;
      }

      case 'SET_HIGHLIGHT_COLOR': {
        if (message.colorKey) {
          updatePageHighlightStyle(message.colorKey);
          setActiveSwatch(message.colorKey);
        }
        sendResponse({ success: true });
        return false;
      }

      case 'SENTENCE_CHANGED': {
        updatePlayState('PLAYING');
        currentResumeOffset = (typeof message.resumeOffset === 'number' && message.resumeOffset > 0) ? message.resumeOffset : 0;
        if (typeof message.index === 'number') {
          // If queue ranges haven't been built yet (e.g. background started
          // playback), build them — but only once per run: re-running the
          // full Readability extraction on EVERY incoming sentence caused
          // page jank on unextractable pages.
          if (currentSentenceRanges.length === 0 && !rangeMapAttempted) {
            buildPlaybackQueue();
          }
          applyHighlight(message.index);
          startMutationObserver();

          if (typeof message.totalSentences === 'number') {
            if (progressPill) {
              progressPill.textContent = `${String(message.index + 1).padStart(2, '0')}/${String(message.totalSentences).padStart(2, '0')}`;
              const remaining = Math.max(0, message.totalSentences - (message.index + 1));
              const estMin = Math.max(1, Math.ceil((remaining * 18) / (160 * currentSpeed)));
              progressPill.title = `Sentence ${message.index + 1} of ${message.totalSentences} · ~${estMin}m remaining`;
              progressPill.style.display = 'inline-block';
            }
            updateProgressBar(message.index, message.totalSentences);
            saveReadingProgress(message.index, message.totalSentences);
          }
        }
        break;
      }

      case 'PLAYBACK_PAUSED': {
        updatePlayState('PAUSED');
        // Notice: highlight is kept on screen while paused so user sees their place
        break;
      }

      case 'PLAYBACK_RESUMED': {
        updatePlayState('PLAYING');
        if (typeof message.currentIndex === 'number') {
          applyHighlight(message.currentIndex);
        }
        startMutationObserver();
        break;
      }

      case 'PLAYBACK_STOPPED':
      case 'PLAYBACK_COMPLETED': {
        updatePlayState('STOPPED');
        stopMutationObserver();
        currentSentenceIndex = -1;
        currentSentenceText = '';
        clearHighlight();
        break;
      }

      case 'OPTIONS_CHANGED': {
        if (message.options && typeof message.options.rate === 'number') {
          currentSpeed = message.options.rate;
          speedBadge.textContent = `${currentSpeed.toFixed(1)}x`;
          if (rspeedBadge) rspeedBadge.textContent = `${currentSpeed.toFixed(1)}x`;
          // Keep settings panel slider in sync
          speedRangeEl.value = String(currentSpeed);
          speedDisplayEl.textContent = `${currentSpeed.toFixed(1)}×`;
        }
        if (message.options && typeof message.options.volume === 'number') {
          currentVolume = message.options.volume;
          if (volumeRangeEl) volumeRangeEl.value = String(currentVolume);
          if (volumeDisplayEl) volumeDisplayEl.textContent = `${Math.round(currentVolume * 100)}%`;
        }
        if (message.options && typeof message.options.pitch === 'number') {
          if (pitchRangeEl) pitchRangeEl.value = String(message.options.pitch);
          if (pitchDisplayEl) pitchDisplayEl.textContent = `${message.options.pitch.toFixed(1)}×`;
        }
        if (voiceInfo && message.options && message.options.voiceName) {
          // Show first two words of the voice name in the pill (e.g. "Supertonic F1")
          voiceInfo.textContent = message.options.voiceName.split(' ').slice(0, 2).join(' ') || 'Voice';
        }
        break;
      }
    }
  });

  // Initial Sync with Background
  safeSendMessage({ action: 'GET_PLAYBACK_STATE' }, (res) => {
    if (res && res.success && res.state) {
      updatePlayState(res.state.playbackState);
      if (res.state.options && typeof res.state.options.rate === 'number') {
        currentSpeed = res.state.options.rate;
        speedBadge.textContent = `${currentSpeed.toFixed(1)}x`;
      }
      if (res.state.options && typeof res.state.options.volume === 'number') {
        currentVolume = res.state.options.volume;
        if (volumeRangeEl) volumeRangeEl.value = String(currentVolume);
        if (volumeDisplayEl) volumeDisplayEl.textContent = `${Math.round(currentVolume * 100)}%`;
      }
      if (voiceInfo && res.state.options && res.state.options.voiceName) {
        voiceInfo.textContent = res.state.options.voiceName.split(' ')[0] || 'Voice';
      }
      if (res.state.hasQueue && (res.state.playbackState === 'PLAYING' || res.state.playbackState === 'PAUSED')) {
        if (progressPill) {
          progressPill.textContent = `${String(res.state.currentIndex + 1).padStart(2, '0')}/${String(res.state.totalSentences).padStart(2, '0')}`;
          progressPill.style.display = 'inline-block';
        }
        buildPlaybackQueue();
        applyHighlight(res.state.currentIndex);
      } else {
        // If not actively playing, check if there's a saved reading position to offer
        checkResumeProgress();
      }
    } else {
      checkResumeProgress();
    }
  });

  console.log('[ReadAloud] Content script & highlighters ready.');
})();
