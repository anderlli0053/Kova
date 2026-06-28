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
});
