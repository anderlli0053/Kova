import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  detectOsLanguage,
  initSpellChecker,
  isSpellCheckerReady,
  spellCheck,
  addCustomWord,
  removeCustomWord,
  ignoreSpellingFor,
  getCustomWords,
} from '../spellcheck/spellChecker';

// Mock the dictionary engine so it reports every word misspelled except
// "correct" — this lets the custom-word / ignore overrides be observed.
vi.mock('typo-js', () => ({
  default: class {
    check(word: string) { return word === 'correct'; }
    suggest() { return []; }
  },
}));

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

// Runs before any dictionary is initialised, so `active` is still null.
describe('spellCheck before initialisation', () => {
  it('reports ready=false and treats every word as correct', () => {
    expect(isSpellCheckerReady()).toBe(false);
    expect(spellCheck('definitelynotaword')).toBe(true);
  });
});

describe('custom words and ignore list', () => {
  beforeEach(async () => {
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '' })));
    await initSpellChecker('en_US');
  });

  it('marks the dictionary ready and flags unknown words after init', () => {
    expect(isSpellCheckerReady()).toBe(true);
    expect(spellCheck('mispeld')).toBe(false);
  });

  it('addCustomWord makes spellCheck return true for that word', () => {
    expect(spellCheck('kova')).toBe(false);
    addCustomWord('kova');
    expect(spellCheck('kova')).toBe(true);
    expect(getCustomWords()).toContain('kova');
  });

  it('ignoreSpellingFor persists across repeated checks', () => {
    ignoreSpellingFor('teh');
    expect(spellCheck('teh')).toBe(true);
    expect(spellCheck('teh')).toBe(true);
  });

  it('removeCustomWord drops the word from the custom set', () => {
    addCustomWord('widgetly');
    expect(getCustomWords()).toContain('widgetly');
    removeCustomWord('widgetly');
    expect(getCustomWords()).not.toContain('widgetly');
    expect(spellCheck('widgetly')).toBe(false);
  });
});
