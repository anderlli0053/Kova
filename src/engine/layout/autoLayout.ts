import type { SlideElement, LayoutType, ListItem } from '../types';

// ── Content density helpers ───────────────────────────────────────────────────

// Two-column layout kicks in when estimated visual lines exceed this.
// At 18px/1.65 line-height a 540px body area holds ~13 lines; 10 leaves
// a comfortable margin and accounts for the heading consuming ~112px.
const OVERFLOW_LINE_THRESHOLD = 10;

/**
 * Counts logical elements, treating consecutive `progress` bars as a single
 * unit. This prevents individual bars from each consuming a grid/bsp pane.
 */
function logicalElementCount(elements: SlideElement[]): number {
  let count = 0;
  let inProgressRun = false;
  for (const el of elements) {
    if (el.type === 'progress') {
      if (!inProgressRun) { count++; inProgressRun = true; }
    } else {
      count++;
      inProgressRun = false;
    }
  }
  return count;
}

// CJK/Hangul/fullwidth characters render roughly twice as wide as Latin
// characters at the same font size, so a straight `.length` count badly
// under-estimates rendered line count for non-Latin scripts — a slide of
// e.g. Japanese body text could be well past the overflow threshold while
// this heuristic still thinks it comfortably fits in one column. Counting
// each wide character as 2 "columns" instead of 1 brings the estimate back
// in line with the same chars-per-line constants calibrated for Latin text.
// Ranges: CJK punctuation/symbols, Hiragana, Katakana, CJK Unified
// Ideographs (+ Ext A), Hangul Syllables, CJK compatibility, fullwidth forms,
// CJK Extension B–F and CJK Compatibility Supplement (Plane 2, U+20000–U+2FA1F).
const WIDE_CHAR_RE = /[⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿＀-｠￠-￦\u{20000}-\u{2FA1F}]/u;

/** Counts `text` in "Latin-character equivalents" — wide scripts count double. */
function visualLength(text: string): number {
  let n = 0;
  for (const ch of text) n += WIDE_CHAR_RE.test(ch) ? 2 : 1;
  return n;
}

function estimateItemLines(item: ListItem): number {
  // ~70 chars/line: proportional body font at 18px across a half-slide column
  const self = Math.max(1, Math.ceil(visualLength(item.text) / 70));
  const children = item.children.reduce((n, c) => n + estimateItemLines(c), 0);
  return self + children;
}

function estimateLines(elements: SlideElement[]): number {
  let total = 0;
  for (const el of elements) {
    switch (el.type) {
      case 'list':
        total += el.items.reduce((n, item) => n + estimateItemLines(item), 0);
        break;
      case 'toc':
        // ~70 chars/line, same column width assumption as list items.
        total += el.entries.reduce((n, entry) => n + Math.max(1, Math.ceil(visualLength(entry.title) / 70)), 0);
        break;
      case 'paragraph': {
        // ~90 chars/line: proportional body font at 18px across ~826px usable width
        const lines = el.text.split('\n').filter(Boolean);
        total += lines.reduce((n, l) => n + Math.max(1, Math.ceil(visualLength(l) / 90)), 0);
        break;
      }
      case 'progress':
        total += 2;
        break;
      default:
        total += 2;
    }
  }
  return total;
}

/**
 * Analyses the elements of a slide and returns the best-fit layout.
 * Rules are checked in priority order — first match wins.
 */
export function detectLayout(
  elements: SlideElement[],
  titleLevel: number,
  hasTitle: boolean,
): LayoutType {
  const has = (t: SlideElement['type']) => elements.some((e) => e.type === t);

  // ── H1 always produces a title/hero slide ────────────────────────────────
  // Paragraph elements are treated as subtitles; other content is ignored
  // in layout detection (TitleLayout renders them as subtitle lines).
  if (hasTitle && titleLevel === 1) return 'title';

  // ── Highest-priority special types ───────────────────────────────────────

  if (has('youtube') || has('poll') || has('video')) return 'media';
  if (has('column-break')) return 'two-column';

  // ── Code-only ────────────────────────────────────────────────────────────

  const bodyElements = hasTitle
    ? elements.filter((e) => e.type !== 'column-break')
    : elements;

  if (bodyElements.length > 0 && bodyElements.every((e) => e.type === 'code' || e.type === 'mermaid')) {
    return 'code';
  }

  if (bodyElements.length > 0 && bodyElements.every((e) => e.type === 'math')) {
    return 'math';
  }

  // ── No-title layouts ──────────────────────────────────────────────────────

  if (!hasTitle) {
    if (bodyElements.length === 1) {
      if (bodyElements[0].type === 'image') return 'full-bleed';
      // Callouts (blockquotes with a [!type] marker) keep their compact box
      // styling rather than being blown up into a full-slide pull quote.
      if (bodyElements[0].type === 'blockquote' && !bodyElements[0].calloutType) return 'quote';
    }
    if (bodyElements.length === 0) return 'blank';
  }

  // ── H2 section break ─────────────────────────────────────────────────────
  if (hasTitle && titleLevel === 2 && bodyElements.length === 0) return 'section';

  // ── Title + image combinations ────────────────────────────────────────────

  const images    = bodyElements.filter((e) => e.type === 'image');
  const nonImages = bodyElements.filter((e) => e.type !== 'image');

  if (hasTitle && images.length === 1 && nonImages.length === 0) return 'title-image';

  // Split: 1 image + any number of pure-text elements (paragraph/list/progress)
  // The SplitLayout renderer stacks all non-image elements in one column, so
  // nonImages.length > 1 is handled correctly — no BSP/grid needed.
  const isPureText = (t: string) => t === 'paragraph' || t === 'list' || t === 'progress' || t === 'blockquote';
  if (hasTitle && images.length === 1 && nonImages.length >= 1 && nonImages.every((e) => isPureText(e.type))) {
    return 'split';
  }

  // ── BSP auto-tiling ───────────────────────────────────────────────────────
  // Trigger for 2–3 elements where the mix is visually diverse enough
  // to benefit from side-by-side rendering. Skip if everything is plain
  // paragraph/list (stacked looks better for all-text slides).

  const allPureText = bodyElements.every((e) => e.type === 'paragraph' || e.type === 'list' || e.type === 'blockquote' || e.type === 'toc');
  // Tables need a full-width area; bsp panes are too narrow for them.
  const hasTable = bodyElements.some((e) => e.type === 'table');

  const logicalCount = logicalElementCount(bodyElements);

  if (!allPureText && !hasTable && (logicalCount === 2 || logicalCount === 3)) return 'bsp';

  // ── Grid: 4+ visually diverse elements ───────────────────────────────────
  // Pure-text slides with many paragraphs look better stacked or two-column,
  // not in a grid. Mirror the same guard used by bsp above.

  if (!allPureText && logicalCount >= 4) return 'grid';

  // ── Overflow guard ────────────────────────────────────────────────────────
  // When pure-text content is dense enough to overflow the slide, split into
  // two columns. The renderer auto-splits at the list/element midpoint.
  // A single paragraph cannot be split — it stays full-width regardless of length.
  const canSplitIntoColumns =
    bodyElements.length > 1 ||
    (bodyElements.length === 1 && bodyElements[0].type === 'list' && bodyElements[0].items.length > 1) ||
    (bodyElements.length === 1 && bodyElements[0].type === 'toc' && bodyElements[0].entries.length > 1);

  if (allPureText && canSplitIntoColumns && estimateLines(bodyElements) > OVERFLOW_LINE_THRESHOLD) {
    return 'two-column';
  }

  // ── Default ───────────────────────────────────────────────────────────────

  return 'title-content';
}
