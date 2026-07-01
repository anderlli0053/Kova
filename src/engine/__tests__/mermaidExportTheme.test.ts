import { describe, it, expect } from 'vitest';
import { parseChannels, buildExportMermaidInit } from '../export/mermaidExportTheme';
import { DEFAULT_THEME } from '../theme';

describe('parseChannels', () => {
  it('parses a 6-character hex string into RGB components', () => {
    expect(parseChannels('FF8040')).toEqual([255, 128, 64]);
    expect(parseChannels('000000')).toEqual([0, 0, 0]);
  });
});

describe('buildExportMermaidInit', () => {
  it('emits a mermaid init pragma with base theme variables from the slide theme', () => {
    const init = buildExportMermaidInit(DEFAULT_THEME);
    expect(init).toMatch(/^%%\{init: /);
    expect(init).toContain('"theme":"base"');
    expect(init).toContain(DEFAULT_THEME.colors.primary);
    expect(init).toContain(DEFAULT_THEME.colors.background);
    expect(init).toContain('"fontFamily"');
    expect(init).toContain('"xyChart"');
  });

  it('uses chart_colors from the theme when provided', () => {
    const theme = {
      ...DEFAULT_THEME,
      colors: {
        ...DEFAULT_THEME.colors,
        chart_colors: ['#111111', '#222222', '#333333'],
      },
    };
    const init = buildExportMermaidInit(theme);
    expect(init).toContain('#111111');
    expect(init).toContain('#222222');
    expect(init).toContain('#333333');
  });
});
