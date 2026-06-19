// Most-recently-opened file paths, newest first. Feeds the macOS native
// "File ▸ Open Recent" submenu. App-managed state, not a user preference.

const KEY = 'kova:recentFiles';
const MAX = 10;

export function loadRecentFiles(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string').slice(0, MAX) : [];
  } catch {
    return [];
  }
}

// Prepend `path` (deduped), cap at MAX, persist, return the new list.
export function addRecentFile(path: string): string[] {
  const next = [path, ...loadRecentFiles().filter((p) => p !== path)].slice(0, MAX);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* full/unavailable — recents are a convenience */ }
  return next;
}

export function clearRecentFiles(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
