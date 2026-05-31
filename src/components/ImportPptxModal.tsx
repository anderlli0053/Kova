import { useState, useRef } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { parsePptx } from '../engine/import/parsePptx';
import { pptxToMarkdown } from '../engine/import/pptxToMarkdown';

// ── Types ─────────────────────────────────────────────────────────────────────

type Step = 'select' | 'processing' | 'done' | 'error';

interface DoneState {
  slideCount: number;
  warnings: string[];
  markdown: string;
  savedPath: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const CHECK = '✓';
const CROSS  = '✗';

const WILL_IMPORT: string[] = [
  'Slide content and order',
  'Text — titles, body, bullet lists',
  'Images (extracted and saved locally)',
  'Tables',
];

const WONT_IMPORT: string[] = [
  'Themes, colours, and fonts — apply a Kova theme after import',
  'Animations and transitions',
  'SmartArt diagrams',
  'Charts and graphs',
  'Speaker notes',
  'Slide backgrounds and decorative shapes',
];

// ── Modal ─────────────────────────────────────────────────────────────────────

interface ImportPptxModalProps {
  onImported: (markdown: string, savedPath: string) => void;
  onClose: () => void;
}

export function ImportPptxModal({ onImported, onClose }: ImportPptxModalProps) {
  const [step, setStep]             = useState<Step>('select');
  const [pptxPath, setPptxPath]     = useState<string>('');
  const [progress, setProgress]     = useState('');
  const [doneState, setDoneState]   = useState<DoneState | null>(null);
  const [errorMsg, setErrorMsg]     = useState('');
  const warningsOpenRef             = useRef(false);
  const [warningsOpen, setWarningsOpen] = useState(false);

  // ── File picker ─────────────────────────────────────────────────────────────
  const handleBrowse = async () => {
    const selected = await open({
      filters: [{ name: 'PowerPoint', extensions: ['pptx'] }],
      multiple: false,
    });
    if (selected && typeof selected === 'string') setPptxPath(selected);
  };

  // ── Main import flow ─────────────────────────────────────────────────────────
  const handleImport = async () => {
    if (!pptxPath) return;

    // Ask for save destination first
    const defaultName = pptxPath.split(/[\\/]/).pop()?.replace(/\.pptx$/i, '.md') ?? 'imported.md';
    const destPath = await save({
      filters: [{ name: 'Markdown', extensions: ['md'] }],
      defaultPath: defaultName,
    });
    if (!destPath) return; // user cancelled

    const savePath = destPath.toLowerCase().endsWith('.md') ? destPath : `${destPath}.md`;
    const destDir  = savePath.replace(/[\\/][^\\/]+$/, ''); // parent directory

    setStep('processing');
    setProgress('Reading file…');

    try {
      setProgress('Parsing slides…');
      const parseResult = await parsePptx(pptxPath, destDir);

      setProgress('Generating markdown…');
      const markdown = pptxToMarkdown(parseResult);

      setProgress('Saving file…');
      await invoke('write_file', { path: savePath, content: markdown });

      setDoneState({
        slideCount: parseResult.slides.length,
        warnings: parseResult.warnings,
        markdown,
        savedPath: savePath,
      });
      setStep('done');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('password') || msg.toLowerCase().includes('encrypted')) {
        setErrorMsg('This file is password-protected and cannot be imported.');
      } else {
        setErrorMsg(msg);
      }
      setStep('error');
    }
  };

  const handleOpenInEditor = () => {
    if (doneState) onImported(doneState.markdown, doneState.savedPath);
  };

