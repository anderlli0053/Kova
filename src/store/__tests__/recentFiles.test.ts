import { describe, it, expect } from 'vitest';
import { recentFileBasename, recentFileMenuLabel } from '../recentFiles';

describe('recentFileBasename', () => {
  it('returns the last path segment', () => {
    expect(recentFileBasename('/docs/talk.md')).toBe('talk.md');
    expect(recentFileBasename('C:\\Users\\me\\talk.md')).toBe('talk.md');
  });
});

describe('recentFileMenuLabel', () => {
  it('returns basename when unique', () => {
    expect(recentFileMenuLabel('/a/one.md', ['/a/one.md', '/b/two.md'])).toBe('one.md');
  });

  it('adds parent folder when basenames collide', () => {
    const recents = ['/projects/a/notes.md', '/archive/b/notes.md'];
    expect(recentFileMenuLabel(recents[0], recents)).toBe('notes.md (a)');
    expect(recentFileMenuLabel(recents[1], recents)).toBe('notes.md (b)');
  });
});
