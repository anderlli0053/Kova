import { describe, it, expect } from 'vitest';
import en from '../en';
import { resolveKey, interpolate, createTranslator } from '../translate';

describe('resolveKey', () => {
  it('resolves a nested dotted key', () => {
    expect(resolveKey(en, 'common.cancel')).toBe('Cancel');
  });

  it('returns undefined for a missing key', () => {
    expect(resolveKey(en, 'does.not.exist')).toBeUndefined();
  });
});

describe('interpolate', () => {
  it('substitutes a single variable', () => {
    expect(interpolate('{{count}} words', { count: 42 })).toBe('42 words');
  });

  it('substitutes multiple variables', () => {
    expect(interpolate('{{current}} of {{total}}', { current: 2, total: 5 })).toBe('2 of 5');
  });

  it('leaves an unmatched placeholder untouched', () => {
    expect(interpolate('{{count}} words', {})).toBe('{{count}} words');
  });

  it('returns the template unchanged when no vars are given', () => {
    expect(interpolate('Cancel')).toBe('Cancel');
  });
});

describe('createTranslator', () => {
  it('resolves directly against English when activeMessages is null', () => {
    const t = createTranslator(null, 'en');
    expect(t('common.cancel')).toBe('Cancel');
  });

  it('returns the raw key for a key missing from English too', () => {
    const t = createTranslator(null, 'en');
    // @ts-expect-error intentionally bogus key to exercise the fallback path
    expect(t('nonexistent.key')).toBe('nonexistent.key');
  });

  it('falls back to English when a partial locale is missing a key', () => {
    const t = createTranslator({ common: {} }, 'sl');
    expect(t('common.cancel')).toBe('Cancel');
  });

  it('uses the locale\'s own string when present', () => {
    const t = createTranslator({ common: { cancel: 'Prekliči' } }, 'sl');
    expect(t('common.cancel')).toBe('Prekliči');
  });

  it('interpolates variables through a resolved key', () => {
    const t = createTranslator(null, 'en');
    expect(t('layout.wordCount', { count: 7 })).toBe('7 words');
  });
});

describe('createTranslator — pluralization (Intl.PluralRules)', () => {
  it('selects English one/other correctly', () => {
    const t = createTranslator(null, 'en');
    expect(t('layout.estimatedMinutes', { count: 1 })).toBe('Est. 1 min');
    expect(t('layout.estimatedMinutes', { count: 2 })).toBe('Est. 2 mins');
    expect(t('layout.estimatedMinutes', { count: 0 })).toBe('Est. 0 mins');
  });

  // Russian CLDR rule: one -> n%10=1 & n%100!=11; few -> n%10=2..4 & n%100 not 12..14;
  // many -> everything else integer; other -> fractions.
  it('selects the right Russian category (one/few/many)', () => {
    const ru = {
      layout: {
        estimatedMinutes: {
          one: '{{count}} минута',
          few: '{{count}} минуты',
          many: '{{count}} минут',
          other: '{{count}} минуты',
        },
      },
    };
    const t = createTranslator(ru, 'ru');
    expect(t('layout.estimatedMinutes', { count: 1 })).toBe('1 минута');   // one
    expect(t('layout.estimatedMinutes', { count: 2 })).toBe('2 минуты');   // few
    expect(t('layout.estimatedMinutes', { count: 5 })).toBe('5 минут');    // many
    expect(t('layout.estimatedMinutes', { count: 11 })).toBe('11 минут');  // many (teen exception)
    expect(t('layout.estimatedMinutes', { count: 21 })).toBe('21 минута'); // one (21 % 10 = 1)
  });

  // Slovenian CLDR rule: one -> n%100=1; two -> n%100=2; few -> n%100=3 or 4; other -> rest.
  it('selects the right Slovenian category (one/two/few/other)', () => {
    const sl = {
      layout: {
        estimatedMinutes: {
          one: '{{count}} minuta',
          two: '{{count}} minuti',
          few: '{{count}} minute',
          other: '{{count}} minut',
        },
      },
    };
    const t = createTranslator(sl, 'sl');
    expect(t('layout.estimatedMinutes', { count: 1 })).toBe('1 minuta');
    expect(t('layout.estimatedMinutes', { count: 2 })).toBe('2 minuti');
    expect(t('layout.estimatedMinutes', { count: 3 })).toBe('3 minute');
    expect(t('layout.estimatedMinutes', { count: 5 })).toBe('5 minut');
  });

  it('falls back to `other` when the selected category is missing from a partial locale', () => {
    // A locale that only bothered to translate `other` — still valid, per TRANSLATING.md.
    const partial = { layout: { estimatedMinutes: { other: '{{count}} min(y)' } } };
    const t = createTranslator(partial, 'ru');
    expect(t('layout.estimatedMinutes', { count: 2 })).toBe('2 min(y)'); // "few" missing -> other
  });

  it('falls back to the English plural object entirely if a locale entry has no forms at all', () => {
    const broken = { layout: { estimatedMinutes: {} } } as unknown as Parameters<typeof createTranslator>[0];
    const t = createTranslator(broken, 'ru');
    expect(t('layout.estimatedMinutes', { count: 1 })).toBe('Est. 1 min');
  });
});
