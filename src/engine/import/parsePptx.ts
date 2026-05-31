import JSZip from 'jszip';
import { invoke } from '@tauri-apps/api/core';

// ── OOXML namespace URIs ──────────────────────────────────────────────────────

const A   = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P   = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const R   = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// Placeholder types we care about
type PhType = 'ctrTitle' | 'title' | 'subTitle' | 'body' | 'obj' | 'other';

export interface PptxBlock {
  kind: 'ctrTitle' | 'title' | 'body' | 'image' | 'table';
  // text blocks
  text?: string;
  isMultiPara?: boolean;
  // image blocks
  assetFilename?: string;  // saved filename relative to destDir, e.g. "assets/slide1_img1.png"
  // table blocks
  headers?: string[];
  rows?: string[][];
  // position (0–1 normalised to slide dimensions, used for layout hints)
  normX: number;
  normY: number;
  normW: number;
  normH: number;
}

export interface PptxParsedSlide {
  blocks: PptxBlock[];
  speakerNotes: string;
}

export interface PptxParseResult {
  slides: PptxParsedSlide[];
  presentationTitle: string;
  warnings: string[];
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function qAll(node: Element | Document, ns: string, local: string): Element[] {
  return Array.from(node.getElementsByTagNameNS(ns, local));
}

function q(node: Element | Document, ns: string, local: string): Element | null {
  return node.getElementsByTagNameNS(ns, local)[0] ?? null;
}

function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, 'application/xml');
}

// ── Base64 helpers ────────────────────────────────────────────────────────────

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── Text extraction from txBody ───────────────────────────────────────────────

function extractTextBody(txBody: Element): { text: string; isMultiPara: boolean } {
  const paragraphs = qAll(txBody, A, 'p');
  const lines: string[] = [];
  for (const para of paragraphs) {
    // Collect text by walking child nodes in order (preserves run sequence)
    let lineText = '';
    for (const child of Array.from(para.childNodes)) {
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as Element;
      if (el.localName === 'r') {
        const t = el.getElementsByTagNameNS(A, 't')[0];
        if (t?.textContent) lineText += t.textContent;
      } else if (el.localName === 'br') {
        lineText += '\n';
      }
    }

    const trimmed = lineText.trim();
    if (!trimmed) continue;

    // Detect explicit bullet on this paragraph
    const pPr = para.getElementsByTagNameNS(A, 'pPr')[0] ?? null;
    const buChar = pPr?.getElementsByTagNameNS(A, 'buChar')[0];
    const buAutoNum = pPr?.getElementsByTagNameNS(A, 'buAutoNum')[0];
    const buNone = pPr?.getElementsByTagNameNS(A, 'buNone')[0];
    const lvl = pPr ? (parseInt(pPr.getAttribute('lvl') ?? '0') || 0) : 0;
    const isBullet = (buChar != null || buAutoNum != null) && buNone == null;

    if (isBullet) {
      lines.push('  '.repeat(lvl) + '- ' + trimmed);
    } else {
      lines.push(trimmed);
    }
  }

  return { text: lines.join('\n'), isMultiPara: lines.length > 1 };
}

// ── Relationship file parser ──────────────────────────────────────────────────

function parseRels(relsXml: Document): Map<string, string> {
  const map = new Map<string, string>();
  for (const rel of Array.from(relsXml.getElementsByTagName('Relationship'))) {
    const id     = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (id && target) map.set(id, target);
  }
  return map;
}

// ── Slide shape offset / extent (in EMUs) ────────────────────────────────────

interface ShapeGeom { x: number; y: number; cx: number; cy: number }

function getShapeGeom(shape: Element): ShapeGeom {
  const xfrm = shape.getElementsByTagNameNS(A, 'xfrm')[0] ?? null;
  if (!xfrm) return { x: 0, y: 0, cx: 1, cy: 1 };
  const off = xfrm.getElementsByTagNameNS(A, 'off')[0];
  const ext = xfrm.getElementsByTagNameNS(A, 'ext')[0];
  return {
    x:  parseInt(off?.getAttribute('x')  ?? '0') || 0,
    y:  parseInt(off?.getAttribute('y')  ?? '0') || 0,
    cx: parseInt(ext?.getAttribute('cx') ?? '1') || 1,
    cy: parseInt(ext?.getAttribute('cy') ?? '1') || 1,
  };
}

