import type { FormatCmd } from '../layout/EditorPanel';
import { useT } from '../../i18n';

interface Props {
  onFormat: (cmd: FormatCmd) => void;
}

function Btn({
  label, title, onClick, style,
}: { label: string; title: string; onClick: () => void; style?: React.CSSProperties }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 24,
        padding: '0 2px',
        fontSize: 11,
        borderRadius: 3,
        border: '1px solid var(--btn-border)',
        background: 'var(--bg-input)',
        color: 'var(--text-secondary)',
        cursor: 'pointer',
        lineHeight: 1,
        ...style,
      }}
    >
      {label}
    </button>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4, marginTop: 8 }}>
      {children}
    </div>
  );
}

export function FormatControls({ onFormat }: Props) {
  const t = useT();
  const f = onFormat;

  return (
    <div>
      <Label>{t('inspector.headingsLabel')}</Label>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 3 }}>
        {([1, 2, 3, 4, 5, 6] as const).map((n) => (
          <Btn key={n} label={`H${n}`} title={t('inspector.headingTitle', { level: n })} onClick={() => f({ type: 'heading', level: n })}
            style={{ fontSize: n <= 2 ? 12 : n <= 4 ? 11 : 10, fontWeight: 700 }}
          />
        ))}
      </div>

      <Label>{t('inspector.inlineLabel')}</Label>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 3 }}>
        <Btn label="B"  title={t('inspector.bold')}          onClick={() => f({ type: 'bold' })}          style={{ fontWeight: 700 }} />
        <Btn label="I"  title={t('inspector.italic')}        onClick={() => f({ type: 'italic' })}        style={{ fontStyle: 'italic' }} />
        <Btn label="U"  title={t('inspector.underline')}     onClick={() => f({ type: 'underline' })}     style={{ textDecoration: 'underline' }} />
        <Btn label="S"  title={t('inspector.strikethrough')} onClick={() => f({ type: 'strikethrough' })} style={{ textDecoration: 'line-through' }} />
        <Btn label="`"  title={t('inspector.inlineCode')}    onClick={() => f({ type: 'code' })}          style={{ fontFamily: 'monospace' }} />
      </div>

      <Label>{t('inspector.blockLabel')}</Label>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 3 }}>
        <Btn label="UL"   title={t('inspector.bulletList')}     onClick={() => f({ type: 'ul' })} />
        <Btn label="OL"   title={t('inspector.numberedList')}   onClick={() => f({ type: 'ol' })} />
        <Btn label="❝"    title={t('inspector.blockquote')}     onClick={() => f({ type: 'blockquote' })} />
        <Btn label="—"    title={t('inspector.horizontalRule')} onClick={() => f({ type: 'hr' })} />
      </div>

    </div>
  );
}
