// Microsoft Segoe Fluent Icons / MDL2 shared code points. No redistributed font files.
// https://learn.microsoft.com/windows/apps/design/iconography/segoe-fluent-icons-font
const glyphs: Record<string, number> = {
  book: 0xe736, library: 0xe8f1, plus: 0xe710, clock: 0xe81c,
  bookmark: 0xe8a4, check: 0xe73e, user: 0xe77b, chevron: 0xe76c,
  'chevron-down': 0xe70d, settings: 0xe713, search: 0xe721,
  grid: 0xe8a9, list: 0xe8fd, 'arrow-up': 0xe74a,
  'arrow-left': 0xe72b, 'arrow-right': 0xe72a, type: 0xe8d2,
  close: 0xe711, play: 0xe768, edit: 0xe70f, delete: 0xe74d, pin: 0xe718,
  copy: 0xe8c8, note: 0xe70b, underline: 0xe8dc, dictionary: 0xe82d,
};
export function icon(name: string): string {
  return `<span class="fluent-icon" aria-hidden="true">&#x${(glyphs[name] ?? glyphs.book).toString(16)};</span>`;
}
export function hydrate(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach(el => {
    el.innerHTML = icon(el.dataset.icon ?? 'book');
  });
}
