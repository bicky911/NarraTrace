/**
 * NarraTrace - Sentence Tokenizer Module (dual-loadable)
 *
 * This file is deliberately valid BOTH as a classic <script> and as an ES
 * module side-effect import, so the content script and the background
 * service worker share ONE implementation with zero duplication:
 *   - manifest content_scripts load it before content.js (classic)
 *   - background.js / test.js do `import './sentence-tokenizer.js'`
 * Either way it defines globalThis.ReadAloudTokenizer.
 *
 * Tuned for academic / agronomy text:
 *   - whitespace is collapsed first, so a hard-wrapped HTML paragraph stays
 *     one paragraph instead of becoming one sentence per source line
 *   - dotted abbreviations ("e.g.", "i.e.", "U.S.A.") never split mid-token
 *   - citation tokens survive ("et al.", "Fig. 2", "No. 3", "Eq. (5)")
 *   - species/author initials never split ("T. aestivum", "J. Smith")
 *   - dotted identifiers survive ("chrome.tts", "chrome.storage.session")
 *   - a hard cap on sentence length so un-punctuated blocks (reference
 *     dumps, OCR text) cannot outlive the TTS watchdog and get skipped
 */
(function (global) {
  'use strict';

  // Words whose trailing dot never ends a sentence while the next token
  // continues it (lowercase word, digit, comma, or opening bracket).
  // Looked up with dots stripped, so "e.g." is checked as "eg".
  const ABBREVIATIONS = new Set([
    // titles & general
    'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'vs', 'etc', 'eg', 'ie',
    'gen', 'col', 'maj', 'capt', 'lt', 'sgt', 'corp', 'rev', 'st',
    // academic & agronomy citation tokens
    'al',                          // et al.
    'fig', 'figs',                 // Fig. 2, Figs. 3-4
    'eq', 'eqs',                   // Eq. (5)
    'approx', 'ca',                // approximately
    'no', 'nos',                   // No. 3
    'sp', 'spp', 'subsp', 'var', 'cv',  // taxonomy
    'ed', 'eds', 'vol', 'pp', 'p', 'doi',
    // months & weekdays
    'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
    'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
    // organisations
    'dept', 'univ', 'co', 'corp', 'inc', 'ltd', 'usa'
  ]);

  // A single utterance longer than this is split at clause boundaries before
  // it is queued. Without the cap, a reference string or OCR block with no
  // terminal punctuation becomes one giant utterance that trips the 45 s
  // engine watchdog and is silently abandoned mid-content.
  const MAX_SENTENCE_CHARS = 400;

  /**
   * Collapse every run of whitespace into a single space and trim the ends.
   *
   * WHY THIS EXISTS: HTML source is hard-wrapped for readability. A paragraph
   * that renders as one flowing block is stored as several lines separated by
   * "\n" — on a typical article page every single paragraph is wrapped at
   * 80-100 columns. Treating a newline as a sentence boundary shredded each
   * paragraph into one "sentence" per SOURCE LINE, and because every sentence
   * is a separate chrome.tts request, a network voice (Supertonic) paid its
   * full synthesis round-trip (~2 s) on every line. That is what produced the
   * long, irregular dead air in the middle of a paragraph.
   *
   * Collapsing whitespace also gives the DOM mapper one canonical text form
   * to match against, so the spoken text and the DOM offsets stay in sync
   * even when the page has stray newlines, tabs or double spaces.
   *
   * @param {string} text
   * @returns {string}
   */
  function normalizeWhitespace(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/\s+/g, ' ').trim();
  }

  function nextNonSpace(text, from) {
    let n = from;
    while (n < text.length && /\s/.test(text[n])) n++;
    return n;
  }

  /**
   * Split text into an array of sentence objects.
   *
   * @param {string} rawText Raw input text
   * @returns {Array<{ index: number, text: string }>}
   */
  function splitIntoSentences(rawText) {
    if (!rawText || typeof rawText !== 'string') {
      return [];
    }

    // Canonical form: whitespace collapsed. See normalizeWhitespace().
    const text = normalizeWhitespace(rawText);
    if (text.length === 0) {
      return [];
    }

    const sentences = [];
    let currentStart = 0;
    const len = text.length;

    for (let i = 0; i < len; i++) {
      const char = text[i];
      // NOTE: '\n' is deliberately NOT a terminator. After normalisation the
      // text has no newlines at all, and treating them as boundaries used to
      // shred hard-wrapped paragraphs into one utterance per source line.
      // Supports Western '.', '!', '?' as well as Indic danda '।' (U+0964) and double danda '॥' (U+0965).
      if (char !== '.' && char !== '!' && char !== '?' && char !== '।' && char !== '॥') continue;

      // Check for multiple punctuation marks like "..." or "!?" or "।।"
      let termEnd = i;
      while (termEnd + 1 < len && (
        text[termEnd + 1] === '.' || text[termEnd + 1] === '!' || text[termEnd + 1] === '?' ||
        text[termEnd + 1] === '।' || text[termEnd + 1] === '॥'
      )) {
        termEnd++;
      }

      // Period inside a decimal number (3.14, $19.99)
      if (char === '.' && i > 0 && i + 1 < len) {
        if (/\d/.test(text[i - 1]) && /\d/.test(text[i + 1])) {
          continue;
        }

        // Keep dotted identifiers together: technical prose frequently uses
        // API and storage names such as "chrome.tts" and
        // "chrome.storage.session". They are a single spoken phrase, not
        // sentence boundaries. This also safely preserves domains and names
        // written without spaces around their internal dot.
        if (/[A-Za-z0-9_]/.test(text[i - 1]) && /[A-Za-z0-9_]/.test(text[i + 1])) {
          continue;
        }
      }

      if (char === '.') {
        // Internal dot of a dotted abbreviation ("e.g.", "i.e.", "U.S.A."):
        // a dot sitting directly between two letters never ends a sentence.
        if (i + 2 < len && /[a-zA-Z]/.test(text[i + 1]) && text[i + 2] === '.') {
          continue;
        }

        // Walk back over letters, allowing internal dots between letters, so
        // the fragment "e.g." yields "eg" and "et al." yields "al" — not the
        // bare letters "e" / "l" that broke mid-abbreviation before.
        let wordStart = i - 1;
        while (wordStart >= 0) {
          const c = text[wordStart];
          if (/[a-zA-Z]/.test(c)) {
            wordStart--;
            continue;
          }
          if (c === '.' && wordStart > 0 && /[a-zA-Z]/.test(text[wordStart - 1])) {
            wordStart--;
            continue;
          }
          break;
        }
        wordStart++;
        const frag = text.substring(wordStart, i);
        const stripped = frag.replace(/\./g, '').toLowerCase();

        const nextIdx = nextNonSpace(text, termEnd + 1);
        const nextChar = nextIdx < len ? text[nextIdx] : '';
        // "et al. reported", "Fig. 2", "Smith et al., (2020)", "Eq. (5)"
        const continuesSentence = nextChar !== '' &&
          (/[a-z0-9,]/.test(nextChar) || nextChar === '(' || nextChar === '[');

        if (frag.length === 1 && /[A-Z]/.test(frag)) {
          // Single capital initial ("T. aestivum", "J. Smith", "B., and") —
          // never a sentence end while a word/list continues after it.
          if (/[A-Za-z0-9]/.test(nextChar) || nextChar === ',' || nextChar === '(' || nextChar === '[') {
            i = termEnd;
            continue;
          }
        }

        if (ABBREVIATIONS.has(stripped) && continuesSentence) {
          i = termEnd;
          continue;
        }
      }

      // Skip past closing quotes or brackets: ." or ) or '
      let endIdx = termEnd + 1;
      while (endIdx < len && (text[endIdx] === '"' || text[endIdx] === '\'' || text[endIdx] === ')' || text[endIdx] === ']' || text[endIdx] === '”')) {
        endIdx++;
      }

      // We have a sentence boundary
      const sentenceText = text.substring(currentStart, endIdx).trim();
      if (sentenceText.length > 0) {
        sentences.push({
          index: sentences.length,
          text: sentenceText
        });
      }

      // Advance start past whitespace
      while (endIdx < len && /\s/.test(text[endIdx])) {
        endIdx++;
      }
      currentStart = endIdx;
      i = endIdx - 1;
    }

    // Any remaining text
    if (currentStart < len) {
      const remaining = text.substring(currentStart).trim();
      if (remaining.length > 0) {
        sentences.push({
          index: sentences.length,
          text: remaining
        });
      }
    }

    return sentences;
  }

  /**
   * Split one (already trimmed) sentence into speech chunks no longer than
   * maxLen, cutting at clause boundaries (semicolon > colon > comma > space)
   * in the back half of the window so cuts feel natural.
   *
   * @param {string} text Trimmed sentence text
   * @param {number} maxLen Maximum chars per chunk
   * @returns {Array<{ text: string, startOffset: number, length: number }>}
   *          startOffset is the char position of the chunk inside `text`,
   *          used by the content script to slice sub-range highlights.
   */
  function splitOversized(text, maxLen = MAX_SENTENCE_CHARS) {
    if (typeof text !== 'string' || text.length <= maxLen) {
      const t = typeof text === 'string' ? text : '';
      return [{ text: t, startOffset: 0, length: t.length }];
    }

    const SEPARATORS = ['; ', ': ', ', ', ' '];
    const chunks = [];
    let start = 0;

    while (text.length - start > maxLen) {
      const window = text.substring(start, start + maxLen);
      let cut = -1;
      for (const sep of SEPARATORS) {
        const idx = window.lastIndexOf(sep);
        if (idx >= Math.floor(maxLen / 3)) {
          cut = idx + sep.length;
          break;
        }
      }
      if (cut <= 0) cut = maxLen;

      let piece = text.substring(start, start + cut).replace(/\s+$/, '');
      if (piece.length === 0) piece = text.substring(start, start + maxLen);

      chunks.push({ text: piece, startOffset: start, length: piece.length });
      // Advance by the SOURCE length that was consumed, not by the trimmed
      // piece length — otherwise the trailing space we just trimmed is handed
      // back to the next chunk and every offset after the first cut drifts.
      start += cut;
    }

    const tail = text.substring(start).replace(/\s+$/, '');
    if (tail.length > 0) {
      chunks.push({ text: tail, startOffset: start, length: tail.length });
    }
    return chunks;
  }

  /**
   * Tokenize + cap in one pass: queue-ready {index, text} items where no
   * item exceeds MAX_SENTENCE_CHARS. Used by background-side entry points
   * (context-menu selection, START_READING_TEXT).
   *
   * @param {string} rawText
   * @returns {Array<{ index: number, text: string }>}
   */
  function splitIntoChunks(rawText) {
    const out = [];
    for (const s of splitIntoSentences(rawText)) {
      for (const ch of splitOversized(s.text)) {
        out.push({ index: out.length, text: ch.text });
      }
    }
    return out;
  }

  global.ReadAloudTokenizer = {
    ABBREVIATIONS,
    MAX_SENTENCE_CHARS,
    normalizeWhitespace,
    splitIntoSentences,
    splitOversized,
    splitIntoChunks
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
