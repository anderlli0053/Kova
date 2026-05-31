import type { PptxParseResult, PptxParsedSlide } from './parsePptx';

// ── Table → GFM ──────────────────────────────────────────────────────────────

function tableToGfm(headers: string[], rows: string[][]): string {
  const escape = (s: string) => s.replace(/\|/g, '\\|');
  const headerRow = `| ${headers.map(escape).join(' | ')} |`;
  const sepRow    = `| ${headers.map(() => '---').join(' | ')} |`;
  const bodyRows  = rows.map((r) => `| ${r.map(escape).join(' | ')} |`).join('\n');
  return bodyRows ? [headerRow, sepRow, bodyRows].join('\n') : [headerRow, sepRow].join('\n');
}

// ── Single slide → markdown string ───────────────────────────────────────────

function slideToMarkdown(slide: PptxParsedSlide, slideIndex: number): string {
  const { blocks } = slide;

  // Find the primary title block (prefer ctrTitle, then title)
  const ctrTitle = blocks.find((b) => b.kind === 'ctrTitle');
  const titleBlock = ctrTitle ?? blocks.find((b) => b.kind === 'title');
  const bodyBlocks = blocks.filter((b) => b !== titleBlock);

  const lines: string[] = [];

  // ── Title ─────────────────────────────────────────────────────────────────
  if (titleBlock) {
    const level = titleBlock.kind === 'ctrTitle' ? '#' : '##';
    lines.push(`${level} ${titleBlock.text}`);
  }

  // ── Body blocks (sorted by normY already) ─────────────────────────────────
  for (const block of bodyBlocks) {
    if (lines.length > 0) lines.push('');

    switch (block.kind) {
      case 'body': {
        const text = block.text ?? '';
        if (!text.trim()) break;

        // If the text block has multiple lines but none start with '- ',
        // we apply the "body placeholder with multiple paragraphs → bullets" heuristic.
        const rawLines = text.split('\n').filter((l) => l.trim());
        const alreadyBulleted = rawLines.some((l) => /^\s*-\s/.test(l));

        if (!alreadyBulleted && rawLines.length > 1) {
          // Multi-paragraph body: convert each non-empty line to a bullet
          lines.push(...rawLines.map((l) => `- ${l.trim()}`));
        } else {
          lines.push(text);
        }
        break;
      }

      case 'image':
        lines.push(`![](${block.assetFilename})`);
        break;

      case 'table':
        lines.push(tableToGfm(block.headers ?? [], block.rows ?? []));
        break;

      default:
        break;
    }
  }

  // Empty slide: just emit a comment so the slide delimiter has content
  if (lines.length === 0) {
    lines.push(`<!-- slide ${slideIndex + 1} -->`);
  }

  // Append speaker notes using Kova's ??? delimiter
  if (slide.speakerNotes.trim()) {
    lines.push('', '???', '', slide.speakerNotes.trim());
  }

  return lines.join('\n');
}

// ── Frontmatter ───────────────────────────────────────────────────────────────

function makeFrontmatter(title: string): string {
  const year = new Date().getFullYear();
  const escapedTitle = title.replace(/"/g, '\\"');
  return `---
title: "${escapedTitle || 'Imported Presentation'}"
date: ${year}
# theme: add your Kova theme here
# Imported from PPTX — review and adjust layouts as needed
---`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function pptxToMarkdown(result: PptxParseResult): string {
  const { slides, presentationTitle } = result;

  const slideMarkdowns = slides.map((slide, i) => slideToMarkdown(slide, i));

  const body = slideMarkdowns.join('\n\n---\n\n');
  const fm   = makeFrontmatter(presentationTitle);

  return `${fm}\n\n${body}\n`;
}
