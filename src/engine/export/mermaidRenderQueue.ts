import mermaid from 'mermaid';

/**
 * Mermaid keeps internal global state and cannot handle concurrent render()
 * calls — calling it again while one is already in flight either hangs or
 * rejects (this is a known constraint; see the comments in SlideRenderer.tsx's
 * MermaidDiagram and exportPptx.ts's mermaidToDataUrl). Several places in the
 * app mount many MermaidDiagram instances at once — the thumbnail panel on
 * file load, and the off-screen PDF/Print export trees that render the entire
 * deck simultaneously — which races exactly that constraint.
 *
 * Every render() call in the app funnels through this queue so they run one
 * at a time instead of racing. A per-call timeout keeps one hung/invalid
 * diagram from wedging every other diagram in the app for the rest of the
 * session — the queue moves on after the timeout regardless of whether the
 * stuck call ever settles.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

let tail: Promise<unknown> = Promise.resolve();

export function queuedMermaidRender(id: string, src: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ svg: string }> {
  const run = tail.then(() => Promise.race([
    mermaid.render(id, src),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Mermaid render timeout')), timeoutMs)),
  ]));
  // Chain `tail` through a rejection-swallowing branch so a failed/timed-out
  // render still releases the queue for the next caller — the real rejection
  // is preserved and still propagates to whoever awaits `run` below.
  tail = run.catch(() => {});
  return run;
}
