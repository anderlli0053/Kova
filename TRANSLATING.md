# Translating Kova

Kova's UI text lives in [`src/i18n/en.ts`](src/i18n/en.ts) — a single nested
object of English strings, grouped by feature area (`presentation`,
`inspector`, `layout`, `editor`, `preview`, `modals`, `app`, `settings`,
`common`). Adding a new language means translating the *values* in that
tree; the app takes care of the rest, including making your language show up
in **Settings → Appearance → Display language**.

This grew out of [issue #125](https://github.com/KovaMD/Kova/issues/125),
where a contributor asked how to add a Slovenian translation. If that's you —
thank you, and here's the walkthrough.

## Adding a locale

1. **Copy the English file** to `src/i18n/locales/<code>.ts`, using the
   language's [ISO 639-1](https://en.wikipedia.org/wiki/List_of_ISO_639_language_codes)
   code, e.g. `src/i18n/locales/sl.ts` for Slovenian:

   ```bash
   cp src/i18n/en.ts src/i18n/locales/sl.ts
   ```

   The copy carries over `en.ts`'s boilerplate, which needs three small edits
   before you start translating:

   - Rename `const en` to match your locale, e.g. `const sl`.
   - Delete the `export type Messages = typeof en;` line — that type is only
     ever defined once, in the real `en.ts`; left in, it's dead code that
     doesn't do anything for your file.
   - Add the `DeepPartial<Messages>` type annotation (and its import) so
     TypeScript actually checks your file against the real key structure —
     without it, a typo'd key silently falls back to English at runtime
     instead of failing the build:

     ```ts
     // src/i18n/locales/sl.ts
     import type { DeepPartial } from '../types';
     import type { Messages } from '../en';

     const sl: DeepPartial<Messages> = {
       common: {
         cancel: 'Cancel',
         save: 'Save',
         // ...rest of the copied file, unchanged for now
       },
       // ...
     };

     export default sl;
     ```

   At this point nothing is translated yet — it's still the English copy,
   just reshaped so the next step's type-checking actually applies.

2. **Translate the string values.** Never rename, remove, or add keys — the
   app looks strings up by key (e.g. `presentation.previousSlide`), so a
   renamed key simply won't be found and the English fallback will show
   instead. You don't have to translate every value in one pass (see step 4)
   — for example, translating just two keys to start looks like:

   ```ts
   const sl: DeepPartial<Messages> = {
     common: {
       cancel: 'Prekliči',
       save: 'Shrani',
     },
     presentation: {
       previousSlide: 'Prejšnji (←)',
     },
     // ...
   };
   ```

3. **Keep every `{{placeholder}}` token intact.** Strings like
   `'{{count}} words'` or `'Slide {{current}} of {{total}}'` get real values
   substituted in at runtime — reposition the token to match your language's
   word order if needed, but don't delete or rename it.

4. **Partial translations are welcome.** You don't need to translate every
   key before opening a PR — anything left out (or the whole file, to start)
   automatically falls back to English. Typing your file as
   `DeepPartial<Messages>` (as in the example above) also means TypeScript
   will flag an accidentally misspelled key at build time.

5. **Pluralized messages need every plural form your language has, not just
   two.** A few keys (word counts, slide counts, warnings) aren't a plain
   string — they're an object keyed by [CLDR plural
   category](https://cldr.unicode.org/index/cldr-spec/plural-rules), e.g. in
   `en.ts`:

   ```ts
   estimatedMinutes: { one: 'Est. {{count}} min', other: 'Est. {{count}} mins' },
   ```

   English only distinguishes `one`/`other`, but plenty of languages need
   more categories, and the app selects between them automatically at
   runtime via [`Intl.PluralRules`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/PluralRules) —
   you just need to supply the right forms:

   - **Russian** (and other Slavic languages) has four: `one` (1, 21, 31…),
     `few` (2–4, 22–24…), `many` (0, 5–20, 25–30…), `other` (fractions):
     ```ts
     estimatedMinutes: {
       one: '{{count}} минута',   // 1, 21, 31...
       few: '{{count}} минуты',   // 2-4, 22-24...
       many: '{{count}} минут',   // 0, 5-20, 25-30...
       other: '{{count}} минуты', // fractional counts
     },
     ```
   - **Slovenian** has four, but different ones: `one` (n mod 100 = 1), `two`
     (n mod 100 = 2), `few` (n mod 100 = 3 or 4), `other` (everything else):
     ```ts
     estimatedMinutes: {
       one: '{{count}} minuta',
       two: '{{count}} minuti',
       few: '{{count}} minute',
       other: '{{count}} minut',
     },
     ```

   `other` is mandatory — it's the catch-all the app falls back to if a form
   for the selected category is missing, so always fill it in even if your
   language also uses `one`/`few`/`two`. If you're unsure which categories
   your language needs, check the [CLDR plural rules
   chart](https://www.unicode.org/cldr/charts/latest/supplemental/language_plural_rules.html)
   for your language code, or just ask in the PR — a reviewer can check.

6. **Register the locale** in [`src/i18n/locales.ts`](src/i18n/locales.ts):
   add one entry to the `LOCALES` array with the language's own name as the
   label (not translated — "Slovenščina", not "Slovenian"):

   ```ts
   import sl from './locales/sl';

   export const LOCALES: LocaleDef[] = [
     { code: 'en', label: 'English', messages: null },
     { code: 'sl', label: 'Slovenščina', messages: sl },
   ];
   ```

   It'll then appear automatically in the Settings language dropdown — no
   other wiring needed.

7. **Open a PR.** Mention in the description which sections (if any) you left
   in English, so a reviewer can spot-check they still read sensibly.

## What not to do

- Don't edit `src/i18n/en.ts` as part of a translation PR — it's the
  canonical source of truth every other locale is checked against. If a
  string in it is genuinely wrong or missing, open a separate issue.
- Don't add keys to your locale file that don't exist in `en.ts` — they're
  dead code; the lookup only ever reads keys that exist in English.
- Don't translate the language's own name in `UI_LOCALE_OPTIONS`/`LOCALES` —
  language names are conventionally shown in their own language everywhere
  (this is also why font family names elsewhere in the app are never
  translated).

## Out of scope for now

A handful of things aren't wired into this system yet, and don't need to be
for a locale contribution:

- A few error messages returned directly from the Rust backend
  (`src-tauri/src/commands.rs`, `src-tauri/src/file_io.rs`) are still English
  only.
- Native OS file-picker dialog filter names (e.g. "PowerPoint", "Markdown")
  render inside the operating system's own file dialog, not Kova's UI, so
  translating them has little effect and isn't part of this pass.