function normalise(geom: ShapeGeom, slideW: number, slideH: number) {
  return {
    normX: geom.x / slideW,
    normY: geom.y / slideH,
    normW: geom.cx / slideW,
    normH: geom.cy / slideH,
  };
}

// ── Placeholder type ──────────────────────────────────────────────────────────

function getPhType(sp: Element): PhType | null {
  const ph = sp.getElementsByTagNameNS(P, 'ph')[0]
          ?? sp.getElementsByTagNameNS(A, 'ph')[0]
          ?? null;
  if (!ph) {
    // Check via nvSpPr → nvPr → ph  (standard location)
    const nvPr = sp.getElementsByTagNameNS(P, 'nvPr')[0] ?? null;
    const ph2  = nvPr?.getElementsByTagNameNS(P, 'ph')[0] ?? null;
    if (!ph2) return null;
    const t = ph2.getAttribute('type') ?? 'body';
    return mapPhType(t);
  }
  return mapPhType(ph.getAttribute('type') ?? 'body');
}

function mapPhType(t: string): PhType {
  if (t === 'ctrTitle') return 'ctrTitle';
  if (t === 'title')    return 'title';
  if (t === 'subTitle') return 'subTitle';
  if (t === 'body')     return 'body';
  if (t === 'obj')      return 'obj';
  return 'other';
}

// ── Table extraction ──────────────────────────────────────────────────────────

function extractTable(tbl: Element): { headers: string[]; rows: string[][] } | null {
  const allRows = qAll(tbl, A, 'tr');
  if (allRows.length === 0) return null;

  function rowText(tr: Element): string[] {
    return qAll(tr, A, 'tc').map((tc) => {
      const txBody = tc.getElementsByTagNameNS(A, 'txBody')[0];
      if (!txBody) return '';
      const { text } = extractTextBody(txBody);
      return text.replace(/\n/g, ' ').trim();
    });
  }

  const headers = rowText(allRows[0]);
  const rows = allRows.slice(1).map(rowText);
  return { headers, rows };
}

// ── Speaker notes extraction ──────────────────────────────────────────────────

const NOTES_SLIDE_TYPE = 'notesSlide';

async function extractSpeakerNotes(
  slideRels: Map<string, string>,
  slidePath: string,
  zip: JSZip,
): Promise<string> {
  // Find the notesSlide relationship (if any)
  let notesTarget: string | undefined;
  for (const [, target] of slideRels) {
    if (target.includes(NOTES_SLIDE_TYPE)) { notesTarget = target; break; }
  }
  if (!notesTarget) return '';

  const notesZipPath = resolveRelTarget(slidePath.replace(/[^/]+$/, ''), notesTarget);
  const notesXmlText = await zip.file(notesZipPath)?.async('string');
  if (!notesXmlText) return '';

  const notesDoc = parseXml(notesXmlText);
  const spTree = q(notesDoc, P, 'spTree') ?? q(notesDoc, A, 'spTree');
  if (!spTree) return '';

  const lines: string[] = [];
  for (const sp of qAll(spTree, P, 'sp')) {
    // Skip the slide-image placeholder — it has no text
    const phType = getPhType(sp);
    if (phType === 'other' && sp.getElementsByTagNameNS(P, 'ph')[0]?.getAttribute('type') === 'sldImg') continue;
    // Also skip if explicitly typed as sldImg
    const nvPr = sp.getElementsByTagNameNS(P, 'nvPr')[0];
    const ph = nvPr?.getElementsByTagNameNS(P, 'ph')[0];
    if (ph?.getAttribute('type') === 'sldImg') continue;

    const txBody = sp.getElementsByTagNameNS(P, 'txBody')[0]
                ?? sp.getElementsByTagNameNS(A, 'txBody')[0]
                ?? null;
    if (!txBody) continue;

    const { text } = extractTextBody(txBody);
    const trimmed = text.trim();
    if (trimmed) lines.push(trimmed);
  }

  return lines.join('\n\n');
}

// ── Per-slide block extraction ────────────────────────────────────────────────

