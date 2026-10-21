const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/**
 * EPUB chapters are XHTML, but the reader parses them as HTML (iframe srcdoc), where `/>` on a
 * non-void element is ignored: `<title/>` only opens the title and swallows the whole chapter
 * as title text, leaving a blank page. Expands such elements to `<x></x>`; void ones stay.
 */
export function htmlFromXhtml(xhtml: string): string {
  return xhtml.replace(/<([A-Za-z][\w:.-]*)((?:\s(?:[^<>"']|"[^"]*"|'[^']*')*)?)\/>/g, (tag, name: string, attrs: string) => {
    const local = name.slice(name.indexOf(':') + 1).toLowerCase();
    return VOID.has(local) ? tag : `<${name}${attrs.replace(/\s+$/, '')}></${name}>`;
  });
}
