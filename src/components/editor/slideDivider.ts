import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

/** Thin rule under each `---` slide separator (skips the frontmatter block). */
const line = Decoration.line({ class: 'cm-slide-divider' });

function build(view: EditorView) {
  const { doc } = view.state;
  const b = new RangeSetBuilder<Decoration>();
  let fm = false;    // inside frontmatter
  let fence = false; // inside ``` or ~~~ code block
  for (let n = 1; n <= doc.lines; n++) {
    const l = doc.line(n);
    if (/^(`{3,}|~{3,})/.test(l.text)) { fence = !fence; continue; }
    if (fence) continue;
    if (l.text !== '---') continue; // exact match — trailing spaces aren't slide breaks
    if (n === 1) fm = true;        // opening frontmatter fence
    else if (fm) fm = false;       // closing frontmatter fence — not a slide break
    else b.add(l.from, l.from, line);
  }
  return b.finish();
}

export const slideDivider = [
  EditorView.baseTheme({ '.cm-slide-divider': { borderBottom: '1px solid var(--border, #888)' } }),
  ViewPlugin.define((v) => ({ decorations: build(v), update(u) { if (u.docChanged) this.decorations = build(u.view); } }), {
    decorations: (p) => p.decorations,
  }),
];
