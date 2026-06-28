import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

type MenuEntry =
  | { type: 'item'; label: string; shortcut?: string; action: () => void; disabled?: boolean }
  | { type: 'divider' }
  | { type: 'header'; label: string }
  | { type: 'submenu'; label: string; entries: MenuEntry[] };

interface Props {
  x: number;
  y: number;
  onClose: () => void;
  entries: MenuEntry[];
  onPanelEnter?: () => void;
  onPanelLeave?: () => void;
}

const MENU_WIDTH = 205;

export function EditorContextMenu({ x, y, onClose, entries, onPanelEnter, onPanelLeave }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [openSubmenuIdx, setOpenSubmenuIdx] = useState<number | null>(null);
  const [submenuPos, setSubmenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const isRoot = !onPanelEnter;

  const cx = Math.min(x, window.innerWidth - MENU_WIDTH - 8);
  const [cy, setCy] = useState(y);

  // Indices into `entries` that are keyboard-navigable (non-disabled items and submenus).
  const focusableIndices = useMemo(
    () => entries.reduce<number[]>((acc, e, i) => {
      if ((e.type === 'item' && !e.disabled) || e.type === 'submenu') acc.push(i);
      return acc;
    }, []),
    [entries],
  );

  useLayoutEffect(() => {
    if (ref.current) {
      const h = ref.current.offsetHeight;
      setCy(Math.min(y, window.innerHeight - h - 8));
    }
  }, [y]);

  useEffect(() => {
    if (!isRoot) return;
    // Auto-focus the first focusable item when the menu opens.
    if (focusableIndices.length > 0) {
      itemRefs.current[focusableIndices[0]]?.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const focused = document.activeElement;
      const pos = focusableIndices.findIndex((i) => itemRefs.current[i] === focused);
      const next = e.key === 'ArrowDown'
        ? (pos + 1) % focusableIndices.length
        : (pos - 1 + focusableIndices.length) % focusableIndices.length;
      itemRefs.current[focusableIndices[next]]?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, isRoot, focusableIndices]);

  function openSubmenu(i: number, el: HTMLDivElement) {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    const rect = el.getBoundingClientRect();
    const spaceRight = window.innerWidth - rect.right;
    const subX = spaceRight >= MENU_WIDTH + 4 ? rect.right + 2 : rect.left - MENU_WIDTH - 2;
    setSubmenuPos({ x: subX, y: rect.top });
    setOpenSubmenuIdx(i);
  }

  function scheduleClose() {
    closeTimerRef.current = setTimeout(() => setOpenSubmenuIdx(null), 150);
  }

  function cancelClose() {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }

  const panelStyle: React.CSSProperties = {
    position: 'fixed',
    left: cx,
    top: cy,
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-alt)',
    borderRadius: 6,
    padding: '4px 0',
    minWidth: MENU_WIDTH,
    zIndex: 9999,
    boxShadow: '0 6px 24px rgba(0,0,0,0.55)',
    fontSize: 13,
    color: 'var(--text-primary)',
    userSelect: 'none',
  };

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '5px 14px',
    margin: '0 4px',
    borderRadius: 3,
  };

  return (
    <>
      {isRoot && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
          onMouseDown={(e) => { e.preventDefault(); onClose(); }}
        />
      )}
      <div
        ref={ref}
        role="menu"
        aria-label="Context menu"
        style={panelStyle}
        onMouseEnter={onPanelEnter}
        onMouseLeave={onPanelLeave}
      >
        {entries.map((entry, i) => {
          if (entry.type === 'divider') {
            return <div key={i} role="separator" style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />;
          }
          if (entry.type === 'header') {
            return (
              <div key={i} role="none" style={{ padding: '5px 14px 2px', fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                {entry.label}
              </div>
            );
          }
          if (entry.type === 'submenu') {
            const isOpen = openSubmenuIdx === i;
            return (
              <div
                key={i}
                ref={(el) => { itemRefs.current[i] = el; }}
                role="menuitem"
                aria-haspopup="true"
                aria-expanded={isOpen}
                tabIndex={-1}
                style={{ ...rowStyle, cursor: 'pointer', background: isOpen ? 'var(--bg-hover)' : 'transparent' }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-hover)';
                  openSubmenu(i, e.currentTarget as HTMLDivElement);
                }}
                onMouseLeave={(e) => {
                  if (openSubmenuIdx !== i)
                    (e.currentTarget as HTMLDivElement).style.background = 'transparent';
                  scheduleClose();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
                    e.preventDefault();
                    openSubmenu(i, e.currentTarget as HTMLDivElement);
                  }
                }}
              >
                <span>{entry.label}</span>
                <span style={{ color: 'var(--text-dim)', fontSize: 10, marginLeft: 24 }}>▶</span>
              </div>
            );
          }
          return (
            <div
              key={i}
              ref={(el) => { itemRefs.current[i] = el; }}
              role="menuitem"
              aria-disabled={entry.disabled}
              tabIndex={-1}
              style={{ ...rowStyle, cursor: entry.disabled ? 'default' : 'pointer', opacity: entry.disabled ? 0.35 : 1 }}
              onMouseDown={(e) => {
                e.preventDefault();
                if (!entry.disabled) { entry.action(); onClose(); }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (!entry.disabled) { entry.action(); onClose(); }
                }
              }}
              onMouseEnter={(e) => {
                if (!entry.disabled)
                  (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-hover)';
                scheduleClose();
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = 'transparent';
              }}
            >
              <span>{entry.label}</span>
              {entry.shortcut && (
                <span style={{ color: 'var(--text-dim)', fontSize: 11, marginLeft: 24 }}>{entry.shortcut}</span>
              )}
            </div>
          );
        })}
      </div>
      {openSubmenuIdx !== null && (() => {
        const entry = entries[openSubmenuIdx];
        if (entry?.type !== 'submenu') return null;
        return (
          <EditorContextMenu
            x={submenuPos.x}
            y={submenuPos.y}
            onClose={onClose}
            entries={entry.entries}
            onPanelEnter={cancelClose}
            onPanelLeave={scheduleClose}
          />
        );
      })()}
    </>
  );
}

export type { MenuEntry };
