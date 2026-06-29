import { describe, it, expect } from 'vitest';
import { pptxToMarkdown } from '../pptxToMarkdown';
import type { PptxParseResult } from '../parsePptx';

function makeResult(overrides: Partial<PptxParseResult> = {}): PptxParseResult {
  return {
    slides: [],
    presentationTitle: 'My Deck',
    warnings: [],
    ...overrides,
  };
}

describe('pptxToMarkdown', () => {
  it('emits frontmatter with the presentation title', () => {
    const md = pptxToMarkdown(makeResult({ presentationTitle: 'Quarterly Review' }));
    expect(md).toContain('title: "Quarterly Review"');
    expect(md).toMatch(/^---\n/);
  });

  it('escapes double quotes in the presentation title', () => {
    const md = pptxToMarkdown(makeResult({ presentationTitle: 'Say "hello"' }));
    expect(md).toContain('title: "Say \\"hello\\""');
  });

  it('maps a ctrTitle block to H1', () => {
    const md = pptxToMarkdown(makeResult({
      slides: [{
        blocks: [{ kind: 'ctrTitle', text: 'Hero', normX: 0, normY: 0, normW: 1, normH: 0.2 }],
        speakerNotes: '',
      }],
    }));
    expect(md).toContain('# Hero');
  });

  it('maps a title block to H2', () => {
    const md = pptxToMarkdown(makeResult({
      slides: [{
        blocks: [{ kind: 'title', text: 'Section', normX: 0, normY: 0, normW: 1, normH: 0.15 }],
        speakerNotes: '',
      }],
    }));
    expect(md).toContain('## Section');
  });

  it('converts multi-line body text to bullet list', () => {
    const md = pptxToMarkdown(makeResult({
      slides: [{
        blocks: [{ kind: 'body', text: 'First point\nSecond point', normX: 0, normY: 0.2, normW: 1, normH: 0.5 }],
        speakerNotes: '',
      }],
    }));
    expect(md).toContain('- First point');
    expect(md).toContain('- Second point');
  });

  it('passes single-line body text through as-is', () => {
    const md = pptxToMarkdown(makeResult({
      slides: [{
        blocks: [{ kind: 'body', text: 'Single point', normX: 0, normY: 0.2, normW: 1, normH: 0.5 }],
        speakerNotes: '',
      }],
    }));
    expect(md).toContain('Single point');
    expect(md).not.toContain('- Single point');
  });

  it('passes already-bulleted body through without re-wrapping', () => {
    const md = pptxToMarkdown(makeResult({
      slides: [{
        blocks: [{ kind: 'body', text: '- A\n- B', normX: 0, normY: 0.2, normW: 1, normH: 0.5 }],
        speakerNotes: '',
      }],
    }));
    expect(md).toContain('- A');
    expect(md).not.toContain('- - A');
  });

  it('renders tables as GFM and escapes pipe characters', () => {
    const md = pptxToMarkdown(makeResult({
      slides: [{
        blocks: [{
          kind: 'table',
          headers: ['A', 'B'],
          rows: [['1', 'a|b']],
          normX: 0,
          normY: 0.3,
          normW: 1,
          normH: 0.4,
        }],
        speakerNotes: '',
      }],
    }));
    expect(md).toContain('| A | B |');
    expect(md).toContain('a\\|b');
  });

  it('appends speaker notes with the ??? delimiter', () => {
    const md = pptxToMarkdown(makeResult({
      slides: [{
        blocks: [{ kind: 'body', text: 'Content', normX: 0, normY: 0.2, normW: 1, normH: 0.5 }],
        speakerNotes: 'Mention the roadmap',
      }],
    }));
    expect(md).toContain('???');
    expect(md).toContain('Mention the roadmap');
  });

  it('joins multiple slides with --- separators', () => {
    const md = pptxToMarkdown(makeResult({
      slides: [
        { blocks: [{ kind: 'title', text: 'One', normX: 0, normY: 0, normW: 1, normH: 0.2 }], speakerNotes: '' },
        { blocks: [{ kind: 'title', text: 'Two', normX: 0, normY: 0, normW: 1, normH: 0.2 }], speakerNotes: '' },
      ],
    }));
    expect(md).toContain('## One');
    expect(md).toContain('## Two');
    expect(md).toMatch(/\n\n---\n\n/);
  });

  it('renders image blocks as markdown images', () => {
    const md = pptxToMarkdown(makeResult({
      slides: [{
        blocks: [{ kind: 'image', assetFilename: 'assets/slide1_img1.png', normX: 0, normY: 0.2, normW: 1, normH: 0.5 }],
        speakerNotes: '',
      }],
    }));
    expect(md).toContain('![](assets/slide1_img1.png)');
  });

  it('emits a placeholder comment for empty slides', () => {
    const md = pptxToMarkdown(makeResult({
      slides: [{ blocks: [], speakerNotes: '' }],
    }));
    expect(md).toContain('<!-- slide 1 -->');
  });

  it('prefers ctrTitle (#) over a title block on the same slide', () => {
    const md = pptxToMarkdown(makeResult({
      slides: [{
        blocks: [
          { kind: 'title', text: 'SubTitle', normX: 0, normY: 0.1, normW: 1, normH: 0.1 },
          { kind: 'ctrTitle', text: 'Hero', normX: 0, normY: 0, normW: 1, normH: 0.2 },
        ],
        speakerNotes: '',
      }],
    }));
    expect(md).toContain('# Hero');
    expect(md).not.toContain('## SubTitle');
    expect(md).not.toContain('SubTitle');
  });

  it('pads table rows that have fewer cells than headers', () => {
    const md = pptxToMarkdown(makeResult({
      slides: [{
        blocks: [{
          kind: 'table',
          headers: ['A', 'B', 'C'],
          rows: [['1']],
          normX: 0,
          normY: 0.3,
          normW: 1,
          normH: 0.4,
        }],
        speakerNotes: '',
      }],
    }));
    expect(md).toContain('| A | B | C |');
    expect(md).toContain('| 1 |  |  |');
  });

  it('emits valid markdown for a slide with only a ctrTitle', () => {
    const md = pptxToMarkdown(makeResult({
      slides: [{
        blocks: [{ kind: 'ctrTitle', text: 'Standalone Hero', normX: 0, normY: 0, normW: 1, normH: 0.2 }],
        speakerNotes: '',
      }],
    }));
    expect(md).toContain('# Standalone Hero');
    expect(md).not.toContain('<!-- slide 1 -->');
  });

  it('attaches speaker notes to the correct slide in a multi-slide deck', () => {
    const md = pptxToMarkdown(makeResult({
      slides: [
        { blocks: [{ kind: 'title', text: 'One', normX: 0, normY: 0, normW: 1, normH: 0.2 }], speakerNotes: 'Notes for one' },
        { blocks: [{ kind: 'title', text: 'Two', normX: 0, normY: 0, normW: 1, normH: 0.2 }], speakerNotes: 'Notes for two' },
      ],
    }));
    const [first, second] = md.split('\n\n---\n\n');
    expect(first).toContain('## One');
    expect(first).toContain('Notes for one');
    expect(first).not.toContain('Notes for two');
    expect(second).toContain('## Two');
    expect(second).toContain('Notes for two');
    expect(second).not.toContain('Notes for one');
  });
});
