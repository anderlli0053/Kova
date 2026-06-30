import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectOsLanguage } from '../spellcheck/spellChecker';

// Mock the dictionary engine so it reports every word misspelled except
// "correct" — this lets the custom-word / ignore overrides be observed.
vi.mock('typo-js', () => ({
  default: class {
    check(word: string) { return word === 'correct'; }
    suggest() { return []; }
  },
}));

type SpellMod = typeof import('../spellcheck/spellChecker');

// spellChecker.ts keeps module-level singletons (customWords, ignored, active,
// currentLang) that nothing resets. Reset the module registry and re-import a
// fresh instance per test so state can't bleed between cases or make them
// order-sensitive. localStorage/fetch are stubbed before the fresh import so
// the module loads against a clean, isolated store.
async function freshModule(): Promise<SpellMod> {
  const store: Record<string, string> = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '' })));
  vi.resetModules();
  return import('../spellcheck/spellChecker');
}

function withLanguage(language: string) {
  vi.stubGlobal('navigator', { language });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('detectOsLanguage', () => {
  it('maps en-GB to en_GB', () => {
    withLanguage('en-GB');
    expect(detectOsLanguage()).toBe('en_GB');
  });

  it('maps de-DE to de_DE', () => {
    withLanguage('de-DE');
    expect(detectOsLanguage()).toBe('de_DE');
  });

  it('falls back to en_US for an unknown locale', () => {
    withLanguage('xx-YY');
    expect(detectOsLanguage()).toBe('en_US');
  });

  it('maps fr-CA to fr_FR via primary subtag', () => {
    withLanguage('fr-CA');
    expect(detectOsLanguage()).toBe('fr_FR');
  });
});

describe('spellCheck before initialisation', () => {
  it('reports ready=false and treats every word as correct', async () => {
    const mod = await freshModule();
    expect(mod.isSpellCheckerReady()).toBe(false);
    expect(mod.spellCheck('definitelynotaword')).toBe(true);
  });
});

describe('custom words and ignore list', () => {
  let mod: SpellMod;

  beforeEach(async () => {
    mod = await freshModule();
    await mod.initSpellChecker('en_US');
  });

  it('marks the dictionary ready and flags unknown words after init', () => {
    expect(mod.isSpellCheckerReady()).toBe(true);
    expect(mod.spellCheck('mispeld')).toBe(false);
  });

  it('addCustomWord makes spellCheck return true for that word', () => {
    expect(mod.spellCheck('kova')).toBe(false);
    mod.addCustomWord('kova');
    expect(mod.spellCheck('kova')).toBe(true);
    expect(mod.getCustomWords()).toContain('kova');
  });

  it('ignoreSpellingFor persists across repeated checks', () => {
    mod.ignoreSpellingFor('teh');
    expect(mod.spellCheck('teh')).toBe(true);
    expect(mod.spellCheck('teh')).toBe(true);
  });

  it('removeCustomWord drops the word from the custom set', () => {
    mod.addCustomWord('widgetly');
    expect(mod.getCustomWords()).toContain('widgetly');
    mod.removeCustomWord('widgetly');
    expect(mod.getCustomWords()).not.toContain('widgetly');
    expect(mod.spellCheck('widgetly')).toBe(false);
  });

  it('keeps custom words isolated between tests (no bleed from earlier cases)', () => {
    expect(mod.getCustomWords()).toEqual([]);
  });
});
