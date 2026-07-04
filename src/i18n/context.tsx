import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { createTranslator } from './translate';
import type { Translator } from './translate';
import { getLocaleMessages, detectOsLocale } from './locales';

const I18nContext = createContext<Translator>(createTranslator(null, 'en'));

export function I18nProvider({ locale, children }: { locale: string; children: ReactNode }) {
  const t = useMemo(() => {
    const resolved = locale === 'auto' ? detectOsLocale() : locale;
    const messages = resolved === 'en' ? null : getLocaleMessages(resolved);
    return createTranslator(messages, resolved);
  }, [locale]);
  return <I18nContext.Provider value={t}>{children}</I18nContext.Provider>;
}

export function useT(): Translator {
  return useContext(I18nContext);
}
