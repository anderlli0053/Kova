import { describe, it, expect } from 'vitest';
import { parseDocument } from '../parser/markdownToSlides';

function doc(body: string) {
  return `---\ntitle: Test\n---\n\n${body}`;
}

describe('parser → layout integration', () => {
  it('code-only slide → layout: code', () => {
    const { slides } = parseDocument(doc([
      '## Slide',
      '',
      '```python',
      'print("hello")',
      '```',
    ].join('\n')));
    expect(slides[0].layout).toBe('code');
    const code = slides[0].elements.find((e) => e.type === 'code');
    expect(code?.type === 'code' && code.lang).toBe('python');
    expect(code?.type === 'code' && code.value).toContain('print');
  });

  it('||| column break → layout: two-column', () => {
    const { slides } = parseDocument(doc([
      '## Slide',
      '',
      'Left content',
      '',
      '|||',
      '',
      'Right content',
    ].join('\n')));
    expect(slides[0].layout).toBe('two-column');
    expect(slides[0].elements.some((e) => e.type === 'column-break')).toBe(true);
  });

  it('!youtube embed → layout: media', () => {
    const { slides } = parseDocument(doc([
      '## Slide',
      '',
      '!youtube[My Video](https://youtu.be/abc123)',
    ].join('\n')));
    expect(slides[0].layout).toBe('media');
    const yt = slides[0].elements.find((e) => e.type === 'youtube');
    expect(yt?.type === 'youtube' && yt.label).toBe('My Video');
    expect(yt?.type === 'youtube' && yt.url).toBe('https://youtu.be/abc123');
  });

  it('H2 section break with no body → layout: section', () => {
    const { slides } = parseDocument(doc('## Section\n'));
    expect(slides[0].layout).toBe('section');
    expect(slides[0].title).toBe('Section');
    expect(slides[0].titleLevel).toBe(2);
    expect(slides[0].elements).toHaveLength(0);
  });

  it('block math only → layout: math', () => {
    const { slides } = parseDocument(doc([
      '## Slide',
      '',
      '$$',
      'E = mc^2',
      '$$',
    ].join('\n')));
    expect(slides[0].layout).toBe('math');
    const math = slides[0].elements.find((e) => e.type === 'math');
    expect(math?.type === 'math' && math.display).toBe(true);
    expect(math?.type === 'math' && math.value.trim()).toBe('E = mc^2');
  });

  it('!poll embed → layout: media', () => {
    const { slides } = parseDocument(doc([
      '## Slide',
      '',
      '!poll[Vote](https://pollev.com/xyz)',
    ].join('\n')));
    expect(slides[0].layout).toBe('media');
    const poll = slides[0].elements.find((e) => e.type === 'poll');
    expect(poll?.type === 'poll' && poll.label).toBe('Vote');
    expect(poll?.type === 'poll' && poll.url).toBe('https://pollev.com/xyz');
  });

  it('image-only slide with no heading → layout: full-bleed', () => {
    const { slides } = parseDocument(doc('![](assets/photo.jpg)\n'));
    expect(slides[0].layout).toBe('full-bleed');
    expect(slides[0].title).toBe('');
    expect(slides[0].titleLevel).toBe(0);
    const img = slides[0].elements.find((e) => e.type === 'image');
    expect(img?.type === 'image' && img.src).toBe('assets/photo.jpg');
  });

  it('long bullet list triggers overflow two-column layout', () => {
    // 12 single-line items → estimateLines returns 12, which exceeds OVERFLOW_LINE_THRESHOLD (10)
    const items = Array.from({ length: 12 }, (_, i) => `- Item ${i + 1}`).join('\n');
    const { slides } = parseDocument(doc(['## Slide', '', items].join('\n')));
    expect(slides[0].layout).toBe('two-column');
    const list = slides[0].elements.find((e) => e.type === 'list');
    expect(list?.type === 'list' && list.items).toHaveLength(12);
  });

  it('H1 hero slide with no body → layout: title', () => {
    const { slides } = parseDocument(doc('# Hero\n'));
    expect(slides[0].layout).toBe('title');
    expect(slides[0].title).toBe('Hero');
    expect(slides[0].titleLevel).toBe(1);
  });

  it('title + image only → layout: title-image', () => {
    const { slides } = parseDocument(doc([
      '## Slide',
      '',
      '![](assets/hero.jpg)',
    ].join('\n')));
    expect(slides[0].layout).toBe('title-image');
    expect(slides[0].elements.filter((e) => e.type === 'image')).toHaveLength(1);
  });

  it('title + text + image without blank line → layout: split', () => {
    const { slides } = parseDocument(doc('## Slide\n\nBody copy\n![](assets/photo.jpg)\n'));
    expect(slides[0].layout).toBe('split');
    expect(slides[0].elements.some((e) => e.type === 'paragraph')).toBe(true);
    expect(slides[0].elements.some((e) => e.type === 'image')).toBe(true);
  });

  it('mermaid-only slide → layout: code', () => {
    const { slides } = parseDocument(doc([
      '## Slide',
      '',
      '```mermaid',
      'pie title Stats',
      '    "A": 1',
      '```',
    ].join('\n')));
    expect(slides[0].layout).toBe('code');
    expect(slides[0].elements.find((e) => e.type === 'mermaid')).toBeTruthy();
  });

  it('mermaid + bullet list → layout: bsp', () => {
    const { slides } = parseDocument(doc([
      '## Slide',
      '',
      '```mermaid',
      'pie title Stats',
      '    "A": 1',
      '```',
      '',
      '- Takeaway',
    ].join('\n')));
    expect(slides[0].layout).toBe('bsp');
    expect(slides[0].elements.some((e) => e.type === 'mermaid')).toBe(true);
    expect(slides[0].elements.some((e) => e.type === 'list')).toBe(true);
  });

  it('paragraph + list + code + mermaid → layout: grid', () => {
    const { slides } = parseDocument(doc([
      '## Slide',
      '',
      'Overview paragraph.',
      '',
      '- Item one',
      '',
      '```js',
      'const x = 1',
      '```',
      '',
      '```mermaid',
      'pie title Stats',
      '    "A": 1',
      '```',
    ].join('\n')));
    expect(slides[0].layout).toBe('grid');
    expect(slides[0].elements.some((e) => e.type === 'paragraph')).toBe(true);
    expect(slides[0].elements.some((e) => e.type === 'list')).toBe(true);
    expect(slides[0].elements.some((e) => e.type === 'code')).toBe(true);
    expect(slides[0].elements.some((e) => e.type === 'mermaid')).toBe(true);
  });

  it('blockquote only with no heading → layout: quote', () => {
    const { slides } = parseDocument(doc('> A standalone quote.\n'));
    expect(slides[0].layout).toBe('quote');
    expect(slides[0].title).toBe('');
    expect(slides[0].elements.find((e) => e.type === 'blockquote')).toBeTruthy();
  });

  it('quote-layout blockquote with a list still gets structured html (#116)', () => {
    const { slides } = parseDocument(doc('> Intro\n> - first\n> - second\n'));
    expect(slides[0].layout).toBe('quote');
    const bq = slides[0].elements.find((e) => e.type === 'blockquote');
    const html = bq?.type === 'blockquote' ? bq.html ?? '' : '';
    expect(html).toContain('<li>first</li>');
    expect(html).toContain('<li>second</li>');
    // QuoteLayout must render `html`, not the flattened `text`, or list
    // markers/breaks are lost again even though the parser preserved them.
    expect(bq?.type === 'blockquote' && bq.text).toBe('Introfirstsecond');
  });

  it('empty slide body with no heading → layout: blank', () => {
    const { slides } = parseDocument(doc('???\n\nPresenter notes only\n'));
    expect(slides[0].layout).toBe('blank');
    expect(slides[0].title).toBe('');
    expect(slides[0].elements).toHaveLength(0);
    expect(slides[0].speakerNotes).toContain('Presenter notes only');
  });
});

describe('parser → layout integration (multi-slide deck)', () => {
  it('assigns the correct layout to each slide of a realistic deck', () => {
    const md = [
      '---',
      'title: Realistic Deck',
      '---',
      '',
      '# Title slide',
      '',
      '---',
      '',
      '## Section',
      '',
      '---',
      '',
      '## Content',
      '',
      'Some body text',
      '',
      '---',
      '',
      '## Code',
      '',
      '```js',
      'const x = 1',
      '```',
      '',
      '---',
      '',
      '![](img.png)',
    ].join('\n');
    const { slides } = parseDocument(md);
    expect(slides).toHaveLength(5);
    expect(slides.map((s) => s.layout)).toEqual([
      'title',
      'section',
      'title-content',
      'code',
      'full-bleed',
    ]);
    expect(slides[0].title).toBe('Title slide');
    expect(slides[1].title).toBe('Section');
    expect(slides[4].title).toBe('');
    expect(slides[4].elements.find((e) => e.type === 'image')).toBeTruthy();
  });
});
