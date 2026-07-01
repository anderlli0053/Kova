import { describe, it, expect, vi, afterEach } from 'vitest';

type StyleEl = { tagName: string; dataset: Record<string, string>; textContent: string };

type BundledMod = typeof import('../bundledFonts');

function stubDocument() {
  const appended: StyleEl[] = [];
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      const el: StyleEl = { tagName: tag.toUpperCase(), dataset: {}, textContent: '' };
      return el;
    },
    head: {
      appendChild(el: StyleEl) { appended.push(el); },
    },
  });
  return appended;
}

async function freshModule(): Promise<{ mod: BundledMod; styles: StyleEl[] }> {
  const styles = stubDocument();
  vi.resetModules();
  const mod = await import('../bundledFonts');
  return { mod, styles };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('registerCachedFont', () => {
  const convert = (path: string) => `asset://${path}`;

  it('injects a @font-face rule using convertFileSrc for the cached path', async () => {
    const { mod, styles } = await freshModule();
    mod.registerCachedFont('Inter', '/cache/inter.woff2', '400', 'normal', 'abc123', convert);

    expect(styles).toHaveLength(1);
    expect(styles[0].dataset.remoteFont).toBe('Inter');
    expect(styles[0].textContent).toContain('font-family: "Inter"');
    expect(styles[0].textContent).toContain('src: url("asset:///cache/inter.woff2")');
    expect(styles[0].textContent).toContain('font-weight: 400');
    expect(styles[0].textContent).toContain('font-style: normal');
  });

  it('sanitises a weight string containing CSS metacharacters to normal', async () => {
    const { mod, styles } = await freshModule();
    mod.registerCachedFont('Evil', '/cache/evil.woff2', '400; } body { display: none', 'normal', 'evil1', convert);

    expect(styles[0].textContent).toContain('font-weight: normal');
    expect(styles[0].textContent).not.toContain('display: none');
  });

  it('deduplicates by sha256 — the same hash does not inject twice', async () => {
    const { mod, styles } = await freshModule();
    mod.registerCachedFont('Inter', '/cache/inter.woff2', '400', 'normal', 'same-hash', convert);
    mod.registerCachedFont('Inter', '/cache/inter.woff2', '700', 'italic', 'same-hash', convert);

    expect(styles).toHaveLength(1);
    expect(styles[0].textContent).toContain('font-weight: 400');
  });
});
