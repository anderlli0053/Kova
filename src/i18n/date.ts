import { resolveIntlLocale } from './locales';

// Fallback for decks with no frontmatter `date:` — used to be a hardcoded
// ISO string (issue #55 fallback was flagged as unfriendly for non-technical
// readers). Intl.DateTimeFormat knows each locale's conventional field order
// (MM/DD/YYYY for en-US, DD.MM.YYYY for de, etc.) but also varies the
// separator/punctuation, which reads as inconsistent next to the app's fixed
// UI chrome — so we take just the field order from formatToParts and join
// with a fixed "-", rather than using the locale's own separator.
export function formatFallbackDate(locale: string, date: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat(resolveIntlLocale(locale), {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    return parts
      .filter((p) => p.type === 'year' || p.type === 'month' || p.type === 'day')
      .map((p) => p.value)
      .join('-');
  } catch {
    return date.toISOString().slice(0, 10);
  }
}
