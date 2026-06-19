import { describe, it, expect } from 'vitest';
import { normalizePath } from '../resolvePath';

describe('normalizePath', () => {
  it('resolves ../ and ./ against the document directory', () => {
    expect(normalizePath('/docs/talks', '../img/x.png')).toBe('/docs/img/x.png');
    expect(normalizePath('/docs/talks', './x.png')).toBe('/docs/talks/x.png');
    expect(normalizePath('/docs/talks', 'sub/y.png')).toBe('/docs/talks/sub/y.png');
    expect(normalizePath('/docs/a/b', '../../z.png')).toBe('/docs/z.png');
  });

  it("doesn't climb above the filesystem root", () => {
    expect(normalizePath('/docs', '../../../x.png')).toBe('/x.png');
  });

  it('keeps the Windows drive letter and uses backslashes', () => {
    expect(normalizePath('C:\\docs\\talks', '..\\img\\x.png')).toBe('C:\\docs\\img\\x.png');
  });
});
