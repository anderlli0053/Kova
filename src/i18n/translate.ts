import en from './en';
import type { Messages, MessageKey, DeepPartial, PluralForms, PluralCategory } from './types';

export function resolveKey(tree: unknown, key: string): string | PluralForms | undefined {
  return key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    tree,
  ) as string | PluralForms | undefined;
}

export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    if (!(name in vars)) {
      if (import.meta.env.DEV) console.warn(`[i18n] "${template}" references {{${name}}} but no value was passed`);
      return match;
    }
    return String(vars[name]);
  });
}

function isPluralForms(value: string | PluralForms): value is PluralForms {
  return typeof value === 'object';
}

// `other` is the CLDR-mandated catch-all — every language's rules resolve to
// it for at least some counts, so a form missing the selected category (a
// language whose grammar doesn't distinguish it, e.g. English has no `few`)
// falls back to `other` rather than failing the lookup.
function selectPluralForm(forms: PluralForms, category: PluralCategory): string | undefined {
  return forms[category] ?? forms.other;
}

function makePluralRules(locale: string): Intl.PluralRules {
  try {
    return new Intl.PluralRules(locale);
  } catch {
    return new Intl.PluralRules('en');
  }
}

const enPluralRules = makePluralRules('en');

export type Translator = (key: MessageKey, vars?: Record<string, string | number>) => string;

// `locale` is only used to name the locale in dev-mode fallback warnings and
// to pick that locale's CLDR plural rules.
export function createTranslator(activeMessages: DeepPartial<Messages> | null, locale: string): Translator {
  const activePluralRules = activeMessages ? makePluralRules(locale) : enPluralRules;

  return (key, vars) => {
    let raw = activeMessages ? resolveKey(activeMessages, key) : undefined;
    let rulesForRaw = activePluralRules;
    if (raw === undefined && activeMessages && import.meta.env.DEV) {
      console.warn(`[i18n] locale "${locale}" is missing key "${key}" — falling back to English`);
    }
    if (raw === undefined) {
      raw = resolveKey(en, key);
      rulesForRaw = enPluralRules;
    }
    if (raw === undefined) {
      if (import.meta.env.DEV) console.warn(`[i18n] missing key "${key}" — not found in English resource either (check for a typo)`);
      return key; // visibly broken in the UI, easy to spot — better than blank/undefined
    }

    if (!isPluralForms(raw)) return interpolate(raw, vars);

    const count = typeof vars?.count === 'number' ? vars.count : 0;
    const category = rulesForRaw.select(count) as PluralCategory;
    let template = selectPluralForm(raw, category);
    if (template === undefined) {
      // Locale entry is missing even `other` (a malformed contribution) —
      // fall all the way back to English's version of this same key.
      const enRaw = resolveKey(en, key);
      if (enRaw && isPluralForms(enRaw)) {
        template = selectPluralForm(enRaw, enPluralRules.select(count) as PluralCategory);
      }
    }
    if (template === undefined) {
      if (import.meta.env.DEV) console.warn(`[i18n] pluralized key "${key}" has no usable form for count ${count}`);
      return key;
    }
    return interpolate(template, vars);
  };
}
