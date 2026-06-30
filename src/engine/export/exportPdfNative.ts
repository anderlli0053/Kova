import { invoke } from '@tauri-apps/api/core';
import type { AspectRatio } from '../types';
import { mermaidSvgCache } from './mermaidSvgCache';
import { imageMime } from './imageMime';

// At 96 CSS DPI: 254mm = 960px exactly. Slides are rendered off-screen at 960px
// wide, so this page size maps one-to-one with no scaling required.
const PDF_W_MM  = 254;
const SLIDE_PX_W = 960;

// ── Public entry point ───────────────────────────────────────────────────────

export async function exportPdfNative(
  slideElements: HTMLElement[],
  aspectRatio: AspectRatio,
  savePath: string,
): Promise<void> {
  const html = await buildPrintDocument(slideElements, aspectRatio);
  await invoke('export_pdf_native', {
    htmlContent: html,
    outputPath: savePath,
    widthMm: PDF_W_MM,
    heightMm: pageMm(aspectRatio),
  });
}

// ── HTML serialiser ──────────────────────────────────────────────────────────

export async function buildPrintDocument(
  slideElements: HTMLElement[],
  aspectRatio: AspectRatio,
): Promise<string> {
  const slideH = Math.round(SLIDE_PX_W * aspectRatio.h / aspectRatio.w);
  const H_MM   = pageMm(aspectRatio);

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

  // 3. Assemble the final HTML document.
  const pages = clones
    .map((el) => `<div class="kova-page">${el.outerHTML}</div>`)
    .join('\n');

  const bgCss = slideBg ? `background: ${slideBg} !important;` : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
${css}
@page {
  size: ${PDF_W_MM}mm ${H_MM}mm;
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
  ${bgCss}
}
.kova-page {
  display: block !important;
  width: ${SLIDE_PX_W}px !important;
  height: ${slideH}px !important;
  overflow: hidden !important;
  break-after: page;
  page-break-after: always;
  position: relative !important;
  margin: 0 !important;
}
.kova-page:last-child {
  break-after: avoid;
  page-break-after: avoid;
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

function pageMm(ar: AspectRatio): number {
  return Math.round((PDF_W_MM * ar.h / ar.w) * 100) / 100;
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