async function extractSlideBlocks(
  slideDoc: Document,
  rels: Map<string, string>,
  zip: JSZip,
  slideW: number,
  slideH: number,
  slideIndex: number,
  destDir: string,
  warnings: string[],
): Promise<PptxBlock[]> {
  const blocks: PptxBlock[] = [];
  const spTree = q(slideDoc, P, 'spTree') ?? q(slideDoc, A, 'spTree');
  if (!spTree) return blocks;

  let imgCounter = 0;

  // ── Text shapes (p:sp) ────────────────────────────────────────────────────
  for (const sp of qAll(spTree, P, 'sp')) {
    const txBody = sp.getElementsByTagNameNS(P, 'txBody')[0]
                ?? sp.getElementsByTagNameNS(A, 'txBody')[0]
                ?? null;
    if (!txBody) continue;

    const { text, isMultiPara } = extractTextBody(txBody);
    if (!text.trim()) continue;

    const geom = getShapeGeom(sp);
    const norm = normalise(geom, slideW, slideH);
    const phType = getPhType(sp);

    if (phType === 'ctrTitle') {
      blocks.push({ kind: 'ctrTitle', text: text.trim(), isMultiPara, ...norm });
    } else if (phType === 'title') {
      blocks.push({ kind: 'title', text: text.trim(), isMultiPara, ...norm });
    } else {
      // body / subTitle / obj / textbox / other — all become body blocks
      blocks.push({ kind: 'body', text: text.trim(), isMultiPara, ...norm });
    }
  }

  // ── Pictures (p:pic) ──────────────────────────────────────────────────────
  for (const pic of qAll(spTree, P, 'pic')) {
    const blipFill = pic.getElementsByTagNameNS(P, 'blipFill')[0]
                  ?? pic.getElementsByTagNameNS(A, 'blipFill')[0]
                  ?? null;
    const blip = blipFill?.getElementsByTagNameNS(A, 'blip')[0] ?? null;
    const rId  = blip?.getAttributeNS(R, 'embed') ?? blip?.getAttribute('r:embed') ?? null;
    if (!rId) continue;

    const mediaTarget = rels.get(rId); // e.g. "../media/image1.png"
    if (!mediaTarget) continue;

    // Resolve the media path inside the ZIP
    // Relationship Target is relative to the slide file (ppt/slides/slide{N}.xml)
    const mediaZipPath = resolveRelTarget('ppt/slides/', mediaTarget);

    const ext = mediaZipPath.split('.').pop()?.toLowerCase() ?? 'png';

    // Skip Windows metafiles — they can't be displayed in WebView
    if (ext === 'wmf' || ext === 'emf') {
      warnings.push(`Slide ${slideIndex + 1}: vector image (.${ext}) skipped — not supported in browser`);
      continue;
    }

    const mediaFile = zip.file(mediaZipPath);
    if (!mediaFile) {
      warnings.push(`Slide ${slideIndex + 1}: could not find media file ${mediaZipPath}`);
      continue;
    }

    imgCounter++;
    const imgBytes = await mediaFile.async('uint8array');
    const imgBase64 = uint8ArrayToBase64(imgBytes);
    const suggestedName = `pptx_slide${slideIndex + 1}_img${imgCounter}.${ext}`;

    let savedName: string;
    try {
      savedName = await invoke<string>('write_asset_bytes', {
        data: imgBase64,
        filename: suggestedName,
        destDir,
      });
    } catch (err) {
      warnings.push(`Slide ${slideIndex + 1}: failed to save image — ${err}`);
      continue;
    }

    const geom = getShapeGeom(pic);
    const norm = normalise(geom, slideW, slideH);
    blocks.push({ kind: 'image', assetFilename: `assets/${savedName}`, ...norm });
  }

  // ── Graphic frames: tables, charts, SmartArt ─────────────────────────────
  for (const gf of qAll(spTree, P, 'graphicFrame')) {
    const graphicData = gf.getElementsByTagNameNS(A, 'graphicData')[0] ?? null;
    if (!graphicData) continue;

    const uri = graphicData.getAttribute('uri') ?? '';

    if (uri.includes('/table')) {
      const tbl = graphicData.getElementsByTagNameNS(A, 'tbl')[0] ?? null;
      if (!tbl) continue;
      const tableData = extractTable(tbl);
      if (!tableData) continue;
      const geom = getShapeGeom(gf);
      const norm = normalise(geom, slideW, slideH);
      blocks.push({ kind: 'table', ...tableData, ...norm });
    } else if (uri.includes('/chart')) {
      warnings.push(`Slide ${slideIndex + 1}: chart skipped — not supported`);
    } else if (uri.includes('SmartArt') || uri.includes('smartArt')) {
      warnings.push(`Slide ${slideIndex + 1}: SmartArt skipped — not supported`);
    }
  }

  // Sort by vertical position so reading order matches the slide top-to-bottom
  blocks.sort((a, b) => a.normY - b.normY);

  return blocks;
}

