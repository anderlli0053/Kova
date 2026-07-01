import { describe, it, expect, vi, afterEach } from 'vitest';

type FontMod = typeof import('../fontDetect');

type MockCtx = {
  font: string;
  measureText: ReturnType<typeof vi.fn>;
};

function stubCanvas(ctx: MockCtx | null) {
  vi.stubGlobal('document', {
    createElement: () => ({
      getContext: () => ctx,
    }),
  });
}

async function freshModule(ctx: MockCtx | null): Promise<{ mod: FontMod; ctx: MockCtx | null }> {
  stubCanvas(ctx);
  vi.resetModules();
  const mod = await import('../fontDetect');
  return { mod, ctx };
}

function makeCtx(availableFamilies: string[]): MockCtx {
  return {
    font: '',
    measureText: vi.fn(function (this: MockCtx) {
      const differs = availableFamilies.some((f) => this.font.includes(f));
      return { width: differs ? 200 : 100 };
    }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isFontAvailable', () => {
  it('returns false when canvas getContext is unavailable', async () => {
    const { mod } = await freshModule(null);
    expect(mod.isFontAvailable('Anything')).toBe(false);
  });

  it('returns true when the primary font measures differently from sans-serif', async () => {
    const ctx = makeCtx(['DistinctFont']);
    const { mod } = await freshModule(ctx);
    expect(mod.isFontAvailable('DistinctFont')).toBe(true);
  });

  it('returns false when the primary font matches the sans-serif fallback width', async () => {
    const ctx = makeCtx([]);
    const { mod } = await freshModule(ctx);
    expect(mod.isFontAvailable('MissingFont')).toBe(false);
  });

  it('caches results so repeated checks do not re-measure', async () => {
    const ctx = makeCtx(['CachedFont']);
    const { mod } = await freshModule(ctx);
    expect(mod.isFontAvailable('CachedFont')).toBe(true);
    const callsAfterFirst = ctx.measureText.mock.calls.length;
    expect(mod.isFontAvailable('CachedFont')).toBe(true);
    expect(ctx.measureText.mock.calls.length).toBe(callsAfterFirst);
  });

  it('uses the first comma-separated family and strips surrounding quotes', async () => {
    const ctx = makeCtx(['QuotedFont']);
    const { mod } = await freshModule(ctx);
    expect(mod.isFontAvailable('"QuotedFont", sans-serif')).toBe(true);
    expect(ctx.font).toBe('14px "QuotedFont", sans-serif');
  });
});
