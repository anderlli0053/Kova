import { describe, it, expect } from 'vitest';
import { extractFrontmatter, patchFrontmatter } from '../parser/frontmatter';

describe('extractFrontmatter', () => {
  it('parses scalar frontmatter and returns the body', () => {
    const { frontmatter, body } = extractFrontmatter('---\ntitle: Hello\nauthor: Ada\n---\n\n# Slide\n');
    expect(frontmatter.title).toBe('Hello');
    expect(frontmatter.author).toBe('Ada');
    expect(body).toBe('\n# Slide\n');
  });

  it('returns the full content as body when no frontmatter block exists', () => {
    const input = '# Just a slide\n\n- item';
    const { frontmatter, body } = extractFrontmatter(input);
    expect(frontmatter).toEqual({});
    expect(body).toBe(input);
  });

  it('handles CRLF line endings in the delimiter', () => {
    const { frontmatter, body } = extractFrontmatter('---\r\ntitle: CRLF\r\n---\r\n\r\n# Slide\r\n');
    expect(frontmatter.title).toBe('CRLF');
    expect(body).toBe('\r\n# Slide\r\n');
  });

  it('returns empty frontmatter on malformed YAML', () => {
    const input = '---\n: bad: yaml:\n---\n\n# Slide\n';
    const { frontmatter, body } = extractFrontmatter(input);
    expect(frontmatter).toEqual({});
    expect(body).toBe(input);
  });

  it('parses nested theme_overrides maps', () => {
    const input = [
      '---',
      'theme_overrides:',
      '  footer:',
      '    text: "Page {title}"',
      '    show_slide_number: true',
      '---',
      '',
      '# Slide',
    ].join('\n');
    const { frontmatter } = extractFrontmatter(input);
    expect(frontmatter.theme_overrides).toEqual({
      footer: { text: 'Page {title}', show_slide_number: true },
    });
  });
});

describe('patchFrontmatter', () => {
  it('updates an existing key without touching the body', () => {
    const input = '---\ntitle: Old\n---\n\n# Slide\n';
    const out = patchFrontmatter(input, { title: 'New' });
    expect(out).toMatch(/title: "?New"?/);
    expect(out).toContain('# Slide');
    expect(out).not.toContain('Old');
  });

  it('creates a frontmatter block when absent', () => {
    const out = patchFrontmatter('# Slide\n', { title: 'Created' });
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toMatch(/title: "?Created"?/);
    expect(out).toContain('# Slide\n');
  });

  it('removes keys when patch value is null or undefined', () => {
    const input = '---\ntitle: Keep\nauthor: Drop\ndate: 2024\n---\n\n# Slide\n';
    const out = patchFrontmatter(input, { author: null, date: undefined });
    expect(out).toMatch(/title: "?Keep"?/);
    expect(out).not.toMatch(/^author:/m);
    expect(out).not.toMatch(/^date:/m);
  });

  it('merges multiple keys in one patch', () => {
    const input = '---\ntitle: Old\n---\n\n# Slide\n';
    const out = patchFrontmatter(input, { title: 'New', author: 'Ada' });
    expect(out).toMatch(/title: "?New"?/);
    expect(out).toMatch(/author: "?Ada"?/);
  });

  it('preserves body content after the frontmatter block', () => {
    const input = '---\ntitle: T\n---\n\n# One\n\n---\n\n# Two\n';
    const out = patchFrontmatter(input, { title: 'Updated' });
    expect(out).toContain('# One');
    expect(out).toContain('# Two');
  });

  it('patches a key when the body starts immediately after the closing ---', () => {
    const input = '---\ntitle: Old\n---\n# Slide\n';
    const out = patchFrontmatter(input, { title: 'New' });
    expect(out).toMatch(/title: "?New"?/);
    expect(out).toContain('---\n');
    expect(out.endsWith('# Slide\n')).toBe(true);
    expect(out).not.toContain('\n\n# Slide');
  });

  it('preserves sibling keys inside theme_overrides when the patch carries the merged map', () => {
    const input = [
      '---',
      'theme_overrides:',
      '  footer:',
      '    text: "Old"',
      '    show_slide_number: true',
      '  colors:',
      '    primary: "#111"',
      '---',
      '# Slide',
    ].join('\n');
    const out = patchFrontmatter(input, {
      theme_overrides: {
        footer: { text: 'New', show_slide_number: true },
        colors: { primary: '#111' },
      },
    });
    expect(out).toMatch(/text: "?New"?/);
    expect(out).toMatch(/primary: "?#111"?/);
    expect(out).toContain('# Slide');
  });

  it('preserves CRLF line endings in the body on patch', () => {
    const input = '---\r\ntitle: Old\r\n---\r\n# Slide\r\n';
    const out = patchFrontmatter(input, { title: 'New' });
    expect(out).toMatch(/title: "?New"?/);
    expect(out.endsWith('# Slide\r\n')).toBe(true);
  });

  it('creates frontmatter with multiple keys when none existed', () => {
    const out = patchFrontmatter('# Slide\n', { title: 'Deck', author: 'Ada', date: 2024 });
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toMatch(/title: "?Deck"?/);
    expect(out).toMatch(/author: "?Ada"?/);
    expect(out).toMatch(/date: 2024/);
    expect(out.endsWith('# Slide\n')).toBe(true);
  });
});