// ── Resolve a relationship Target relative to a base ZIP path ─────────────────

function resolveRelTarget(basePath: string, target: string): string {
  if (!target.startsWith('..')) return basePath + target;
  const parts = (basePath + target).split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') resolved.pop();
    else if (part !== '.') resolved.push(part);
  }
  return resolved.join('/');
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function parsePptx(filePath: string, destDir: string): Promise<PptxParseResult> {
  const warnings: string[] = [];

  // 1. Read binary via Rust, decode to Uint8Array
  const b64: string = await invoke('read_file_b64', { path: filePath });
  const bytes = base64ToUint8Array(b64);

  // 2. Open as ZIP
  const zip = await JSZip.loadAsync(bytes);

  // 3. Read presentation.xml for slide dimensions + ordered slide list
  const presXmlText = await zip.file('ppt/presentation.xml')?.async('string');
  if (!presXmlText) throw new Error('Not a valid PPTX file (missing ppt/presentation.xml)');
  const presDoc = parseXml(presXmlText);

  const sldSz = q(presDoc, P, 'sldSz');
  const slideW = parseInt(sldSz?.getAttribute('cx') ?? '9144000') || 9144000;
  const slideH = parseInt(sldSz?.getAttribute('cy') ?? '5143500') || 5143500;

  // 4. Read presentation rels to get ordered slide file paths
  const presRelsText = await zip.file('ppt/_rels/presentation.xml.rels')?.async('string');
  if (!presRelsText) throw new Error('Not a valid PPTX file (missing presentation rels)');
  const presRelsDoc = parseXml(presRelsText);
  const presRels = parseRels(presRelsDoc);

  // sldIdLst gives us the slide order via r:id references
  const sldIdLst = q(presDoc, P, 'sldIdLst');
  const slideRIds = sldIdLst
    ? Array.from(sldIdLst.getElementsByTagNameNS(P, 'sldId'))
        .map((el) => el.getAttributeNS(R, 'id') ?? el.getAttribute('r:id') ?? '')
        .filter(Boolean)
    : [];

  // Fallback: if no sldIdLst, enumerate slide files directly
  const slideZipPaths: string[] = slideRIds.length > 0
    ? slideRIds.map((rId) => {
        const target = presRels.get(rId) ?? '';
        return target.startsWith('/') ? target.slice(1) : `ppt/${target.replace(/^\.\//, '')}`;
      }).filter(Boolean)
    : Object.keys(zip.files)
        .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
        .sort((a, b) => {
          const na = parseInt(a.match(/\d+/)?.[0] ?? '0');
          const nb = parseInt(b.match(/\d+/)?.[0] ?? '0');
          return na - nb;
        });

  // 5. Parse each slide
  const slides: PptxParsedSlide[] = [];

  for (let i = 0; i < slideZipPaths.length; i++) {
    const slidePath = slideZipPaths[i];
    const slideFile = zip.file(slidePath);
    if (!slideFile) {
      warnings.push(`Slide ${i + 1}: file ${slidePath} not found in archive`);
      slides.push({ blocks: [], speakerNotes: '' });
      continue;
    }

    const slideXmlText = await slideFile.async('string');
    const slideDoc = parseXml(slideXmlText);

    // Read slide rels for media references
    const relsPath = slidePath.replace(/^(.*\/)([^/]+)$/, '$1_rels/$2.rels');
    const slideRelsText = await zip.file(relsPath)?.async('string');
    const slideRels = slideRelsText ? parseRels(parseXml(slideRelsText)) : new Map<string, string>();

    const blocks = await extractSlideBlocks(
      slideDoc, slideRels, zip, slideW, slideH, i, destDir, warnings,
    );
    const speakerNotes = await extractSpeakerNotes(slideRels, slidePath, zip);
    slides.push({ blocks, speakerNotes });
  }

  // Extract presentation title from the first slide's ctrTitle or title
  let presentationTitle = '';
  for (const slide of slides) {
    const titleBlock = slide.blocks.find((b) => b.kind === 'ctrTitle' || b.kind === 'title');
    if (titleBlock?.text) {
      presentationTitle = titleBlock.text;
      break;
    }
  }

  return { slides, presentationTitle, warnings };
}