  // ── Shared overlay ────────────────────────────────────────────────────────────

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'var(--backdrop)', zIndex: 2000 }}
      />
      <div style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
        background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8,
        boxShadow: '0 16px 48px rgba(0,0,0,0.6)', zIndex: 2001,
        width: 460, maxWidth: '94vw', maxHeight: '90vh',
        display: 'flex', flexDirection: 'column',
      }}>

        {/* ── Select step ── */}
        {step === 'select' && (
          <>
            <div style={{ padding: '20px 24px 0', flexShrink: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
                Import from PowerPoint
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                Convert a .pptx file to a Kova presentation. Layout will be
                approximated — you may need to adjust some slides manually.
              </div>
            </div>

            {/* File picker row */}
            <div style={{ padding: '16px 24px 0', flexShrink: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                PowerPoint file
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{
                  flex: 1, padding: '6px 10px', fontSize: 12,
                  background: 'var(--bg-input)', border: '1px solid var(--border-alt)',
                  borderRadius: 4, color: pptxPath ? 'var(--text-primary)' : 'var(--text-secondary)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  cursor: 'pointer',
                }} onClick={handleBrowse} title={pptxPath || undefined}>
                  {pptxPath ? pptxPath.split(/[\\/]/).pop() : 'No file selected'}
                </div>
                <button className="btn" onClick={handleBrowse} style={{ flexShrink: 0 }}>
                  Browse…
                </button>
              </div>
            </div>

            {/* What will / won't be imported */}
            <div style={{ padding: '16px 24px 0', overflowY: 'auto', flex: 1 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    What will be imported
                  </div>
                  {WILL_IMPORT.map((item) => (
                    <div key={item} style={{ display: 'flex', gap: 6, marginBottom: 5, fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.4 }}>
                      <span style={{ color: '#4caf50', flexShrink: 0 }}>{CHECK}</span>
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    What will not be imported
                  </div>
                  {WONT_IMPORT.map((item) => (
                    <div key={item} style={{ display: 'flex', gap: 6, marginBottom: 5, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                      <span style={{ color: 'var(--text-tertiary, var(--text-secondary))', flexShrink: 0 }}>{CROSS}</span>
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div style={{ padding: '16px 24px', display: 'flex', justifyContent: 'flex-end', gap: 8, flexShrink: 0 }}>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button
                className="btn btn-primary"
                disabled={!pptxPath}
                onClick={handleImport}
              >
                Continue
              </button>
            </div>
          </>
        )}

        {/* ── Processing step ── */}
        {step === 'processing' && (
          <div style={{ padding: 32, textAlign: 'center' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>
              Importing…
            </div>
            <div style={{
              width: 32, height: 32, borderRadius: '50%',
              border: '3px solid var(--border-alt)',
              borderTopColor: 'var(--accent)',
              animation: 'spin 0.8s linear infinite',
              margin: '0 auto 16px',
            }} />
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{progress}</div>
          </div>
        )}

        {/* ── Done step ── */}
        {step === 'done' && doneState && (
          <>
            <div style={{ padding: '20px 24px 0', flexShrink: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
                Import complete
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {doneState.slideCount} slide{doneState.slideCount !== 1 ? 's' : ''} imported
              </div>
            </div>

            {doneState.warnings.length > 0 && (
              <div style={{ margin: '12px 24px 0', flexShrink: 0 }}>
                <button
                  style={{
                    width: '100%', textAlign: 'left', display: 'flex', justifyContent: 'space-between',
                    alignItems: 'center', padding: '8px 12px', fontSize: 12,
                    background: 'var(--bg-input)', border: '1px solid var(--border-alt)',
                    borderRadius: 4, color: 'var(--text-secondary)', cursor: 'pointer',
                  }}
                  onClick={() => { warningsOpenRef.current = !warningsOpenRef.current; setWarningsOpen(o => !o); }}
                >
                  <span>{doneState.warnings.length} item{doneState.warnings.length !== 1 ? 's' : ''} skipped</span>
                  <span>{warningsOpen ? '▲' : '▼'}</span>
                </button>
                {warningsOpen && (
                  <div style={{
                    maxHeight: 140, overflowY: 'auto',
                    padding: '8px 12px', fontSize: 11, lineHeight: 1.6,
                    background: 'var(--bg-input)', borderRadius: '0 0 4px 4px',
                    border: '1px solid var(--border-alt)', borderTop: 'none',
                    color: 'var(--text-secondary)',
                  }}>
                    {doneState.warnings.map((w, i) => <div key={i}>{w}</div>)}
                  </div>
                )}
              </div>
            )}

            <div style={{ padding: '8px 24px 4px', flex: 1, display: 'flex', alignItems: 'center' }}>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                Saved to: <span style={{ color: 'var(--text-primary)', wordBreak: 'break-all' }}>{doneState.savedPath}</span>
              </div>
            </div>

            <div style={{ padding: '12px 24px 20px', display: 'flex', justifyContent: 'flex-end', gap: 8, flexShrink: 0 }}>
              <button className="btn" onClick={onClose}>Close</button>
              <button className="btn btn-primary" onClick={handleOpenInEditor}>
                Open in Editor
              </button>
            </div>
          </>
        )}

        {/* ── Error step ── */}
        {step === 'error' && (
          <>
            <div style={{ padding: '20px 24px 0', flexShrink: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
                Import failed
              </div>
            </div>
            <div style={{ padding: '12px 24px', flex: 1 }}>
              <div style={{
                padding: '10px 14px', fontSize: 12, lineHeight: 1.6,
                background: 'var(--bg-input)', borderRadius: 4,
                border: '1px solid var(--border-alt)',
                color: '#e06c75',
              }}>
                {errorMsg}
              </div>
            </div>
            <div style={{ padding: '0 24px 20px', display: 'flex', justifyContent: 'flex-end', gap: 8, flexShrink: 0 }}>
              <button className="btn" onClick={() => setStep('select')}>Back</button>
              <button className="btn" onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>

      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </>
  );
}
