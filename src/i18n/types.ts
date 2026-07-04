import type { Messages } from './en';

export type { Messages };

export type Locale = string; // e.g. 'en', 'sl' — plain string so adding a
                              // locale file never requires touching this type.

// CLDR plural categories (Intl.PluralRules). Not every language uses every
// category — e.g. English only has one/other, Russian has one/few/many/other,
// Slovenian has one/two/few/other. `other` is the mandatory catch-all.
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

export interface PluralForms {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}

// A leaf in the Messages tree is either a plain string or a pluralized
// message (an object keyed by CLDR category) — both are "translatable units"
// as far as MessageKey/DeepPartial are concerned, so neither recurses further.
type Leaf = string | PluralForms;

// Flattens the nested Messages tree into dotted leaf-key paths, e.g.
// 'common.cancel' | 'presentation.previousSlide' | 'layout.estimatedMinutes' | ...
type DotPaths<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends Leaf
    ? `${Prefix}${K}`
    : DotPaths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type MessageKey = DotPaths<Messages>;

// Non-English locale files only need to translate the keys they've gotten to —
// missing ones fall back to English at lookup time. A translated PluralForms
// entry only needs the categories the target language's grammar requires;
// `other` is the recommended minimum but is left optional here so a partial
// locale file still type-checks — TRANSLATING.md explains why it should
// always be filled in in practice.
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends string
    ? string
    : T[K] extends PluralForms
      ? Partial<PluralForms>
      : DeepPartial<T[K]>;
};
