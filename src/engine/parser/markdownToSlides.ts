import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import katex from 'katex';
import { toString } from 'mdast-util-to-string';
import type { Root, Node, Paragraph, List, ListItem as MdastListItem, Code, Blockquote, Table, Heading } from 'mdast';

import type { Slide, SlideElement, ListItem, LayoutType, Frontmatter, ParsedDocument } from '../types';
import { detectLayout } from '../layout/autoLayout';
import { extractFrontmatter } from './frontmatter';
import { extractSpeakerNotes } from './speakerNotes';

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

// Reuses the previous call's Slide objects (by position) whenever a slide's
// raw text is byte-identical to last time. Without this, every keystroke
// re-parses and rebuilds the *entire* deck's Slide objects (remark, KaTeX,
// highlight.js classification, etc. for every slide, not just the one being
// edited) — and since the result is a brand-new object graph each time, any
// downstream React.memo on a per-slide component (e.g. ThumbnailPanel) can
// never skip a re-render either, because the prop reference always changes.
// Positional (not content-hash) comparison: a slide insertion/deletion shifts
// every later index out of alignment and is a deliberate, accepted miss —
// simpler and bounded (one prior array, no growing cache) at the cost of not
// optimising that less-common edit. Module-level cache mirrors the existing
// mermaidSvgCache pattern elsewhere in this codebase.
let prevRawSlides: string[] = [];
let prevParsedSlides: Slide[] = [];

export function parseDocument(rawContent: string): ParsedDocument {
  const normalised = rawContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const { frontmatter, body } = extractFrontmatter(normalised);
  const rawSlides = body.split(/^---$/m).map((s) => s.trim()).filter(Boolean);
  const slides = rawSlides.map((raw, index) =>
    raw === prevRawSlides[index] && prevParsedSlides[index] ? prevParsedSlides[index] : parseSlide(raw, index),
  );
  prevRawSlides = rawSlides;
  prevParsedSlides = slides;
  return { slides, frontmatter };
}

// ── Per-slide parser ─────────────────────────────────────────────────────────

function parseSlide(raw: string, index: number): Slide {
  // Extract layout override from HTML comment before anything else
  const layoutOverrideMatch = raw.match(/<!--\s*layout:\s*(\S+)\s*-->/);
  const layoutOverride = layoutOverrideMatch
    ? (layoutOverrideMatch[1] as LayoutType)
    : undefined;

  const hidden = /<!--\s*hidden\s*-->/.test(raw);

  // Preprocess before speaker-notes extraction so ??? inside custom URLs is not
  // misinterpreted as speaker-note markers. Custom elements become inline HTML
  // comment placeholders so remark preserves their position in the element list.
  const { cleanContent, placeholders, references } = preprocess(raw);
  const { content, notes } = extractSpeakerNotes(cleanContent);

  const tree = processor.parse(content) as Root;
  const { title, titleLevel, elements } = convertRoot(tree, placeholders);

  const layout = layoutOverride ?? detectLayout(elements, titleLevel, !!title);

  return { index, raw, title, titleLevel, elements, speakerNotes: notes, references, layout, layoutOverride, hidden };
}

// ── Custom syntax pre-processor ──────────────────────────────────────────────

interface PreprocessResult {
  cleanContent: string;
  placeholders: Map<number, SlideElement>;
  references: string[];
}

const YOUTUBE_RE      = /^!youtube\[([^\]]*)\]\(([^)]*)\)$/;
const VIDEO_RE        = /^!video\[([^\]]*)\]\(([^)]*)\)$/;
const POLL_RE         = /^!poll\[([^\]]*)\]\(([^)]*)\)$/;
const PROGRESS_RE     = /^!progress\[([^\]]*)\]\((\d+(?:\.\d+)?)\)$/;
const REF_RE          = /^!ref\[([^\]]*)\]$/;
const TOC_RE          = /^!toc$/;
// remark-math v6 only recognises block math when $$ appears on its own line.
// Normalise single-line $$...$$ → multi-line so it is parsed as a math block.
const DISPLAY_MATH_RE = /^\$\$(.+)\$\$\s*$/;

