import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { emit, emitTo, listen } from '@tauri-apps/api/event';
import { availableMonitors, currentMonitor, getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle, usePanelRef, useDefaultLayout } from 'react-resizable-panels';

import { ThumbnailPanel } from './components/layout/ThumbnailPanel';
import { EditorPanel } from './components/layout/EditorPanel';
import type { EditorHandle, FormatCmd } from './components/layout/EditorPanel';
import { InspectorPanel } from './components/layout/InspectorPanel';
import { StatusBar } from './components/layout/StatusBar';
import { PresentationOverlay } from './components/presentation/PresentationOverlay';
import { PresenterOverlay } from './components/presentation/PresenterOverlay';
import type { PresentInitPayload } from './AudienceApp';
import { SettingsModal } from './components/SettingsModal';
import { ThemeLibraryModal } from './components/inspector/ThemeLibraryModal';
import { ImportPptxModal } from './components/ImportPptxModal';
import { MissingThemeBanner } from './components/MissingThemeBanner';
import { loadSettings, saveSettings, EDITOR_FONT_OPTIONS } from './store/settings';
import type { AppSettings } from './store/settings';
import { loadKeybindings, matchShortcut, getCombo, formatCombo } from './engine/keybindings';
import type { Keybindings } from './engine/keybindings';

import { parseDocument } from './engine/parser/markdownToSlides';
import { extractFrontmatter, patchFrontmatter } from './engine/parser/frontmatter';
import { fetchUpdate } from './engine/updater';
import { exportToPptx } from './engine/export/exportPptx';
import { exportToPdf } from './engine/export/exportPdf';
import { SlideRenderer } from './components/preview/SlideRenderer';
import { BUILT_IN_THEMES, DEFAULT_THEME, parseThemeYaml, sanitiseThemeOverrides } from './engine/theme';
import { registerBundledFonts, registerCachedFont } from './engine/bundledFonts';
import type { Slide, Frontmatter, ListItem } from './engine/types';
import { parseAspectRatio } from './engine/types';
import type { Theme } from './engine/theme';

import './styles/global.css';

const isMac = /Mac/i.test(navigator.platform);

function resolveImageSrc(src: string, docDir: string): string {
  if (/^(https?|data|asset|tauri):\/\//i.test(src)) return src;
  // Decode any percent-encoding written by the editor (e.g. %20 for spaces).
  let p = src;
  try { p = decodeURIComponent(src); } catch { /* malformed — use as-is */ }
  // Already absolute — convert directly, no docDir needed.
  if (p.startsWith('/') || /^[A-Za-z]:[/\\]/.test(p)) return convertFileSrc(p);
  // Relative path — only resolvable when we know the document location.
  if (!docDir) return p;
  const sep = docDir.includes('\\') ? '\\' : '/';
  return convertFileSrc(docDir + (docDir.endsWith(sep) ? '' : sep) + p);
}

function resolveHtmlSrcs(html: string, docDir: string): string {
  return html.replace(/src="([^"]*)"/g, (_, src) => `src="${resolveImageSrc(src, docDir)}"`);
}

function makeStarter() {
  return `---
title: My Presentation
date: ${new Date().getFullYear()}
---

# My Presentation

---

## First Slide

- Point one
- Point two
- Point three
`;
}

function countWords(text: string): number {
  return (text.match(/\b\w+\b/g) ?? []).length;
}

const EMPTY_SLIDES: Slide[] = [];
const EMPTY_FM: Frontmatter = {};

