export interface TocItem { href: string; depth?: number }

export function tocAnchor(href: string): string {
  const hash = href.indexOf('#');
  if (hash < 0) return '';
  const fragment = href.slice(hash + 1);
  try { return decodeURIComponent(fragment); } catch { return fragment; }
}

/** A document can contain many TOC anchors; only one heading owns the reading position. */
export function tocSelectionIndex(toc: readonly TocItem[], href?: string,
  location: { anchor?: string; positions?: ReadonlyMap<number, number>; offset?: number } = {}): number {
  const candidates = toc.map((item, index) => ({ ...item, index }))
    .filter(item => item.href.split('#')[0] === href);
  if (!candidates.length) return -1;
  const deepest = (items: typeof candidates) => items.reduce((best, item) =>
    (item.depth ?? 0) > (best.depth ?? 0) ? item : best).index;
  if (location.anchor !== undefined) {
    const exact = candidates.filter(item => tocAnchor(item.href) === location.anchor);
    if (exact.length) return deepest(exact);
  }
  if (location.positions && location.offset !== undefined) {
    const reached = candidates.filter(item => location.positions!.has(item.index) &&
      location.positions!.get(item.index)! <= location.offset!);
    if (reached.length) {
      const last = Math.max(...reached.map(item => location.positions!.get(item.index)!));
      return deepest(reached.filter(item => location.positions!.get(item.index) === last));
    }
  }
  // Before layout is ready, prefer the document start, then the first distinct target.
  const first = candidates.find(item => !tocAnchor(item.href)) ?? candidates[0];
  return deepest(candidates.filter(item => tocAnchor(item.href) === tocAnchor(first.href)));
}
