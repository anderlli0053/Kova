import type { Theme } from '../theme';
import { hexToHsl, hslToHex, defaultChartPalette, buildCScalePalette, piePaletteFromAccent } from '../theme';

export function parseChannels(bare6: string): [number, number, number] {
  return [parseInt(bare6.slice(0,2),16), parseInt(bare6.slice(2,4),16), parseInt(bare6.slice(4,6),16)];
}

function diagramContrastText(color: string): string {
  const [r, g, b] = parseChannels(color.replace('#', '').toUpperCase());
  return (0.2126 * r/255 + 0.7152 * g/255 + 0.0722 * b/255) > 0.35 ? '#111111' : '#FFFFFF';
}

function diagramMutedSecondary(primaryHex: string): string {
  const [h, s, l] = hexToHsl(primaryHex);
  return hslToHex(h, Math.min(s, 0.35), l < 0.5 ? Math.min(l + 0.20, 0.45) : Math.max(l - 0.20, 0.55));
}

// Builds a Mermaid `%%{init: ...}%%` pragma matching the slide's theme, for
// diagrams rendered outside the live preview (export-time cache misses on
// the PPTX and PDF paths).
export function buildExportMermaidInit(t: Theme): string {
  const c = t.colors;
  const ff = (stack: string) => stack.split(',')[0].trim().replace(/['"]/g, '');
  const customPalette = c.chart_colors && c.chart_colors.length > 0 ? c.chart_colors : null;
  let pie: Record<string, string>, cScale: Record<string, string>, xy: string;
  if (customPalette) {
    pie = {}; cScale = {};
    for (let i = 0; i < 12; i++) { pie[`pie${i + 1}`] = customPalette[i % customPalette.length]; cScale[`cScale${i}`] = customPalette[i % customPalette.length]; }
    xy = customPalette.join(',');
  } else {
    pie = piePaletteFromAccent(c.accent);
    cScale = buildCScalePalette(c.accent);
    xy = defaultChartPalette(c.accent).join(',');
  }
  const secondary = diagramMutedSecondary(c.primary);
  const tertiaryBg = c.code_bg;
  const vars = {
    primaryColor: c.primary, primaryTextColor: diagramContrastText(c.primary),
    primaryBorderColor: c.primary, lineColor: c.accent,
    secondaryColor: secondary, secondaryTextColor: diagramContrastText(secondary),
    tertiaryColor: tertiaryBg, tertiaryTextColor: diagramContrastText(tertiaryBg),
    background: c.background, mainBkg: c.primary, nodeBorder: c.primary,
    clusterBkg: tertiaryBg, titleColor: c.text, edgeLabelBackground: c.background,
    labelTextColor: c.text, signalColor: c.text, signalTextColor: c.text,
    fontFamily: ff(t.fonts.body), ...cScale, ...pie,
    pieTitleTextColor: c.text, pieSectionTextColor: c.title_text,
    pieLegendTextColor: c.text, pieStrokeColor: c.background,
    pieStrokeWidth: '2px', pieOpacity: '0.9',
    xyChart: {
      plotColorPalette: xy, titleColor: c.text, dataLabelColor: c.text,
      xAxisTitleColor: c.text, xAxisLabelColor: c.text, xAxisTickColor: c.text, xAxisLineColor: c.text,
      yAxisTitleColor: c.text, yAxisLabelColor: c.text, yAxisTickColor: c.text, yAxisLineColor: c.text,
    },
  };
  return `%%{init: ${JSON.stringify({ theme: 'base', themeVariables: vars })}}%%\n`;
}