export default function App() {
  const [filePath, setFilePath]           = useState<string | null>(null);
  const [content, setContent]             = useState('');
  const [isDirty, setIsDirty]             = useState(false);
  const [currentSlideIndex, setCurrentSlideIndex] = useState(0);
  const [focusMode, setFocusMode]         = useState(false);
  const [presentMode, setPresentMode]     = useState(false);
  const [settings, setSettings]           = useState<AppSettings>(loadSettings);
  const [showSettings, setShowSettings]   = useState(false);
  const [showThemeLibrary, setShowThemeMarketplace] = useState(false);
  const [showImport, setShowImport]       = useState(false);
  const [showInspector, setShowInspector] = useState(true);
  const [presenterMode, setPresenterMode] = useState(false);
  const [confirmCloseAction, setConfirmCloseAction] = useState<(() => void) | null>(null);
  const [availableUpdate, setAvailableUpdate] = useState<string | null>(null);
  const [keybindings, setKeybindings]     = useState<Keybindings>({ path: '', combos: {} });
  const [warnMessage, setWarnMessage]     = useState<string | null>(null);
  const warnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isRenaming, setIsRenaming]       = useState(false);
  const [renameValue, setRenameValue]     = useState('');
  const [resolvedUiTheme, setResolvedUiTheme] = useState<'dark' | 'light'>('dark');
  const [exportMenuOpen, setExportMenuOpen]   = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const [saveAsMenuOpen, setSaveAsMenuOpen]   = useState(false);
  const saveAsMenuRef = useRef<HTMLDivElement>(null);
  const [pdfExportContext, setPdfExportContext] = useState<{ slides: Slide[]; savePath: string } | null>(null);
  const pdfSlideRefs   = useRef<Map<number, HTMLElement>>(new Map());
  const pdfExportResolveRef = useRef<(() => void) | null>(null);

  // Theme state: active theme id + per-session overrides
  const [allThemes, setAllThemes]         = useState<Theme[]>(BUILT_IN_THEMES);
  const [activeThemeId, setActiveThemeId] = useState<string>(DEFAULT_THEME.id);
  const [themeOverrides, setThemeOverrides] = useState<Partial<Theme>>({});
  const [missingThemeId, setMissingThemeId]   = useState<string | null>(null);

  const installedRemoteIds = useMemo(
    () => new Set(allThemes.filter((t) => !BUILT_IN_THEMES.some((b) => b.id === t.id)).map((t) => t.id)),
    [allThemes],
  );

  // Resolved theme = base theme merged with overrides
  const activeTheme = useMemo<Theme>(() => {
    const base = allThemes.find((t) => t.id === activeThemeId) ?? DEFAULT_THEME;
    const merged: Theme = { ...base, ...themeOverrides,
      colors: { ...base.colors, ...(themeOverrides.colors ?? {}) },
      fonts:  { ...base.fonts,  ...(themeOverrides.fonts  ?? {}) },
      header: { ...base.header, ...(themeOverrides.header ?? {}) },
      footer: { ...base.footer, ...(themeOverrides.footer ?? {}) },
    };
    // Convert raw local path to display URL (asset://) for the logo
    if (merged.logo && !/^(https?:|data:|asset:|tauri:)/i.test(merged.logo)) {
      return { ...merged, logo: convertFileSrc(merged.logo) };
    }
    return merged;
  }, [allThemes, activeThemeId, themeOverrides]);

  // Register any bundled fonts declared by the active theme
  useEffect(() => {
    if (activeTheme.bundledFonts?.length) {
      registerBundledFonts(activeTheme.bundledFonts);
    }
  }, [activeTheme.bundledFonts]);

  // Download-once, verify, and register any remote fonts declared by the active theme.
  // Re-runs only on theme identity change since remoteFonts are theme-level, not overrides.
  useEffect(() => {
    const fonts = activeTheme.remoteFonts;
    if (!fonts?.length) return;
    for (const font of fonts) {
      invoke<string>('download_and_cache_font', { url: font.url, sha256: font.sha256 })
        .then((cachedPath) => {
          registerCachedFont(font.family, cachedPath, font.weight, font.style, font.sha256, convertFileSrc);
        })
        .catch((err) => {
          console.warn(`[kova] remote font "${font.family}" failed: ${err}`);
        });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThemeId]);

  // Persist panel layout across sessions and inspector toggle/hide
  const PANEL_IDS = ['thumb', 'editor', 'inspector'] as const;
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'kova-main',
    panelIds: [...PANEL_IDS],
  });

  // Panel refs for Focus Mode collapse
  const thumbPanelRef     = usePanelRef();
  const inspectorPanelRef = usePanelRef();
  const editorRef         = useRef<EditorHandle>(null);

  const handleFormat = useCallback((cmd: FormatCmd) => {
    editorRef.current?.runFormat(cmd);
  }, []);

  const handleThumbnailSelect = useCallback((index: number) => {
    setCurrentSlideIndex(index);
    editorRef.current?.scrollToSlide(index);
  }, []);

  const { slides: rawSlides, frontmatter } = useMemo(() => {
    if (!content.trim()) return { slides: EMPTY_SLIDES, frontmatter: EMPTY_FM };
    try { return parseDocument(content); }
    catch { return { slides: EMPTY_SLIDES, frontmatter: EMPTY_FM }; }
  }, [content]);

  // Body-only view for the editor — frontmatter is managed by the inspector.
  const editorBody = useMemo(() => extractFrontmatter(content).body, [content]);

  // When showFrontmatter is on, the editor receives the full document.
  // Ref is updated synchronously during render so handleContentChange (called
  // synchronously from CodeMirror's dispatch inside the [content] effect) always
  // sees the current value — a useEffect update would be too late.
  const showFrontmatterRef = useRef(settings.showFrontmatter);
  showFrontmatterRef.current = settings.showFrontmatter;
  const contentRef = useRef(content);
  contentRef.current = content;
  // Updated in render body (not useEffect) so the file-changed listener always
  // sees the current dirty state when it fires synchronously after a watcher event.
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;
  const editorContent = settings.showFrontmatter ? content : editorBody;

  // Rewrite relative image srcs to asset:// URLs so Tauri's WebView can load them.
  // Always runs — absolute paths need convertFileSrc even when no file is open.
  const slides = useMemo<Slide[]>(() => {
    const lastSlash = filePath
      ? Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
      : -1;
    const docDir = lastSlash >= 0 ? filePath!.substring(0, lastSlash) : '';

    function resolveItem(item: ListItem): ListItem {
      return { ...item, html: resolveHtmlSrcs(item.html, docDir), children: item.children.map(resolveItem) };
    }

    return rawSlides.map((slide) => ({
      ...slide,
      elements: slide.elements.map((el) => {
        if (el.type === 'image')     return { ...el, src: resolveImageSrc(el.src, docDir) };
        if (el.type === 'paragraph') return { ...el, html: resolveHtmlSrcs(el.html, docDir) };
        if (el.type === 'list')      return { ...el, items: el.items.map(resolveItem) };
        return el;
      }),
    }));
  }, [rawSlides, filePath]);

  // Compute a safe index in the same render as slides so children never receive
  // an out-of-bounds value during the frame before the clamp useEffect fires.
  const safeSlideIndex = slides.length > 0
    ? Math.min(currentSlideIndex, slides.length - 1)
    : 0;

  const aspectRatio = useMemo(
    () => parseAspectRatio(frontmatter.aspect_ratio as string | undefined),
    [frontmatter.aspect_ratio],
  );

  const wordCount = countWords(content);

  // Count image references that live outside the document's own folder.
  // These display fine locally but break if the .md file is moved without its images.
  const externalImageCount = useMemo(() => {
    if (!filePath) return 0;
    const sep = filePath.includes('\\') ? '\\' : '/';
    const docDir = filePath.substring(0, filePath.lastIndexOf(sep));
    const IMG_RE = /!\[[^\]]*\]\(([^\s)]+)/g;
    let count = 0;
    let m: RegExpExecArray | null;
    while ((m = IMG_RE.exec(content)) !== null) {
      const src = m[1];
      if (/^(https?|data|asset|tauri):\/\//i.test(src)) continue; // web / already-converted
      if (/^[A-Za-z]:[/\\]/.test(src) || src.startsWith('/')) {
        if (!src.startsWith(docDir)) count++;           // absolute path outside doc dir
      } else if (src.startsWith('..')) {
        count++;                                         // relative path escaping doc dir
      }
    }
    return count;
  }, [content, filePath]);
  const filePathRef = useRef(filePath);
  useEffect(() => { filePathRef.current = filePath; }, [filePath]);

  const reloadCustomThemes = useCallback(() => {
    invoke<[string, Array<[string, string]>]>('load_custom_themes')
      .then(([, entries]) => {
        const custom = entries
          .map(([id, yaml]) => parseThemeYaml(id, yaml))
          .filter((t): t is Theme => t !== null);
        setAllThemes(custom.length > 0 ? [...BUILT_IN_THEMES, ...custom] : BUILT_IN_THEMES);
      })
      .catch(() => {});
  }, []);

  const handleMissingThemeInstalled = useCallback((themeId: string) => {
    reloadCustomThemes();
    setActiveThemeId(themeId);
    setThemeOverrides({});
    setMissingThemeId(null);
  }, [reloadCustomThemes]);

  // Load custom themes from the platform config dir on startup
  useEffect(() => { reloadCustomThemes(); }, [reloadCustomThemes]);

  // Load keybindings from the platform config dir on startup
  useEffect(() => {
    loadKeybindings().then(setKeybindings).catch(() => {});
  }, []);

  // Startup update check (only when opt-in setting is enabled)
  useEffect(() => {
    if (!settings.checkForUpdates) return;
    fetchUpdate()
      .then((update) => { if (update) setAvailableUpdate(update.version); })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally runs once on mount

  // Window title
  useEffect(() => {
    const name = frontmatter.title ?? filePath?.split(/[\\/]/).pop() ?? 'Kova';
    getCurrentWindow().setTitle(isDirty ? `${name} • — Kova` : `${name} — Kova`).catch(() => {});
  }, [filePath, frontmatter.title, isDirty]);

  // File-changed event from Rust watcher → reload (if no unsaved edits)
  useEffect(() => {
    const unlisten = listen<void>('file-changed', async () => {
      const path = filePathRef.current;
      if (!path) return;
      // Guard: if the user has unsaved edits, don't silently overwrite them.
      // Kova's own saves set isDirty=false before the watcher event fires,
      // so this warning only appears for genuinely external modifications.
      if (isDirtyRef.current) {
        setWarnMessage('File changed externally. Save or discard your changes to reload.');
        if (warnTimerRef.current) clearTimeout(warnTimerRef.current);
        warnTimerRef.current = setTimeout(() => setWarnMessage(null), 6000);
        return;
      }
      try {
        const newContent: string = await invoke('read_file', { path });
        setContent(newContent);
        setIsDirty(false);
        // Clear any "file changed externally" warning — the reload (triggered by
        // the user saving, or by a clean external change) resolves the situation.
        setWarnMessage(null);
        if (warnTimerRef.current) { clearTimeout(warnTimerRef.current); warnTimerRef.current = null; }
      } catch (err) {
        console.error('Failed to reload file:', err);
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Clamp slide index
  useEffect(() => {
    if (slides.length > 0 && currentSlideIndex >= slides.length) {
      setCurrentSlideIndex(slides.length - 1);
    }
  }, [slides.length, currentSlideIndex]);

  // Focus Mode: collapse/expand side panels
  const toggleFocusMode = useCallback(() => {
    setFocusMode((prev) => {
      const next = !prev;
      if (next) {
        thumbPanelRef.current?.collapse();
        inspectorPanelRef.current?.collapse();
      } else {
        thumbPanelRef.current?.expand();
        if (showInspector) inspectorPanelRef.current?.expand();
      }
      return next;
    });
  }, [thumbPanelRef, inspectorPanelRef, showInspector]);

  const guardDirty = useCallback((action: () => void) => {
    if (isDirty && settings.confirmOnClose) {
      setConfirmCloseAction(() => action);
    } else {
      action();
    }
  }, [isDirty, settings.confirmOnClose]);

  const handleNewFile = useCallback(() => {
    guardDirty(async () => {
      await invoke('stop_watching').catch(() => {});
      setFilePath(null);
      setContent(makeStarter());
      setIsDirty(false);
      setCurrentSlideIndex(0);
      setActiveThemeId(settings.defaultThemeId);
      setThemeOverrides({});
      setMissingThemeId(null);
    });
  }, [guardDirty, settings.defaultThemeId]);

  // Prevents double-exit when the audience window is closed externally while
  // handlePresentExit is already in flight.
  const isExitingRef = useRef(false);
  // Incremented each time a presentation session starts so that a stale
  // tauri://destroyed handler from a previous session (e.g. close of a leftover
  // audience window) can detect it is out of date and skip its state reset.
  const presentSessionRef = useRef(0);

  const handlePresentExit = useCallback(async () => {
    if (isExitingRef.current) return;
    isExitingRef.current = true;
    await emit('present:exit', null).catch(() => {});
    setPresentMode(false);
    setPresenterMode(false);
    await getCurrentWindow().setFullscreen(false).catch(() => {});
    isExitingRef.current = false;
  }, []);

  const handlePresentEnter = useCallback(async (e?: React.MouseEvent) => {
    if (slides.length === 0) return;
    isExitingRef.current = false;
    const sessionId = ++presentSessionRef.current;
    const startIndex = e?.altKey ? safeSlideIndex : 0;
    if (!e?.altKey) setCurrentSlideIndex(0);

    // Resolve 'auto': detect monitors first, then pick mode.
    // Use currentMonitor() (not primaryMonitor()) to find the monitor Kova is
    // running on — on Wayland, primaryMonitor() returns null for both monitors
    // because "primary" is an X11 concept the compositor doesn't expose.
    let all: Awaited<ReturnType<typeof availableMonitors>> = [];
    let currentMon: Awaited<ReturnType<typeof currentMonitor>> = null;
    try {
      [all, currentMon] = await Promise.all([availableMonitors(), currentMonitor()]);
    } catch { /* ignore */ }
    const external = (() => {
      if (all.length <= 1) return null;
      if (currentMon) {
        // Name-based match works on macOS and Windows.
        return all.find((m) => m.name !== currentMon.name) ?? null;
      }
      // Wayland: currentMonitor() returns null because "primary" is an X11 concept.
      // Heuristic: the secondary monitor is typically to the right or below, so
      // pick the one whose origin is furthest from (0, 0).
      return all.reduce((best, m) =>
        (m.position.x + m.position.y) > (best.position.x + best.position.y) ? m : best
      );
    })();

    const rawMode = settings.presentationMode;
    const mode: Exclude<typeof rawMode, 'auto'> =
      rawMode === 'auto' ? (external ? 'dual' : 'single') : rawMode;

    if (mode === 'dual' || mode === 'mirror') {

      if (external) {
        const initPayload: PresentInitPayload = {
          slides,
          theme: activeTheme,
          index: startIndex,
          aspectRatio,
          docTitle: frontmatter.title,
        };

        // Close any stale audience window from a previous failed session to
        // prevent a name collision that would silence window creation errors.
        try {
          const stale = await WebviewWindow.getByLabel('audience');
          if (stale) await stale.close().catch(() => {});
        } catch { /* ignore */ }

        // Register ready listener BEFORE creating the window to avoid missing the event.
        // Use `let` so the timeout callback can also reach it.
        let unlistenReady: (() => void) | undefined;
        const readyTimeoutId = setTimeout(() => {
          // present:ready never fired — window creation silently failed.
          // Clean up the dangling listener so a future attempt starts fresh.
          unlistenReady?.();
        }, 10_000);

        unlistenReady = await listen('present:ready', async () => {
          clearTimeout(readyTimeoutId);
          unlistenReady?.();
          await emitTo('audience', 'present:init', initPayload);

          // Drive positioning + fullscreen via Rust.
          const logX = external.position.x / external.scaleFactor;
          const logY = external.position.y / external.scaleFactor;
          await invoke('setup_audience_window', {
            x: logX,
            y: logY,
            physicalX: external.position.x,
            physicalY: external.position.y,
          }).catch(() => {});
          // Reclaim focus on the presenter window — the audience window creation
          // may steal it even with focus:false, depending on the compositor.
          await getCurrentWindow().setFocus().catch(() => {});
        });

        const audienceWin = new WebviewWindow('audience', {
          url: '/#audience',
          x: external.position.x / external.scaleFactor,
          y: external.position.y / external.scaleFactor,
          width: external.size.width / external.scaleFactor,
          height: external.size.height / external.scaleFactor,
          // No fullscreen:true — on Linux that ignores x/y and captures the primary monitor.
          // Fullscreen is applied via setup_audience_window after present:ready fires.
          decorations: false,
          title: 'Kova — Presentation',
          resizable: false,
          focus: false,
        });

        // If window creation fails, clean up the ready listener and reset state.
        audienceWin.once('tauri://error', () => {
          clearTimeout(readyTimeoutId);
          unlistenReady?.();
          setPresentMode(false);
          setPresenterMode(false);
          getCurrentWindow().setFullscreen(false).catch(() => {});
        }).catch(() => {});

        // If the audience window is closed externally (compositor, Alt+F4, etc.),
        // exit presentation mode so the main window doesn't stay stuck fullscreened.
        // The sessionId guard ensures a stale handler from a previous session
        // (triggered by closing a leftover window at the start of a new session)
        // does not reset state that the new session just set.
        audienceWin.once('tauri://destroyed', () => {
          if (isExitingRef.current) return; // normal exit already in progress
          if (presentSessionRef.current !== sessionId) return; // stale session
          setPresentMode(false);
          setPresenterMode(false);
          getCurrentWindow().setFullscreen(false).catch(() => {});
        }).catch(() => {});

        if (mode === 'dual') {
          setPresenterMode(true);
          await getCurrentWindow().setFullscreen(true).catch(() => {});
          return;
        }
        // Mirror: audience window shows slide, main window also fullscreens with normal overlay
      }
      // Fall through to single if no external monitor
    }

    setPresentMode(true);
    await getCurrentWindow().setFullscreen(true).catch(() => {});
  }, [slides, safeSlideIndex, activeTheme, aspectRatio, frontmatter.title, settings.presentationMode]);

  // When the audience window has OS focus (common on Wayland where compositors
  // ignore focus:false), forward its keydown events so arrow-key navigation
  // works in the presenter without requiring a manual click.
  useEffect(() => {
    if (!presentMode && !presenterMode) return;
    const unlisten = listen<{ key: string }>('audience:key', (e) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: e.payload.key, bubbles: true, cancelable: true }));
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [presentMode, presenterMode]);

  // Mirror mode: keep the audience window in sync with the presenter's slide.
  // Dual mode sync is handled by PresenterOverlay; this covers mirror mode where
  // PresentationOverlay drives navigation but never emits present:navigate.
  useEffect(() => {
    if (!presentMode) return;
    emitTo('audience', 'present:navigate', { index: safeSlideIndex }).catch(() => {});
  }, [presentMode, safeSlideIndex]);

  const handleThemeSelect = useCallback((id: string) => {
    setActiveThemeId(id);
    setThemeOverrides({});
    setContent((prev) => {
      const patched = patchFrontmatter(prev, { theme: id, theme_overrides: null });
      if (patched !== prev) setIsDirty(true);
      return patched;
    });
  }, []);

  const handleThemeChange = useCallback((patch: Partial<Theme>) => {
    setThemeOverrides((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleMetaChange = useCallback((field: 'title' | 'author' | 'date', value: string) => {
    setContent((prev) => {
      const patched = patchFrontmatter(prev, { [field]: value.trim() || null });
      if (patched !== prev) setIsDirty(true);
      return patched;
    });
  }, []);

  const handleAspectRatioCycle = useCallback(() => {
    setContent((prev) => {
      const { frontmatter: fm } = extractFrontmatter(prev);
      const current = fm.aspect_ratio as string | undefined;
      const next = current === '4:3' ? '16:10' : current === '16:10' ? null : '4:3';
      const patched = patchFrontmatter(prev, { aspect_ratio: next });
      if (patched !== prev) setIsDirty(true);
      return patched;
    });
  }, []);

  const handleImportComplete = useCallback(async (markdown: string, savedPath: string) => {
    setShowImport(false);
    await invoke('stop_watching').catch(() => {});
    const { frontmatter: fm } = extractFrontmatter(markdown);
    if (typeof fm.theme === 'string') {
      const found = allThemes.find((t) => t.id === fm.theme);
      if (found) { setActiveThemeId(found.id); setMissingThemeId(null); setThemeOverrides(sanitiseThemeOverrides(fm.theme_overrides as Record<string, unknown> ?? {})); }
      else { setMissingThemeId(fm.theme); setThemeOverrides({}); }
    } else { setActiveThemeId(DEFAULT_THEME.id); setMissingThemeId(null); setThemeOverrides({}); }
    setFilePath(savedPath);
    setContent(markdown);
    setIsDirty(false);
    setCurrentSlideIndex(0);
    await invoke('start_watching', { path: savedPath }).catch(console.error);
  }, [allThemes]);

  const handleOpenFile = useCallback(() => {
    guardDirty(async () => { try {
      const selected = await open({
        filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
        multiple: false,
      });
      if (!selected || typeof selected !== 'string') return;
      const text: string = await invoke('read_file', { path: selected });
      const { frontmatter: fm } = extractFrontmatter(text);
      if (typeof fm.theme === 'string') {
        const found = allThemes.find((t) => t.id === fm.theme);
        if (found) {
          setActiveThemeId(found.id);
          setMissingThemeId(null);
          const overrides = fm.theme_overrides ?? {};
          // Sanitise overrides through the same CSS-injection checks applied to
          // installed theme YAML files, preventing crafted .md files from
          // injecting raw CSS property values into slide styles.
          setThemeOverrides(sanitiseThemeOverrides(overrides as Record<string, unknown>));
        } else {
          setMissingThemeId(fm.theme);
          setThemeOverrides({});
        }
      } else {
        setActiveThemeId(DEFAULT_THEME.id);
        setMissingThemeId(null);
        setThemeOverrides({});
      }
      setFilePath(selected);
      setContent(text);
      setIsDirty(false);
      setCurrentSlideIndex(0);
      await invoke('start_watching', { path: selected }).catch(console.error);
    } catch (err) { console.error('Open failed:', err); }});
  }, [guardDirty, allThemes]);

  const buildSaveContent = useCallback(() => {
    const overridePatch: Record<string, unknown> = {};
    if (themeOverrides.colors && Object.keys(themeOverrides.colors).length > 0)
      overridePatch.colors = themeOverrides.colors;
    if (themeOverrides.fonts && Object.keys(themeOverrides.fonts).length > 0)
      overridePatch.fonts = themeOverrides.fonts;
    if (themeOverrides.logo !== undefined)
      overridePatch.logo = themeOverrides.logo;
    if (themeOverrides.logo_position !== undefined)
      overridePatch.logo_position = themeOverrides.logo_position;
    if (themeOverrides.logo_opacity !== undefined)
      overridePatch.logo_opacity = themeOverrides.logo_opacity;
    if (themeOverrides.header !== undefined)
      overridePatch.header = themeOverrides.header;
    if (themeOverrides.footer !== undefined)
      overridePatch.footer = themeOverrides.footer;
    const hasOverrides = Object.keys(overridePatch).length > 0;
    return hasOverrides
      ? patchFrontmatter(content, { theme_overrides: overridePatch })
      : patchFrontmatter(content, { theme_overrides: null });
  }, [content, themeOverrides]);

  const handleRenameCommit = useCallback(async () => {
    setIsRenaming(false);
    if (!filePath) return;
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    const sep = filePath.includes('\\') ? '\\' : '/';
    const dir = filePath.substring(0, filePath.lastIndexOf(sep));
    const ext = filePath.match(/\.(md|markdown)$/i)?.[0] ?? '.md';
    const newPath = `${dir}${sep}${trimmed}${ext}`;
    if (newPath === filePath) return;
    try {
      await invoke('rename_file', { oldPath: filePath, newPath });
      setFilePath(newPath);
      await invoke('start_watching', { path: newPath }).catch(console.error);
    } catch (err) {
      console.error('Rename failed:', err);
      setWarnMessage(`Rename failed: ${err}`);
    }
  }, [filePath, renameValue]);

  const handleSave = useCallback(async () => {
    if (!filePath) return;
    try {
      const toWrite = buildSaveContent();
      await invoke('write_file', { path: filePath, content: toWrite });
      if (toWrite !== content) setContent(toWrite);
      setIsDirty(false);
    } catch (err) { console.error('Save failed:', err); }
  }, [filePath, content, buildSaveContent]);

  const handleSaveAs = useCallback(async (): Promise<string | null> => {
    try {
      const target = await save({
        filters: [{ name: 'Markdown', extensions: ['md'] }],
        defaultPath: filePath ?? undefined,
      });
      if (!target) return null;
      const toWrite = buildSaveContent();
      await invoke('write_file', { path: target, content: toWrite });
      if (toWrite !== content) setContent(toWrite);
      setFilePath(target);
      setIsDirty(false);
      await invoke('start_watching', { path: target }).catch(console.error);
      return target;
    } catch (err) { console.error('Save As failed:', err); return null; }
  }, [filePath, content, buildSaveContent]);

  const handleExport = useCallback(async () => {
    if (slides.length === 0) return;
    try {
      const { base64, warnings } = await exportToPptx(slides, frontmatter, activeTheme);
      const defaultPath = filePath
        ? filePath.replace(/\.(md|markdown)$/i, '.pptx')
        : 'presentation.pptx';
      const target = await save({
        filters: [{ name: 'PowerPoint', extensions: ['pptx'] }],
        defaultPath,
      });
      if (!target) return;
      const savePath = target.toLowerCase().endsWith('.pptx') ? target : `${target}.pptx`;
      await invoke('write_file_bytes', { path: savePath, data: base64 });
      if (warnings.length > 0) {
        window.alert(`Export complete with ${warnings.length} warning(s):\n\n${warnings.join('\n')}`);
      }
    } catch (err) { console.error('Export failed:', err); }
  }, [slides, frontmatter, activeTheme, filePath]);

  const handleExportPdf = useCallback(async () => {
    if (slides.length === 0) return;
    const defaultPath = filePath
      ? filePath.replace(/\.(md|markdown)$/i, '.pdf')
      : 'presentation.pdf';
    const target = await save({
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      defaultPath,
    });
    if (!target) return;
    const savePath = target.toLowerCase().endsWith('.pdf') ? target : `${target}.pdf`;
    pdfSlideRefs.current.clear();
    await new Promise<void>(resolve => {
      pdfExportResolveRef.current = resolve;
      setPdfExportContext({ slides: [...slides], savePath });
    });
  }, [slides, filePath]);

  const handleCopyWithAssets = useCallback(async () => {
    if (!filePath) return;
    const defaultPath = filePath.replace(/\.(md|markdown)$/i, '') + '-copy.md';
    const target = await save({
      filters: [{ name: 'Markdown', extensions: ['md'] }],
      defaultPath,
    });
    if (!target) return;
    const destPath = target.toLowerCase().endsWith('.md') ? target : `${target}.md`;
    const src = contentRef.current;
    const seen = new Set<string>();
    const WEB_URL = /^(https?|data|asset|tauri):\/\//i;
    for (const m of src.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
      const ref = decodeURIComponent(m[1]);
      if (!WEB_URL.test(ref)) seen.add(ref);
    }
    for (const m of src.matchAll(/<img[^>]+src=["']([^"']+)["']/g)) {
      const ref = decodeURIComponent(m[1]);
      if (!WEB_URL.test(ref)) seen.add(ref);
    }
    try {
      await invoke('copy_file_with_assets', {
        srcPath: filePath,
        content: src,
        destPath,
        assetRefs: Array.from(seen),
      });
    } catch (err) { console.error('Copy with assets failed:', err); }
  }, [filePath]);

  const handleContentChange = useCallback((newBody: string) => {
    if (showFrontmatterRef.current) {
      // Editor holds the full document — use it directly.
      setContent(newBody);
    } else {
      setContent((prev) => {
        const fm = prev.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
        return (fm ? fm[0] : '') + newBody;
      });
    }
    setIsDirty(true);
  }, []);

  const handleSlideReorder = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    setContent((prev) => {
      const fmMatch = prev.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
      const fmBlock = fmMatch ? fmMatch[0] : '';
      const body = prev.slice(fmBlock.length);
      const segments = body.split(/^---$/m);
      if (fromIndex < 0 || fromIndex >= segments.length || toIndex < 0 || toIndex >= segments.length) return prev;
      const reordered = [...segments];
      const [moved] = reordered.splice(fromIndex, 1);
      reordered.splice(toIndex, 0, moved);
      // Trim each segment and rejoin with normalized separators so the result
      // is always valid regardless of which segment ends up at which position.
      return fmBlock + reordered.map((s) => s.trim()).join('\n\n---\n\n') + '\n';
    });
    setIsDirty(true);
    setCurrentSlideIndex(toIndex);
    setTimeout(() => editorRef.current?.scrollToSlide(toIndex), 50);
  }, []);

  const handleWarn = useCallback((msg: string) => {
    setWarnMessage(msg);
    if (warnTimerRef.current) clearTimeout(warnTimerRef.current);
    warnTimerRef.current = setTimeout(() => setWarnMessage(null), 6000);
  }, []);

  const handleSettingsChange = useCallback((s: AppSettings) => {
    setSettings(s);
    saveSettings(s);
  }, []);

  // Apply UI theme class to root element; 'auto' follows the OS preference
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved: 'dark' | 'light' =
        settings.uiTheme === 'light' ? 'light' :
        settings.uiTheme === 'dark'  ? 'dark'  :
        mq.matches ? 'dark' : 'light';
      setResolvedUiTheme(resolved);
      document.documentElement.classList.toggle('theme-light', resolved === 'light');
    };
    apply();
    if (settings.uiTheme === 'auto') {
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
  }, [settings.uiTheme]);

  // Autosave — only when enabled, a file path exists, and there are unsaved changes
  useEffect(() => {
    if (!settings.autosave || !filePath || !isDirty) return;
    const id = setInterval(handleSave, settings.autosaveIntervalSeconds * 1000);
    return () => clearInterval(id);
  }, [settings.autosave, settings.autosaveIntervalSeconds, filePath, isDirty, handleSave]);

  useEffect(() => {
    const sc = (id: string) => getCombo(keybindings.combos, id);
    const handler = (e: KeyboardEvent) => {
      if (presentMode) return;
      if (matchShortcut(e, sc('newFile')))   { e.preventDefault(); handleNewFile(); }
      if (matchShortcut(e, sc('openFile')))  { e.preventDefault(); handleOpenFile(); }
      if (matchShortcut(e, sc('save')))      { e.preventDefault(); if (filePath) handleSave(); else handleSaveAs(); }
      if (matchShortcut(e, sc('saveAs')))    { e.preventDefault(); handleSaveAs(); }
      if (matchShortcut(e, sc('focusMode'))) { e.preventDefault(); toggleFocusMode(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [presentMode, keybindings.combos, filePath, handleNewFile, handleOpenFile, handleSave, handleSaveAs, toggleFocusMode]);

  // Close the export dropdown when the user clicks outside it.
  useEffect(() => {
    if (!exportMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [exportMenuOpen]);

  useEffect(() => {
    if (!saveAsMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (saveAsMenuRef.current && !saveAsMenuRef.current.contains(e.target as Node)) {
        setSaveAsMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [saveAsMenuOpen]);

  // After off-screen slides mount and Mermaid has had time to render, capture
  // them as PNGs and compile the PDF.
  useEffect(() => {
    if (!pdfExportContext) return;
    const { slides: exportSlides, savePath } = pdfExportContext;
    const tid = setTimeout(async () => {
      try {
        const elements = Array.from(
          { length: exportSlides.length },
          (_, i) => pdfSlideRefs.current.get(i),
        ).filter((el): el is HTMLElement => Boolean(el));
        const { base64, warnings } = await exportToPdf(elements, activeTheme, aspectRatio);
        await invoke('write_file_bytes', { path: savePath, data: base64 });
        if (warnings.length > 0) {
          window.alert(`PDF export complete with ${warnings.length} warning(s):\n\n${warnings.join('\n')}`);
        }
      } catch (err) {
        console.error('PDF export failed:', err);
      } finally {
        setPdfExportContext(null);
        pdfSlideRefs.current.clear();
        pdfExportResolveRef.current?.();
        pdfExportResolveRef.current = null;
      }
    }, 2000);
    return () => clearTimeout(tid);
  }, [pdfExportContext, aspectRatio]);

  return (
    <div className="app">
      {presentMode && (
        <PresentationOverlay
          slides={slides}
          currentIndex={safeSlideIndex}
          theme={activeTheme}
          docTitle={frontmatter.title}
          aspectRatio={aspectRatio}
          laserColor={settings.laserColor}
          onNavigate={setCurrentSlideIndex}
          onExit={handlePresentExit}
        />
      )}
      {presenterMode && (
        <PresenterOverlay
          slides={slides}
          currentIndex={safeSlideIndex}
          theme={activeTheme}
          docTitle={frontmatter.title}
          aspectRatio={aspectRatio}
          showNextSlide={settings.presenterShowNextSlide}
          showTimer={settings.presenterShowTimer}
          notesFontSize={settings.presenterNotesFontSize}
          laserColor={settings.laserColor}
          onNavigate={setCurrentSlideIndex}
          onExit={handlePresentExit}
        />
      )}
      <div className="app-toolbar">
        {isMac && (
          <div className="wm-controls wm-controls--mac">
            <button
              className="wm-btn wm-btn--close"
              onMouseDown={(e) => { e.preventDefault(); guardDirty(() => getCurrentWindow().close()); }}
              title="Close"
            >
              <svg width="11" height="11" viewBox="0 0 11 11">
                <line x1="1" y1="1" x2="10" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                <line x1="10" y1="1" x2="1" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
            <button
              className="wm-btn"
              onMouseDown={(e) => { e.preventDefault(); getCurrentWindow().minimize(); }}
              title="Minimise"
            >
              <svg width="12" height="2" viewBox="0 0 12 2"><rect width="12" height="2" rx="1" fill="currentColor"/></svg>
            </button>
            <button
              className="wm-btn"
              onMouseDown={(e) => { e.preventDefault(); getCurrentWindow().toggleMaximize(); }}
              title="Maximise / Restore"
            >
              <svg width="11" height="11" viewBox="0 0 11 11"><rect x="1" y="1" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5"/></svg>
            </button>
          </div>
        )}
        <button className="btn" onClick={handleNewFile} title={`New (${formatCombo(getCombo(keybindings.combos, 'newFile'))})`}>New</button>
        <button className="btn" onClick={handleOpenFile} title={`Open (${formatCombo(getCombo(keybindings.combos, 'openFile'))})`}>Open</button>
        <button className="btn" onClick={() => guardDirty(() => setShowImport(true))} title="Import from PowerPoint (.pptx)">Import</button>
        <button className="btn" onClick={handleSave} disabled={!filePath || !isDirty} title={`Save (${formatCombo(getCombo(keybindings.combos, 'save'))})`}>Save</button>
        <div className="btn-group" ref={saveAsMenuRef}>
          <button className="btn" disabled={!content} onClick={() => setSaveAsMenuOpen((o) => !o)}>
            Save As ▾
          </button>
          {saveAsMenuOpen && (
            <div className="btn-group-menu">
              <button className="btn-group-menu-item" onClick={() => { setSaveAsMenuOpen(false); handleSaveAs(); }}>
                Save As…
              </button>
              <button className="btn-group-menu-item" disabled={!filePath} onClick={() => { setSaveAsMenuOpen(false); handleCopyWithAssets(); }}>
                Copy with Assets…
              </button>
            </div>
          )}
        </div>
        <div className="btn-group" ref={exportMenuRef}>
          <button
            className="btn"
            disabled={slides.length === 0 || pdfExportContext !== null}
            title="Export presentation"
            onClick={() => setExportMenuOpen((o) => !o)}
          >
            {pdfExportContext ? 'Exporting PDF…' : 'Export ▾'}
          </button>
          {exportMenuOpen && (
            <div className="btn-group-menu">
              <button className="btn-group-menu-item" onClick={() => { setExportMenuOpen(false); handleExport(); }}>
                PowerPoint (.pptx)
              </button>
              <button className="btn-group-menu-item" onClick={() => { setExportMenuOpen(false); handleExportPdf(); }}>
                PDF (.pdf)
              </button>
            </div>
          )}
        </div>
        <div className="toolbar-spacer" data-tauri-drag-region />
        {isRenaming ? (
          <input
            className="toolbar-doctitle toolbar-doctitle--editing"
            value={renameValue}
            autoFocus
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleRenameCommit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); handleRenameCommit(); }
              if (e.key === 'Escape') { e.preventDefault(); setIsRenaming(false); }
            }}
          />
        ) : (
          <div
            className="toolbar-doctitle"
            onDoubleClick={() => {
              if (!filePath) return;
              const base = filePath.split(/[/\\]/).pop() ?? '';
              setRenameValue(base.replace(/\.(md|markdown)$/i, ''));
              setIsRenaming(true);
            }}
          >
            {filePath ? filePath.split(/[\\/]/).pop() : 'Untitled.md'}{isDirty ? ' *' : ''}
          </div>
        )}
        <button
          className="btn btn-primary"
          onClick={handlePresentEnter}
          disabled={slides.length === 0}
          title="Present from slide 1 (Alt+click to start from current slide)"
        >▶ Present</button>
        <button
          className={`wm-btn${showInspector ? ' wm-btn--active' : ''}`}
          onClick={() => setShowInspector((v) => !v)}
          title="Toggle inspector"
          style={{ marginLeft: 4 }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="8" strokeWidth="2"/>
            <line x1="12" y1="12" x2="12" y2="16"/>
          </svg>
        </button>
        <button
          className="wm-btn"
          onClick={() => setShowSettings(true)}
          title={availableUpdate ? `Settings (update ${availableUpdate} available)` : 'Settings'}
          style={{ position: 'relative' }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
          {availableUpdate && (
            <span style={{
              position: 'absolute', top: 3, right: 3,
              width: 6, height: 6, borderRadius: '50%',
              background: '#D94F00', pointerEvents: 'none',
            }} />
          )}
        </button>
        {!isMac && (
          <div className="wm-controls">
            <button
              className="wm-btn"
              onMouseDown={(e) => { e.preventDefault(); getCurrentWindow().minimize(); }}
              title="Minimise"
            >
              <svg width="12" height="2" viewBox="0 0 12 2"><rect width="12" height="2" rx="1" fill="currentColor"/></svg>
            </button>
            <button
              className="wm-btn"
              onMouseDown={(e) => { e.preventDefault(); getCurrentWindow().toggleMaximize(); }}
              title="Maximise / Restore"
            >
              <svg width="11" height="11" viewBox="0 0 11 11"><rect x="1" y="1" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5"/></svg>
            </button>
            <button
              className="wm-btn wm-btn--close"
              onMouseDown={(e) => {
                e.preventDefault();
                guardDirty(() => getCurrentWindow().close());
              }}
              title="Close"
            >
              <svg width="11" height="11" viewBox="0 0 11 11">
                <line x1="1" y1="1" x2="10" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                <line x1="10" y1="1" x2="1" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        )}
      </div>

      <div className="app-panels">
        <PanelGroup
          orientation="horizontal"
          style={{ height: '100%' }}
          id="kova-main"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
        >
          <Panel id="thumb" panelRef={thumbPanelRef} defaultSize={14} minSize={8} collapsible>
            <ThumbnailPanel
              slides={slides}
              currentIndex={safeSlideIndex}
              onSelect={handleThumbnailSelect}
              onReorder={handleSlideReorder}
              theme={activeTheme}
              docTitle={frontmatter.title}
              aspectRatio={aspectRatio}
            />
          </Panel>

          <PanelResizeHandle />

          <Panel id="editor" defaultSize={72} minSize={20}>
            <EditorPanel
              ref={editorRef}
              content={editorContent}
              onChange={handleContentChange}
              onCursorSlide={setCurrentSlideIndex}
              onWarn={handleWarn}
              onSaveAs={handleSaveAs}
              focusMode={focusMode}
              filePath={filePath}
              uiTheme={resolvedUiTheme}
              editorFontFamily={EDITOR_FONT_OPTIONS.find(o => o.value === settings.editorFont)?.family}
              spellCheckEnabled={settings.spellCheckEnabled}
              spellCheckLanguage={settings.spellCheckLanguage}
            />
          </Panel>

          {showInspector && <PanelResizeHandle />}

          {showInspector && (
            <Panel id="inspector" panelRef={inspectorPanelRef} defaultSize={14} minSize={8} collapsible>
              <InspectorPanel
                filePath={filePath}
                slideCount={slides.length}
                frontmatter={frontmatter}
                theme={activeTheme}
                allThemes={allThemes}
                onThemeSelect={handleThemeSelect}
                onThemeChange={handleThemeChange}
                onMetaChange={handleMetaChange}
                onFormat={handleFormat}
                onOpenLibrary={() => setShowThemeMarketplace(true)}
              />
            </Panel>
          )}
        </PanelGroup>
      </div>

      <StatusBar
        currentSlide={safeSlideIndex + 1}
        totalSlides={slides.length}
        wordCount={wordCount}
        isDirty={isDirty}
        filePath={filePath}
        externalImageCount={externalImageCount}
        aspectRatioLabel={`${aspectRatio.w}:${aspectRatio.h}`}
        onAspectRatioCycle={handleAspectRatioCycle}
      />

      {showSettings && (
        <SettingsModal
          settings={settings}
          availableUpdate={availableUpdate}
          allThemes={allThemes}
          onChange={handleSettingsChange}
          onUpdateChecked={setAvailableUpdate}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showThemeLibrary && (
        <ThemeLibraryModal
          installedIds={installedRemoteIds}
          onThemesChanged={reloadCustomThemes}
          onClose={() => setShowThemeMarketplace(false)}
        />
      )}

      {showImport && (
        <ImportPptxModal
          onImported={handleImportComplete}
          onClose={() => setShowImport(false)}
        />
      )}

      {missingThemeId && (
        <MissingThemeBanner
          themeId={missingThemeId}
          onInstalled={handleMissingThemeInstalled}
          onDismiss={() => setMissingThemeId(null)}
        />
      )}


      {warnMessage && (
        <div style={{
          position: 'fixed', bottom: 36, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--bg-elevated)', border: '1px solid var(--dirty-color)',
          borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.4)', zIndex: 3000,
          padding: '10px 16px', fontSize: 12, color: 'var(--dirty-color)',
          maxWidth: 480, textAlign: 'center', pointerEvents: 'none',
        }}>
          {warnMessage}
        </div>
      )}

      {confirmCloseAction && (
        <>
          <div
            onClick={() => setConfirmCloseAction(null)}
            style={{ position: 'fixed', inset: 0, background: 'var(--backdrop)', zIndex: 2000 }}
          />
          <div style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
            background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8,
            boxShadow: '0 16px 48px rgba(0,0,0,0.6)', zIndex: 2001,
            padding: '24px 28px', width: 320, maxWidth: '90vw',
          }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
              Unsaved changes
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20, lineHeight: 1.5 }}>
              You have unsaved changes. Close anyway?
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn" onClick={() => setConfirmCloseAction(null)}>Cancel</button>
              <button
                className="btn"
                style={{ background: '#c0392b', borderColor: '#c0392b', color: '#fff' }}
                onClick={() => { const a = confirmCloseAction; setConfirmCloseAction(null); a(); }}
              >Close anyway</button>
            </div>
          </div>
        </>
      )}

      {/* Off-screen slide rendering for PDF export */}
      {pdfExportContext && (() => {
        const SLIDE_W = 960;
        const slideH = Math.round(SLIDE_W * aspectRatio.h / aspectRatio.w);
        return (
          <div
            aria-hidden="true"
            style={{
              position: 'fixed',
              top: -99999,
              left: -99999,
              width: SLIDE_W,
              display: 'flex',
              flexDirection: 'column',
              pointerEvents: 'none',
            }}
          >
            {pdfExportContext.slides.map((slide, i) => (
              <div
                key={i}
                ref={(el) => {
                  if (el) pdfSlideRefs.current.set(i, el);
                  else pdfSlideRefs.current.delete(i);
                }}
                style={{ width: SLIDE_W, height: slideH, flexShrink: 0, overflow: 'hidden' }}
              >
                <SlideRenderer
                  slide={slide}
                  theme={activeTheme}
                  slideNumber={i + 1}
                  totalSlides={pdfExportContext.slides.length}
                  docTitle={frontmatter.title ?? ''}
                />
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}
