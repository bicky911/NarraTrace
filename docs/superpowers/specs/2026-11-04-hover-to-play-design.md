# Hover-to-Play Button — Design

**Date:** 2026-11-04
**Status:** approved by the user
**File changed:** `content.js` (one file; the visual system is untouched)

## Problem

The hover-to-play button already existed, but it only matched `<p>` and
`<blockquote>` elements. On `<div>`-based sites — Medium, Reddit, X, Notion,
most documentation sites, most web apps — no paragraph ever qualified, so the
button "appeared on some pages only". When it did appear it was parked in the
left gutter, 26 px to the left of the paragraph, which on pages without a
gutter meant it landed on top of the text.

## Decisions (from the user)

| Question | Answer |
|---|---|
| How should reading start? | Click the button (Speechify-style) — unchanged |
| Where should the button sit? | **Inside** the paragraph's left edge |
| What shape? | Keep the existing Teenage Engineering square (26 px, hard shadow) |

## Design

### 1. Block detection — works on every site

`findEligibleParagraph()` gains a second path:

- **Fast path** — the cursor is inside a genuine `<p>` / `<blockquote>`.
- **Generic path** — climb from the hovered node to the *deepest* ancestor
  holding 40–3000 characters of text. That tightest block is the "paragraph"
  a human perceives, even when the site never uses `<p>`.

Shared eligibility rules for both paths:

- never inside `nav`, `header`, `footer`, `aside`, `[role="navigation"]`,
  `[role="banner"]`, `[role="contentinfo"]`, `.navbox`, `.toc`, `.reflist`,
  `#toc`, `form`, `input`, `textarea`, `button`
- never `display: none` or `visibility: hidden`
- at least 40 characters and 6 words (relaxed from 60 / 8 — social posts are
  shorter than article paragraphs, and the button only appears after a 350 ms
  dwell, so a slightly noisier button is harmless)
- at most 60 % of its text inside `<a>` tags (the existing link-density guard:
  link-dense blocks are navigation, not prose)

### 2. Stickiness — the button stops fleeing the pointer

Once the button is showing for a block it stays parked:

- while the cursor moves anywhere inside that block;
- across the same reading unit at a different nesting depth (a comment body
  vs. the whole comment including its author row).

Without this the block finder — run from a different child node at a
different pixel — returned a narrower inner block or a wider outer one, and
the button hopped between them. On nested markup it could never be clicked.

The 60 ms throttle on the (expensive) block lookup is **kept**: the lookup
calls `getComputedStyle()` and allocates the paragraph's `textContent`, which
is the most expensive thing this content script does on a heavy page.

### 3. Placement — inside the paragraph's left edge

- **Horizontal:** always `rect.left + 6`, clamped to the viewport.
- **Vertical:** the *hovered line* (pointer Y), clamped inside the block — the
  button appears beside the text being read, not at the block top.
- **Never under the pointer.** A button that pops up under the mouse steals
  the hover (the page sees `mouseout` → shadow host), the paragraph looks
  abandoned, the button hides and re-shows — a flicker loop. If a placement
  would land under the pointer it is nudged one line away **once**, at
  placement time; it never chases the cursor afterwards.
- **Fade:** because the button overlays the first characters of the hovered
  line, it renders at 45 % opacity and goes solid when the pointer is on it.

### 4. Dwell re-check

The cursor may move on during the 350 ms dwell. The dwell timer keeps the
newest pointer position and only shows the button if the cursor is still over
the same block. Moving onto our own UI cancels a pending dwell.

## Unchanged

- Click-to-start behaviour, and the 350 ms dwell / 300 ms hide grace.
- The Teenage Engineering visual language: same 26 px square, same accent
  colour, same hard offset shadow, same icon.
- Permissions, themes, everything else.

## Testing

The E2E suite gains a hover phase:

1. A `<div>`-based paragraph fixture is added to the test page (no `<p>`
   anywhere inside it) — the generic path must find it.
2. `Input.dispatchMouseEvent` moves the pointer onto the fixture.
3. Assert the button becomes visible.
4. Assert the button's left edge is inside the paragraph's left edge
   (within a few px of `rect.left + 6`).
5. Assert the button's vertical position tracks the hovered line.
6. Click the button; assert playback started at that paragraph.

## Risks

- **More blocks qualify.** The generic path is looser than the old `<p>`-only
  rule, so the button can appear on blocks that are not articles — list items,
  pull-quotes, chat messages. The 40-char / 6-word floor, the link-density
  guard and the 350 ms dwell keep the noise acceptable.
- **Overlapping text.** The button sits on the first characters of the hovered
  line. Mitigated by the 45 % fade.
