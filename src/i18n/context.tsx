import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { createTranslator } from './translate';
import type { Translator } from './translate';
import { getLocaleMessages, detectOsLocale } from './locales';

const I18nContext = createContext<Translator>(createTranslator(null, 'en'));

// Computes a translator directly from a locale, without going through
// I18nContext. Components that render <I18nProvider> themselves can't read
// it back via useT() — a Provider only supplies context to its descendants,
// not to the component that creates it — so they need this instead.
export function useLocaleTranslator(locale: string): Translator {
  return useMemo(() => {
    const resolved = locale === 'auto' ? detectOsLocale() : locale;
    const messages = resolved === 'en' ? null : getLocaleMessages(resolved);
    return createTranslator(messages, resolved);
  }, [locale]);
}

export function I18nProvider({ locale, children }: { locale: string; children: ReactNode }) {
  const t = useLocaleTranslator(locale);
  return <I18nContext.Provider value={t}>{children}</I18nContext.Provider>;
}

export function useT(): Translator {
  return useContext(I18nContext);
}
