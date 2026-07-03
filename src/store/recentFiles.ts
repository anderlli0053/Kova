// Most-recently-opened file paths, newest first. Feeds the File ▸ Open Recent
// submenu (macOS native menu + Windows/Linux in-window menu). App-managed
// state, not a user preference.

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

export function removeRecentFile(path: string): string[] {
  const next = loadRecentFiles().filter((p) => p !== path);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
  return next;
}

export function clearRecentFiles(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

export function recentFileBasename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Menu label; parent folder suffix when basename collisions exist in the list. */
export function recentFileMenuLabel(path: string, recents: string[]): string {
  const base = recentFileBasename(path);
  if (recents.filter((p) => recentFileBasename(p) === base).length <= 1) return base;
  const parts = path.replace(/\\/g, '/').split('/');
  const parent = parts.length >= 2 ? parts[parts.length - 2] : '';
  return parent ? `${base} (${parent})` : base;
}
