// A small Markdown renderer for agent answers. Every character of the source is HTML-escaped
// before any markup is added, and only a fixed set of tags is produced, so model output can
// never inject elements, attributes or scripts. Links render as their text (no navigation out
// of the reader); math, tables and HTML stay literal text.

const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => entities[c]);

/** Inline spans on already-escaped text: code first, so its contents stay literal. */
function inline(escaped: string): string {
  const codes: string[] = [];
  let text = escaped.replace(/`([^`\n]+)`/g, (_, code: string) => `\u0000${codes.push(code) - 1}\u0000`);
  text = text
    .replace(/\[([^\]\n]+)\]\((?:[^)\s]+)\)/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  return text.replace(/\u0000(\d+)\u0000/g, (_, index: string) => `<code>${codes[Number(index)]}</code>`);
}

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) html.push(`<p>${paragraph.map(line => inline(escapeHtml(line))).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) {
      const tag = list.ordered ? 'ol' : 'ul';
      html.push(`<${tag}>${list.items.map(item => `<li>${inline(escapeHtml(item))}</li>`).join('')}</${tag}>`);
    }
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) html.push(`<blockquote>${quote.map(line => inline(escapeHtml(line))).join('<br>')}</blockquote>`);
    quote = [];
  };
  const flush = () => { flushParagraph(); flushList(); flushQuote(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !lines[i].trimStart().startsWith(fence[1])) code.push(lines[i]);
      html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      flush();
      // Answers sit in a narrow panel: every heading level renders as one modest heading.
      html.push(`<h4>${inline(escapeHtml(heading[2]))}</h4>`);
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); html.push('<hr>'); continue; }
    const quoted = line.match(/^\s{0,3}>\s?(.*)$/);
    if (quoted) { flushParagraph(); flushList(); quote.push(quoted[1]); continue; }
    const item = line.match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/);
    if (item) {
      flushParagraph(); flushQuote();
      const ordered = !item[1];
      if (list && list.ordered !== ordered) flushList();
      (list ??= { ordered, items: [] }).items.push(item[3]);
      continue;
    }
    // An indented line continues the previous list item.
    if (list && /^\s{2,}\S/.test(line)) {
      const items: string[] = (list as { items: string[] }).items;
      items[items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    flushList(); flushQuote();
    paragraph.push(line);
  }
  flush();
  return html.join('');
}
