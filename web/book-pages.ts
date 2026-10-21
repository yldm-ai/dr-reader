/**
 * Whole-book page position. Paginating every chapter would mean laying out the whole book
 * again after each typography or window change, so chapters the reader has opened use their
 * exact page count under the current layout and the rest are estimated from their text length.
 */

/** Visible text characters of a chapter document, without markup, scripts, styles or spaces. */
export function chapterTextLength(html: string): number {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, 'x')
    .replace(/\s+/g, '').length;
}

export interface BookPagesInput {
  /** Text length per chapter; undefined until that chapter has been read. */
  chars: (number | undefined)[];
  /** Exact page counts measured under the current layout, by chapter index. */
  exact: Map<number, number>;
  chapter: number;
  /** Zero-based page within the current chapter. */
  page: number;
  /** Characters per page derived from the page geometry, used before any chapter is measured. */
  fallbackPerPage: number;
}

export function bookPages({ chars, exact, chapter, page, fallbackPerPage }: BookPagesInput):
  { current: number; total: number; estimated: boolean } | null {
  if (!chars.length || chars.some(value => value === undefined)) return null;
  // Measured chapters of two or more pages give the density; covers and title pages would skew it.
  let measuredChars = 0, measuredPages = 0;
  for (const [index, pages] of exact) {
    const length = chars[index] ?? 0;
    if (pages >= 2 && length > 0) { measuredChars += length; measuredPages += pages; }
  }
  const perPage = Math.max(1, measuredPages ? measuredChars / measuredPages : fallbackPerPage);
  let total = 0, before = 0, estimated = false;
  chars.forEach((length, index) => {
    const known = exact.get(index);
    if (known === undefined) estimated = true;
    const pages = known ?? Math.max(1, Math.ceil((length ?? 0) / perPage));
    if (index < chapter) before += pages;
    total += pages;
  });
  return { current: Math.min(total, before + page + 1), total, estimated };
}
