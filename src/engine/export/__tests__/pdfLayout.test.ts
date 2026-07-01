import { describe, it, expect } from 'vitest';
import { nupCols, notesEnabled, planPage } from '../pdfLayout';

const AR = { w: 16, h: 9 };

describe('pdfLayout', () => {
  it('picks grid columns per sheet size', () => {
    expect(nupCols(1)).toBe(1);
    expect(nupCols(2)).toBe(2);
    expect(nupCols(4)).toBe(2);
    expect(nupCols(6)).toBe(3);
  });

  it('enables notes only at 1-up with a non-empty note', () => {
    expect(notesEnabled({ perPage: 1, notes: ['hi'] })).toBe(true);
    expect(notesEnabled({ perPage: 1, notes: ['', '  '] })).toBe(false);
    expect(notesEnabled({ perPage: 4, notes: ['hi'] })).toBe(false);
    expect(notesEnabled({})).toBe(false);
  });

  it('lays A4 out landscape by default', () => {
    const p = planPage(AR, { perPage: 1 });
    expect(p.mode).toBe('single');
    expect([p.pageWmm, p.pageHmm]).toEqual([297, 210]); // A4 landscape
    expect(p.pageWpx).toBeGreaterThan(p.pageHpx);
    expect(p.cols).toBe(1);
  });

  it('honours Letter paper', () => {
    const p = planPage(AR, { perPage: 1, paper: 'letter' });
    expect([p.pageWmm, p.pageHmm]).toEqual([279, 216]);
  });

  it('scales a slide to fit its cell without overflow', () => {
    const p = planPage(AR, { perPage: 4 });
    expect(p.mode).toBe('nup');
    expect(p.cols).toBe(2);
    expect(p.rows).toBe(2);
    expect(960 * p.slideScale).toBeLessThanOrEqual(p.cellWpx + 0.01);
    expect(p.slideNativeHpx * p.slideScale).toBeLessThanOrEqual(p.cellHpx + 0.01);
  });

  it('reserves a notes band below the slide', () => {
    const p = planPage(AR, { perPage: 1, notes: ['speaker note'] });
    expect(p.mode).toBe('notes');
    expect(p.notesTopPx).toBeGreaterThan(p.marginPx);
    expect(p.notesTopPx).toBeLessThan(p.pageHpx - p.marginPx);
  });

  it('fullBleed sets page size to the slide with no margins and unit scale', () => {
    const p = planPage(AR, { fullBleed: true });
    expect(p.mode).toBe('single');
    expect(p.marginPx).toBe(0);
    expect(p.gapPx).toBe(0);
    expect(p.pageWpx).toBe(960);
    expect(p.slideNativeHpx).toBe(540);
    expect(p.pageHpx).toBe(540);
    expect(p.slideScale).toBe(1);
    expect(p.cols).toBe(1);
    expect(p.rows).toBe(1);
  });
});
