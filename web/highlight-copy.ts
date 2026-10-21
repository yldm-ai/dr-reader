function pathTo(node: Node, root: Node): number[] | null {
  const path: number[] = [];
  while (node !== root) {
    const parent = node.parentNode;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, node));
    node = parent;
  }
  return path;
}
function nodeAt(root: Node, path: number[]): Node | undefined {
  let node: Node | undefined = root;
  for (const index of path) node = node?.childNodes[index];
  return node;
}
/** Re-creates the live document's CSS highlights in a serialized copy of it. */
export function copyHighlights(source: Document, target: Document) {
  const from = source.defaultView?.CSS.highlights;
  const to = target.defaultView?.CSS.highlights;
  const HighlightClass = target.defaultView?.Highlight;
  if (!from || !to || !HighlightClass) return;
  for (const [name, highlight] of from) {
    const ranges: Range[] = [];
    for (const range of highlight) {
      const startPath = pathTo(range.startContainer, source.documentElement);
      const endPath = pathTo(range.endContainer, source.documentElement);
      if (!startPath || !endPath) continue;
      const start = nodeAt(target.documentElement, startPath), end = nodeAt(target.documentElement, endPath);
      if (!start || !end) continue;
      try {
        const clone = target.createRange();
        clone.setStart(start, range.startOffset); clone.setEnd(end, range.endOffset);
        ranges.push(clone);
      } catch { /* An EPUB parser repair may change a node path; keep the page usable. */ }
    }
    to.set(name, new HighlightClass(...ranges));
  }
}
