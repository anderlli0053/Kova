import { describe, it, expect } from 'vitest';
import { detectLayout } from '../autoLayout';
import type { SlideElement } from '../../types';

const math: SlideElement = { type: 'math', value: 'x^2', display: true };
const callout: SlideElement = { type: 'blockquote', text: 'Note', calloutType: 'note' };
const paragraph: SlideElement = { type: 'paragraph', text: 'Hello', html: '<p>Hello</p>' };
const image: SlideElement = { type: 'image', src: 'a.png', alt: 'a' };
const code: SlideElement = { type: 'code', lang: 'ts', value: 'const a = 1;' };

describe('detectLayout - math + text mixtures (issue #135)', () => {
  it('stacks a formula with a callout instead of splitting into columns', () => {
    expect(detectLayout([math, callout], 2, true)).toBe('title-content');
  });

  it('stacks a formula with a plain paragraph', () => {
    expect(detectLayout([math, paragraph], 2, true)).toBe('title-content');
  });

  it('still uses bsp for a formula next to an image', () => {
    expect(detectLayout([math, image], 2, true)).toBe('bsp');
  });

  it('still uses bsp for a formula next to a code block', () => {
    expect(detectLayout([math, code], 2, true)).toBe('bsp');
  });

  it('still returns the dedicated math layout when every element is math', () => {
    expect(detectLayout([math, { ...math, value: 'y^2' }], 2, true)).toBe('math');
  });
});
