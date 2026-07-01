import { invoke } from '@tauri-apps/api/core';
import type { AspectRatio } from '../types';
import { mermaidSvgCache } from './mermaidSvgCache';
import { imageMime } from './imageMime';
import { type PdfExportOpts, planPage, SLIDE_PX_W } from './pdfLayout';

export type { PdfExportOpts };

// ── Public entry point ───────────────────────────────────────────────────────

export async function exportPdfNative(
  slideElements: HTMLElement[],
  aspectRatio: AspectRatio,
  savePath: string,
  opts: PdfExportOpts = {},
): Promise<void> {
  const html = await buildPrintDocument(slideElements, aspectRatio, opts);
  const plan = planPage(aspectRatio, opts);
  const perPage = opts.perPage ?? 1;
  const pageCount = perPage > 1 ? Math.ceil(slideElements.length / perPage) : slideElements.length;
  await invoke('export_pdf_native', {
    htmlContent: html,
    outputPath: savePath,
    widthMm: plan.pageWmm,
    heightMm: plan.pageHmm,
    // Per-page capture rects for the macOS path (one createPDF per page, then merge).
    pageCount,
    pageWidthPx: plan.pageWpx,
    pageHeightPx: plan.pageHpx,
  });
}

// ── HTML serialiser ──────────────────────────────────────────────────────────

