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
    const items = Array.from({ length: 12 }, (_, i) => `- Item ${i + 1}`).join('\n');
    const { slides } = parseDocument(doc(['## Slide', '', items].join('\n')));
    expect(slides[0].layout).toBe('two-column');
    const list = slides[0].elements.find((e) => e.type === 'list');
    expect(list?.type === 'list' && list.items).toHaveLength(12);
  });
});
