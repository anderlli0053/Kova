import { describe, it, expect, vi } from 'vitest';

// Mock the Tauri core import so importing EditorPanel doesn't need a backend.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { buildMediaSnippet } from '../EditorPanel';

const warn = () => {};

// Files already inside the document folder take the relative-path branch (no invoke).
describe('buildMediaSnippet', () => {
  it('emits !video[..] for a video next to the doc', async () => {
    expect(await buildMediaSnippet('/docs/clip.mp4', '/docs/talk.md', warn)).toBe('!video[clip](clip.mp4)');
  });

  it('emits ![..] for an image next to the doc', async () => {
    expect(await buildMediaSnippet('/docs/pic.png', '/docs/talk.md', warn)).toBe('![pic](pic.png)');
  });

  it('url-encodes spaces in the path', async () => {
    expect(await buildMediaSnippet('/docs/my clip.mov', '/docs/talk.md', warn)).toBe('!video[my clip](my%20clip.mov)');
  });
});