export async function buildPrintDocument(
  slideElements: HTMLElement[],
  aspectRatio: AspectRatio,
  opts: PdfExportOpts = {},
): Promise<string> {
  const plan = planPage(aspectRatio, opts);
  const perPage = opts.perPage ?? 1;

  // Read slide background color from the live DOM before cloning.
  const slideFrame = slideElements[0]?.querySelector('.slide-frame');
  const slideBg = slideFrame
    ? getComputedStyle(slideFrame).getPropertyValue('--sl-bg').trim()
    : '';

  // 1. Clone elements and resolve all image URLs to data URIs in place.
  const clones = slideElements.map((el) => el.cloneNode(true) as HTMLElement);
  await Promise.all(clones.map(resolveImages));
  // Belt-and-suspenders: if a Mermaid container is still a placeholder (SVG
  // not yet committed to the DOM when we cloned), inject from the render cache.
  clones.forEach(injectMermaidFallbacks);
  clones.forEach(inlinePrintColorAdjust);

  // 2. Extract all document CSS with font URLs resolved to data URIs.
  const css = await extractAllCss();

  // Each slide is a 960×native box scaled into a frame sized to the slide's own
  // proportions (so the N-up border hugs the slide), centred in its slot.
  const slot = (el: HTMLElement) =>
    `<div class="kova-slot"><div class="kova-frame"><div class="kova-scale">${el.outerHTML}</div></div></div>`;

  // 3. Assemble pages — slides scaled/centred onto a standard paper page.
  let pages: string;
  if (plan.mode === 'nup') {
    const sheets: HTMLElement[][] = [];
    for (let i = 0; i < clones.length; i += perPage) sheets.push(clones.slice(i, i + perPage));
    pages = sheets.map((sheet) =>
      `<div class="kova-page"><div class="kova-content kova-grid">${sheet.map(slot).join('')}</div></div>`,
    ).join('\n');
  } else if (plan.mode === 'notes') {
    pages = clones.map((el, i) => {
      const note = escapeHtml((opts.notes?.[i] ?? '').trim());
      return `<div class="kova-page"><div class="kova-content kova-col">${slot(el)}<div class="kova-notes">${note}</div></div></div>`;
    }).join('\n');
  } else {
    pages = clones.map((el) =>
      `<div class="kova-page"><div class="kova-content kova-center">${slot(el)}</div></div>`,
    ).join('\n');
  }

  const bgCss = slideBg ? `background: ${slideBg} !important;` : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
${css}
@page {
  size: ${plan.pageWmm}mm ${plan.pageHmm}mm;
  margin: 0;
}
*, *::before, *::after {
  -webkit-print-color-adjust: exact !important;
  print-color-adjust: exact !important;
  color-adjust: exact !important;
}
@media print {
  *, *::before, *::after {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    color-adjust: exact !important;
  }
}
/* Override app-level constraints (e.g. html/body { height:100%; overflow:hidden })
   that would collapse the print document to a single page. These must come after
   the extracted CSS and use !important to win specificity. */
html, body {
  margin: 0 !important;
  padding: 0 !important;
  width: auto !important;
  height: auto !important;
  min-height: 0 !important;
  max-height: none !important;
  overflow: visible !important;
  zoom: 1 !important;
}
.kova-page {
  display: block !important;
  width: ${plan.pageWpx}px !important;
  height: ${plan.pageHpx}px !important;
  overflow: hidden !important;
  break-after: page;
  page-break-after: always;
  position: relative !important;
  margin: 0 !important;
  background: ${slideBg || '#fff'} !important;
}
.kova-page:last-child {
  break-after: avoid;
  page-break-after: avoid;
}
.kova-content {
  position: absolute !important;
  inset: ${plan.marginPx}px !important;
  box-sizing: border-box !important;
}
.kova-center { display: flex !important; align-items: center !important; justify-content: center !important; }
.kova-col    { display: flex !important; flex-direction: column !important; }
.kova-grid {
  display: grid !important;
  grid-template-columns: repeat(${plan.cols}, ${plan.cellWpx}px) !important;
  grid-auto-rows: ${plan.cellHpx}px !important;
  gap: ${plan.gapPx}px !important;
  align-content: center !important;
  justify-content: center !important;
}
.kova-slot {
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  overflow: hidden !important;
}
.kova-grid .kova-slot { width: ${plan.cellWpx}px !important; height: ${plan.cellHpx}px !important; }
.kova-col  .kova-slot { width: 100% !important; height: ${plan.cellHpx}px !important; flex: 0 0 auto !important; }
.kova-center .kova-slot { width: 100% !important; height: 100% !important; }
.kova-frame {
  position: relative !important;
  box-sizing: border-box !important;
  width: ${SLIDE_PX_W * plan.slideScale}px !important;
  height: ${plan.slideNativeHpx * plan.slideScale}px !important;
  overflow: hidden !important;
  flex: 0 0 auto !important;
  ${bgCss}
}
.kova-grid .kova-frame { border: 1px solid #c8c8c8 !important; }
.kova-scale {
  width: ${SLIDE_PX_W}px !important;
  height: ${plan.slideNativeHpx}px !important;
  transform: scale(${plan.slideScale}) !important;
  transform-origin: top left !important;
}
.kova-notes {
  flex: 1 1 auto !important;
  box-sizing: border-box !important;
  margin-top: ${plan.gapPx}px !important;
  padding: 20px 24px !important;
  font: 18px/1.55 -apple-system, system-ui, sans-serif !important;
  color: #111 !important;
  background: #fff !important;
  white-space: pre-wrap !important;
  overflow: hidden !important;
  border-top: 2px solid #999 !important;
}
</style>
</head>
<body>
${pages}
</body>
</html>`;
}

// ── Mermaid cache fallback ───────────────────────────────────────────────────

// If a Mermaid container was cloned before React committed the SVG to the DOM
// (race between setSvg() and signalReady()), the clone will be a placeholder
// div with no SVG child. Inject the cached SVG string so the diagram appears.
function injectMermaidFallbacks(root: HTMLElement): void {
  const containers = Array.from(root.querySelectorAll<HTMLElement>('[data-mermaid-src]'));
  for (const container of containers) {
    if (container.querySelector('svg')) continue;
    const src = container.getAttribute('data-mermaid-src') ?? '';
    const cached = mermaidSvgCache.get(src);
    if (!cached) continue;
    const scaled = cached.replace(/<svg\b([^>]*)>/i, (_m, attrs: string) => {
      let a = attrs
        .replace(/\bwidth="[^"]*"/, 'width="100%"')
        .replace(/\bheight="[^"]*"/, 'height="100%"')
        .replace(/\bstyle="[^"]*max-width[^"]*"/, '');
      if (!/preserveAspectRatio/.test(a)) a += ' preserveAspectRatio="xMidYMid meet"';
      return `<svg${a}>`;
    });
    container.innerHTML = scaled;
    container.className = 'sl-mermaid';
  }
}

// ── Print-color-adjust inlining ──────────────────────────────────────────────

// Walk every element in the clone and set print-color-adjust:exact as an
// inline style.  This is more reliable than a CSS rule because headless
// Chromium has been observed to ignore the stylesheet-level declaration.
function inlinePrintColorAdjust(root: HTMLElement): void {
  const walk = (el: HTMLElement) => {
    el.style.setProperty('-webkit-print-color-adjust', 'exact', 'important');
    el.style.setProperty('print-color-adjust', 'exact', 'important');
    for (const child of Array.from(el.children)) {
      if (child instanceof HTMLElement) walk(child);
    }
  };
  walk(root);
}

// ── Image resolution ─────────────────────────────────────────────────────────

async function resolveImages(el: HTMLElement): Promise<void> {
  const imgs = Array.from(el.querySelectorAll<HTMLImageElement>('img'));
  await Promise.all(imgs.map(async (img) => {
    const src = img.getAttribute('src') ?? '';
    let dataUrl: string | null = null;
    try {
      if (src.startsWith('asset://')) {
        const path = decodeURIComponent(src.replace(/^asset:\/\/[^/]*/, ''));
        const b64  = await invoke<string>('read_file_b64', { path });
        dataUrl = `data:${imageMime(path)};base64,${b64}`;
      } else if (src.startsWith('https://') || src.startsWith('http://')) {
        const [b64, mime] = await invoke<[string, string]>('fetch_url_b64', { url: src });
        dataUrl = `data:${mime};base64,${b64}`;
      } else if (src.startsWith('tauri://') || src.startsWith('/')) {
        const fetchUrl = src.startsWith('/') ? `tauri://localhost${src}` : src;
        const res = await fetch(fetchUrl);
        if (res.ok) dataUrl = await blobToDataUrl(await res.blob());
      }
    } catch { /* leave original src */ }
    if (dataUrl) img.src = dataUrl;
  }));
}