function preprocess(content: string): PreprocessResult {
  const placeholders = new Map<number, SlideElement>();
  const references: string[] = [];
  let nextIdx = 0;
  const cleanLines: string[] = [];
  let inFencedCode = false;

  for (const line of content.split('\n')) {
    const t = line.trim();

    if (/^(`{3,}|~{3,})/.test(t)) {
      inFencedCode = !inFencedCode;
      cleanLines.push(line);
      continue;
    }
    if (inFencedCode) {
      cleanLines.push(line);
      continue;
    }

    if (t === '|||') {
      cleanLines.push('<!-- column-break -->');
      continue;
    }

    const yt = t.match(YOUTUBE_RE);
    if (yt) {
      const idx = nextIdx++;
      placeholders.set(idx, { type: 'youtube', label: yt[1], url: yt[2] });
      cleanLines.push(`<!-- kova-el:${idx} -->`);
      continue;
    }

    const vid = t.match(VIDEO_RE);
    if (vid) {
      const idx = nextIdx++;
      placeholders.set(idx, { type: 'video', label: vid[1], src: vid[2] });
      cleanLines.push(`<!-- kova-el:${idx} -->`);
      continue;
    }

    const poll = t.match(POLL_RE);
    if (poll) {
      const idx = nextIdx++;
      placeholders.set(idx, { type: 'poll', label: poll[1], url: poll[2] });
      cleanLines.push(`<!-- kova-el:${idx} -->`);
      continue;
    }

    const progress = t.match(PROGRESS_RE);
    if (progress) {
      const idx = nextIdx++;
      placeholders.set(idx, { type: 'progress', label: progress[1], value: parseFloat(progress[2]) });
      cleanLines.push(`<!-- kova-el:${idx} -->`);
      continue;
    }

    const ref = t.match(REF_RE);
    if (ref) {
      if (ref[1].trim()) references.push(ref[1]);
      continue;
    }

    if (TOC_RE.test(t)) {
      const idx = nextIdx++;
      placeholders.set(idx, { type: 'toc', entries: [] });
      cleanLines.push(`<!-- kova-el:${idx} -->`);
      continue;
    }

    // Strip layout override + hidden comments (already captured above)
    if (/^<!--\s*layout:/.test(t)) continue;
    if (/^<!--\s*hidden\s*-->$/.test(t)) continue;

    // Expand single-line $$...$$ to multi-line so remark-math treats it as a block
    const dm = t.match(DISPLAY_MATH_RE);
    if (dm) {
      cleanLines.push(`$$\n${dm[1]}\n$$`);
      continue;
    }

    cleanLines.push(line);
  }

  return { cleanContent: cleanLines.join('\n').trim(), placeholders, references };
}

// ── mdast → SlideElement converter ───────────────────────────────────────────

interface ConvertResult {
  title: string;
  titleLevel: number;
  elements: SlideElement[];
}

function convertRoot(tree: Root, placeholders: Map<number, SlideElement>): ConvertResult {
  let title = '';
  let titleLevel = 0;
  const elements: SlideElement[] = [];

  for (const node of tree.children) {
    switch (node.type) {
      case 'heading': {
        const h = node as Heading;
        if (!title) {
          title = toString(h);
          titleLevel = h.depth;
        } else {
          elements.push({
            type: 'paragraph',
            text: toString(h),
            html: `<h${h.depth}>${inlineToHtml(h.children)}</h${h.depth}>`,
          });
        }
        break;
      }

      case 'paragraph': {
        const p = node as Paragraph;
        for (const el of convertParagraph(p)) elements.push(el);
        break;
      }

      case 'list': {
        const l = node as List;
        elements.push({
          type: 'list',
          ordered: l.ordered ?? false,
          items: l.children.map(convertListItem),
        });
        break;
      }

      case 'code': {
        const c = node as Code;
        if (c.lang === 'mermaid') {
          elements.push({ type: 'mermaid', value: c.value });
        } else {
          elements.push({ type: 'code', lang: c.lang ?? '', value: c.value });
        }
        break;
      }

      case 'math': {
        const m = node as { type: 'math'; value: string };
        elements.push({ type: 'math', value: m.value, display: true });
        break;
      }

      case 'blockquote': {
        const bq = node as Blockquote;
        // Attribution (— Author on the last line) applies to a single-paragraph
        // quote; the body keeps its inline formatting via `html`. Structured
        // quotes (lists, multiple blocks) render their markup through `html` too.
        const attrib = extractAttribution(bq);
        elements.push(attrib
          ? { type: 'blockquote', text: attrib.children.map((c) => toString(c)).join(''), attribution: attrib.attribution, html: `<p>${inlineToHtml(attrib.children)}</p>` }
          : { type: 'blockquote', text: toString(bq), html: blockquoteInnerHtml(bq) });
        break;
      }

      case 'table': {
        const t = node as Table;
        const [headerRow, ...bodyRows] = t.children;
        const headers = (headerRow?.children ?? []).map((cell) => inlineToHtml(cell.children as Node[]));
        const rows = bodyRows.map((row) => row.children.map((cell) => inlineToHtml(cell.children as Node[])));
        elements.push({ type: 'table', headers, rows, align: t.align ?? undefined });
        break;
      }

      case 'html': {
        const htmlNode = node as { type: 'html'; value: string };
        const v = htmlNode.value.trim();
        if (v === '<!-- column-break -->') {
          elements.push({ type: 'column-break' });
        } else {
          const m = v.match(/^<!-- kova-el:(\d+) -->$/);
          if (m) {
            const el = placeholders.get(Number(m[1]));
            if (el) elements.push(el);
          } else if (v === '<hr>' || v === '<hr/>' || v === '<hr />') {
            elements.push({ type: 'paragraph', text: '', html: '<hr>' });
          }
        }
        break;
      }

      case 'thematicBreak':
        // --- is intercepted as a slide separator before parsing; thematicBreak here means *** or ___
        elements.push({ type: 'paragraph', text: '', html: '<hr>' });
        break;

      case 'yaml':
        break;

      default:
        break;
    }
  }

  return { title, titleLevel, elements };
}

function convertParagraph(p: Paragraph): SlideElement[] {
  // Single standalone image (most common case)
  if (p.children.length === 1 && p.children[0].type === 'image') {
    const img = p.children[0];
    return [{ type: 'image', src: img.url, alt: img.alt ?? '', title: img.title ?? undefined }];
  }

  // Mixed paragraph: text + image(s) with no blank line between them.
  // Split on image boundaries so the layout engine can detect images correctly.
  if (p.children.some((c) => c.type === 'image')) {
    const results: SlideElement[] = [];
    let buf: typeof p.children = [];

    const flushBuf = () => {
      if (!buf.length) return;
      const text = buf.map((n) => toString(n)).join('').trim();
      if (text) results.push({ type: 'paragraph', text, html: inlineToHtml(buf as Node[]) });
      buf = [];
    };

    for (const child of p.children) {
      if (child.type === 'image') {
        flushBuf();
        results.push({ type: 'image', src: child.url, alt: child.alt ?? '', title: child.title ?? undefined });
      } else {
        buf.push(child);
      }
    }
    flushBuf();
    return results;
  }

  // Plain paragraph — discard whitespace-only nodes (trailing blank lines etc.)
  const text = toString(p);
  if (!text.trim()) return [];
  return [{ type: 'paragraph', text, html: inlineToHtml(p.children as Node[]) }];
}

function convertListItem(item: MdastListItem): ListItem {
  const subList = item.children.find((c): c is List => c.type === 'list');
  const paragraphs = item.children.filter((c) => c.type === 'paragraph') as Paragraph[];
  const text = paragraphs.map((p) => toString(p)).join(' ');
  const html = paragraphs.map((p) => inlineToHtml(p.children)).join(' ');
  return {
    text,
    html,
    children: subList ? subList.children.map(convertListItem) : [],
  };
}

// Blockquote children → HTML, preserving paragraphs and (nested) lists.
// Code/tables inside a quote are rare — fall back to their flattened text.
function blockquoteInnerHtml(bq: Blockquote): string {
  return bq.children.map((child) => {
    if (child.type === 'paragraph') return `<p>${inlineToHtml((child as Paragraph).children)}</p>`;
    if (child.type === 'list') return listToHtml(child as List);
    return `<p>${escHtml(toString(child))}</p>`;
  }).join('');
}

// A single-paragraph quote ending in a "— Author" line: split the attribution
// off the last text node, keeping the body's inline nodes intact for formatting.
function extractAttribution(bq: Blockquote): { children: Node[]; attribution: string } | null {
  if (bq.children.length !== 1 || bq.children[0].type !== 'paragraph') return null;
  const kids = [...(bq.children[0] as Paragraph).children] as any[];
  const last = kids[kids.length - 1];
  if (!last || last.type !== 'text') return null;
  const nl = (last.value as string).lastIndexOf('\n');
  if (nl < 0) return null;
  const tail = (last.value as string).slice(nl + 1);
  if (!/^\s*[—–\-]/.test(tail)) return null;
  const children = [...kids.slice(0, -1), { ...last, value: (last.value as string).slice(0, nl) }] as Node[];
  return { children, attribution: tail.replace(/^\s*[—–\-]\s*/, '') };
}

function listToHtml(l: List): string {
  const tag = l.ordered ? 'ol' : 'ul';
  const items = l.children.map((item) => {
    const mi = item as MdastListItem;
    const sub = mi.children.find((c): c is List => c.type === 'list');
    const inner = (mi.children.filter((c) => c.type === 'paragraph') as Paragraph[])
      .map((p) => inlineToHtml(p.children)).join(' ');
    return `<li>${inner}${sub ? listToHtml(sub) : ''}</li>`;
  }).join('');
  return `<${tag}>${items}</${tag}>`;
}

// ── Inline node → HTML ───────────────────────────────────────────────────────

function inlineToHtml(children: Node[]): string {
  return (children as any[]).map((node) => {
    switch (node.type) {
      case 'text':        return escHtml(node.value as string).replace(/\n/g, '<br>');
      case 'strong':      return `<strong>${inlineToHtml(node.children)}</strong>`;
      case 'emphasis':    return `<em>${inlineToHtml(node.children)}</em>`;
      case 'delete':      return `<del>${inlineToHtml(node.children)}</del>`;
      case 'inlineCode':  return `<code>${escHtml(node.value as string)}</code>`;
      case 'link':        return `<a href="${escUrl(node.url as string)}">${inlineToHtml(node.children)}</a>`;
      case 'image':       return `<img src="${escUrl(node.url as string)}" alt="${escHtml(node.alt ?? '')}" />`;
      case 'break':       return '<br>';
      case 'inlineMath': {
        try {
          return katex.renderToString(node.value as string, { displayMode: false, throwOnError: false });
        } catch {
          return `<code>${escHtml(node.value as string)}</code>`;
        }
      }
      default:            return node.children ? inlineToHtml(node.children) : '';
    }
  }).join('');
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escUrl(url: string): string {
  const lower = url.trim().toLowerCase();
  const ALLOWED = ['https:', 'http:', 'asset:', 'tauri:'];
  if (!ALLOWED.some(s => lower.startsWith(s))) return '#';
  return url.replace(/"/g, '%22');
}

export type { Frontmatter };
