import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectOsLanguage } from '../spellcheck/spellChecker';

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