// ── CSS extraction ───────────────────────────────────────────────────────────

async function extractAllCss(): Promise<string> {
  const parts: string[] = [];

  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const rules = Array.from(sheet.cssRules ?? []);
      parts.push(rules.map((r) => r.cssText).join('\n'));
    } catch {
      // Cross-origin sheet — fetch and inline as text.
      if (sheet.href) {
        try {
          const res = await fetch(sheet.href);
          if (res.ok) parts.push(await res.text());
        } catch { /* skip */ }
      }
    }
  }

  return resolveFontUrls(parts.join('\n'));
}

// ── Font URL resolution ──────────────────────────────────────────────────────

// Browsers resolve relative CSS URLs against the document origin when returning
// cssText, so /fonts/... becomes tauri://localhost/fonts/... in rule text.
// We fetch those via the browser (no IPC) and embed them as data: URIs so the
// self-contained HTML works when loaded from a temp file:// path.
async function resolveFontUrls(css: string): Promise<string> {
  const FONT_URL_RE = /url\((['"]?)([^'")\s]+\.(?:woff2?|ttf|otf|eot))\1\)/gi;

  // Collect unique font URLs first.
  const urls = new Set<string>();
  for (const m of css.matchAll(FONT_URL_RE)) urls.add(m[2]);

  // Resolve each to a data URI.
  const resolved = new Map<string, string>();
  await Promise.all(Array.from(urls).map(async (url) => {
    try {
      let dataUrl: string;
      if (url.startsWith('asset://')) {
        const path = decodeURIComponent(url.replace(/^asset:\/\/[^/]*/, ''));
        const b64  = await invoke<string>('read_file_b64', { path });
        dataUrl = `data:${extToFontMime(path)};base64,${b64}`;
      } else if (url.startsWith('tauri://') || url.startsWith('/')) {
        const fetchUrl = url.startsWith('/') ? `tauri://localhost${url}` : url;
        const res = await fetch(fetchUrl);
        if (!res.ok) return;
        dataUrl = await blobToDataUrl(await res.blob());
      } else {
        return; // leave http/https font URLs as-is
      }
      resolved.set(url, dataUrl);
    } catch { /* leave URL as-is */ }
  }));

  // Replace all matched URLs in the CSS.
  return css.replace(FONT_URL_RE, (match, q, url) => {
    const r = resolved.get(url);
    return r ? `url(${q}${r}${q})` : match;
  });
}

// ── Utilities ────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function extToFontMime(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'woff2') return 'font/woff2';
  if (ext === 'woff')  return 'font/woff';
  if (ext === 'ttf')   return 'font/ttf';
  if (ext === 'otf')   return 'font/otf';
  return 'font/woff2';
}
