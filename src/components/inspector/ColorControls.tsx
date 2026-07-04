import { useState } from 'react';
import type { ThemeColors } from '../../engine/theme';
import { defaultChartPalette } from '../../engine/theme';
import { useT } from '../../i18n';
import type { MessageKey } from '../../i18n';

interface Props {
  colors: ThemeColors;
  onChange: (key: keyof ThemeColors, value: string) => void;
  onChartColorChange: (index: number, value: string) => void;
  onChartPaletteReset: () => void;
}

const COLOR_FIELDS: Array<{ key: keyof ThemeColors; labelKey: MessageKey }> = [
  { key: 'primary',     labelKey: 'inspector.colorPrimary' },
  { key: 'accent',      labelKey: 'inspector.colorAccent' },
  { key: 'background',  labelKey: 'inspector.colorBackground' },
  { key: 'text',        labelKey: 'inspector.colorText' },
  { key: 'title_text',  labelKey: 'inspector.colorTitleText' },
  { key: 'section_bg',  labelKey: 'inspector.colorSectionBg' },
  { key: 'code_bg',     labelKey: 'inspector.colorCodeBg' },
];

const CHART_PALETTE_SIZE = 8;

const colorRowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };
const colorInputStyle: React.CSSProperties = {
  width: 26, height: 20, padding: 1,
  border: '1px solid var(--border-input)',
  borderRadius: 3, background: 'none', cursor: 'pointer',
};
const hexLabelStyle: React.CSSProperties = {
  fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace', width: 52,
};

export function ColorControls({ colors, onChange, onChartColorChange, onChartPaletteReset }: Props) {
  const t = useT();
  const [chartOpen, setChartOpen] = useState(false);

  const chartColors = colors.chart_colors && colors.chart_colors.length === CHART_PALETTE_SIZE
    ? colors.chart_colors
    : defaultChartPalette(colors.accent, CHART_PALETTE_SIZE);

  const hasCustomPalette = Array.isArray(colors.chart_colors) && colors.chart_colors.length === CHART_PALETTE_SIZE;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {COLOR_FIELDS.map(({ key, labelKey }) => (
        <div key={key} style={colorRowStyle}>
          <label
            htmlFor={`color-${key}`}
            style={{ fontSize: 11, color: 'var(--text-label)', flex: 1, cursor: 'pointer' }}
          >
            {t(labelKey)}
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              id={`color-${key}`}
              type="color"
              value={colors[key] as string}
              onChange={(e) => onChange(key, e.target.value)}
              style={colorInputStyle}
            />
            <span style={hexLabelStyle}>{colors[key] as string}</span>
          </div>
        </div>
      ))}

      {/* Collapsible diagram palette */}
      <div style={{ marginTop: 4, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
        <button
          onClick={() => setChartOpen((o) => !o)}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            width: '100%', background: 'none', border: 'none', padding: 0,
            cursor: 'pointer', marginBottom: chartOpen ? 6 : 0,
          }}
        >
          <span style={{ fontSize: 11, color: 'var(--text-label)' }}>
            {t('inspector.diagramPalette')}{hasCustomPalette ? ' *' : ''}
          </span>
          <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>{chartOpen ? '▲' : '▼'}</span>
        </button>

        {chartOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {chartColors.map((color, i) => (
              <div key={i} style={colorRowStyle}>
                <label
                  htmlFor={`chart-color-${i}`}
                  style={{ fontSize: 11, color: 'var(--text-label)', flex: 1, cursor: 'pointer' }}
                >
                  {t('inspector.chartColorLabel', { n: i + 1 })}
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input
                    id={`chart-color-${i}`}
                    type="color"
                    value={color}
                    onChange={(e) => onChartColorChange(i, e.target.value)}
                    style={colorInputStyle}
                  />
                  <span style={hexLabelStyle}>{color}</span>
                </div>
              </div>
            ))}
            {hasCustomPalette && (
              <button
                onClick={onChartPaletteReset}
                style={{
                  marginTop: 2, fontSize: 10, color: 'var(--text-dim)',
                  background: 'none', border: 'none', cursor: 'pointer',
                  padding: 0, textAlign: 'left', textDecoration: 'underline',
                }}
              >
                {t('inspector.resetToThemeDefaults')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
