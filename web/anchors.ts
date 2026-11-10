import type { TextAnchor } from './types.ts';

// Offsets are UTF-16 code units, matching browser Range/Text offsets, including emoji.
export interface TextIndex { nodes: { node: Text; start: number; end: number }[]; text: string }
interface Span { start: number; end: number }

export function locateQuote(text: string, anchor: Partial<TextAnchor>): Span | null {
  const { start, end, quote, prefix = '', suffix = '' } = anchor;
  if (!quote) return null;
  if (Number.isInteger(start) && Number.isInteger(end) && text.slice(start, end) === quote) return { start: start!, end: end! };
  let position = 0, best: Span | null = null, bestScore = -1, tied = false;
  while ((position = text.indexOf(quote, position)) >= 0) {
    const candidate = { start: position, end: position + quote.length };
    const score = (prefix && text.slice(Math.max(0, position - prefix.length), position) === prefix ? 2 : 0) +
      (suffix && text.slice(candidate.end, candidate.end + suffix.length) === suffix ? 2 : 0);
    if (score > bestScore) { best = candidate; bestScore = score; tied = false; }
    else if (score === bestScore) tied = true;
    position++;
  }
  return tied ? null : best;
}

export function textIndex(doc: Document): TextIndex {
  const nodes: TextIndex['nodes'] = [];
  let text = '';
  const walker = doc.createTreeWalker(doc.body, doc.defaultView!.NodeFilter.SHOW_TEXT, {
    acceptNode(node) { return node.parentElement?.closest('script,style,noscript,svg,math,[data-dr-ignore]') ? 2 : 1; },
  });
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    nodes.push({ node, start: text.length, end: text.length + node.length });
    text += node.data;
  }
  return { nodes, text };
}

export function rangeFromOffsets(doc: Document, index: TextIndex, start: number, end: number): Range | null {
  const first = index.nodes.find(n => n.end > start), last = index.nodes.find(n => n.end >= end && n.start < end);
  if (!first || !last) return null;
  const range = doc.createRange();
  range.setStart(first.node, start - first.start);
  range.setEnd(last.node, end - last.start);
  return range;
}

export function anchorFromRange(doc: Document, range: Range): Required<TextAnchor> | null {
  const index = textIndex(doc);
  const start = index.nodes.find(item => item.node === range.startContainer);
  const end = index.nodes.find(item => item.node === range.endContainer);
  if (!start || !end) return null;
  const startOffset = start.start + range.startOffset, endOffset = end.start + range.endOffset, quote = index.text.slice(startOffset, endOffset);
  if (!quote.trim() || quote.length > 16000) return null;
  return {
    start: startOffset, end: endOffset, quote,
    prefix: index.text.slice(Math.max(0, startOffset - 32), startOffset),
    suffix: index.text.slice(endOffset, endOffset + 32),
  };
}

export function rangeForAnchor(doc: Document, annotation: Partial<TextAnchor>, index: TextIndex = textIndex(doc)): Range | null {
  const found = locateQuote(index.text, annotation);
  return found ? rangeFromOffsets(doc, index, found.start, found.end) : null;
}
