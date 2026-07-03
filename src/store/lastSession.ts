// Tracks the most recently open file and slide position, independent of user
// settings — this is app-managed session state, not a preference. Only acted
// on at startup, and only when settings.startupBehavior is 'reopenLast'.

export interface LastSession {
  path: string;
  slideIndex: number;
}

const STORAGE_KEY = 'kova:lastSession';

export function loadLastSession(): LastSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastSession>;
    if (typeof parsed.path === 'string' && typeof parsed.slideIndex === 'number') {
      return { path: parsed.path, slideIndex: parsed.slideIndex };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveLastSession(session: LastSession | null): void {
  try {
    if (!session) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // localStorage unavailable/full — last-session restore is a convenience,
    // not a correctness requirement, so fail silently.
  }
}
