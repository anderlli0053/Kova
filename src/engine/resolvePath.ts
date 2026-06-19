// Join a relative image path to the document directory and collapse `.`/`..`
// segments. The Tauri asset protocol needs a normalized filesystem path, not a
// literal `/dir/../img/x.png`, or the image fails to load.
export function normalizePath(docDir: string, rel: string): string {
  const sep = docDir.includes('\\') ? '\\' : '/';
  const out: string[] = [];
  for (const s of `${docDir}${sep}${rel}`.split(/[/\\]+/)) {
    if (s === '' || s === '.') continue;
    if (s === '..') { if (out.length && !/^[A-Za-z]:$/.test(out[out.length - 1])) out.pop(); }
    else out.push(s);
  }
  // POSIX paths need their leading slash back; Windows drive letters don't.
  return (/^[A-Za-z]:$/.test(out[0] ?? '') ? '' : sep) + out.join(sep);
}
