import { materialPaths } from './material-icons.ts';

// Microsoft Segoe Fluent Icons / MDL2 shared code points. No redistributed font files.
// https://learn.microsoft.com/windows/apps/design/iconography/segoe-fluent-icons-font
const fluent: Record<string, number> = {
  'all-books': 0xe82d, book: 0xe736, library: 0xe8f1, plus: 0xe710, clock: 0xe823, unread: 0xe794,
  bookmark: 0xe8a4, check: 0xe73e, user: 0xe77b, chevron: 0xe76c,
  'chevron-down': 0xe70d, settings: 0xe713, search: 0xe721,
  grid: 0xe74c, list: 0xea37, 'arrow-up': 0xe74a,
  'arrow-left': 0xe72b, 'arrow-right': 0xe72a, type: 0xe8d2,
  close: 0xe711, play: 0xe768, edit: 0xe70f, delete: 0xe74d, pin: 0xe718,
  copy: 0xe8c8, note: 0xe70b, underline: 0xe8dc, dictionary: 0xe82d, tip: 0xe8bd, highlighter: 0xe7e6,
  'book-info': 0xe946, hide: 0xed1a, view: 0xe890,
};
// Settings, author and note tips keep their Fluent glyphs everywhere.
const alwaysFluent = new Set(['settings', 'user', 'tip']);
const mdl2Alternatives: Record<string, number[]> = {
  unread: [0xe8a5], clock: [0xe81c], list: [0xe8fd], library: [0xe7bc], tip: [0xe82f],
};
export type IconFontGlyphs = Record<string, readonly number[]>;
let coverage: Map<string, Set<number>> | undefined;

/** DirectWrite reports actual glyph coverage, rather than guessing from the Windows version. */
export function configureIconFonts(fonts?: IconFontGlyphs, root?: ParentNode): void {
  coverage = fonts ? new Map(Object.entries(fonts).map(([family, glyphs]) => [family, new Set(glyphs)])) : undefined;
  (root ?? globalThis.document)?.querySelectorAll<HTMLElement>('[data-render-icon]').forEach(element => {
    element.outerHTML = icon(element.dataset.renderIcon!, element.dataset.renderSet as IconSet);
  });
}

export function fluentGlyph(name: string): { code: number; font?: string } | undefined {
  const code = fluent[name];
  if (code === undefined) return;
  // Older hosts retain the CSS font stack until native coverage is available.
  if (!coverage) return { code };
  if (coverage.get('Segoe Fluent Icons')?.has(code)) return { code, font: 'fluent' };
  for (const candidate of [code, ...(mdl2Alternatives[name] ?? [])]) {
    if (coverage.get('Segoe MDL2 Assets')?.has(candidate)) return { code: candidate, font: 'mdl2' };
  }
}

// The reader and settings use Material Symbols Rounded paths (see material-icons.ts).
const material: Record<string, string> = {
  'all-books': 'library_books', book: 'menu_book', library: 'library_books', plus: 'add', minus: 'remove', clock: 'schedule', unread: 'draft', tip: 'chat_bubble',
  settings: 'settings', user: 'person',
  bookmark: 'bookmark', 'bookmark-filled': 'bookmark-fill', check: 'check', chevron: 'chevron_right',
  'chevron-down': 'keyboard_arrow_down', search: 'search', grid: 'grid_view', list: 'view_list',
  toc: 'menu_open', 'arrow-up': 'arrow_upward', 'arrow-left': 'arrow_back', 'arrow-right': 'arrow_forward',
  type: 'text_fields', tune: 'tune', cookie: 'cookie', close: 'close', play: 'play_arrow', edit: 'edit', delete: 'delete',
  collapse: 'keyboard_double_arrow_up', expand: 'keyboard_double_arrow_down',
  palette: 'palette', highlighter: 'ink_highlighter', info: 'info', 'book-info': 'info',
  'page-single': 'crop_portrait', 'page-double': 'two_pager',
  pin: 'keep', copy: 'content_copy', note: 'edit_note', underline: 'format_underlined',
  'note-off': 'speaker_notes_off',
  dictionary: 'dictionary', fullscreen: 'fullscreen', 'fullscreen-exit': 'fullscreen_exit',
  paged: 'auto_stories', scroll: 'view_day', 'align-justify': 'format_align_justify',
  'align-left': 'format_align_left', 'align-center': 'format_align_center',
};

export type IconSet = 'fluent' | 'material';

/** The library home keeps Fluent glyphs; pass 'fluent' or mark a container with data-icon-set. */
export function icon(name: string, set: IconSet = 'material'): string {
  if (!Object.hasOwn(fluent, name) && !Object.hasOwn(material, name)) name = 'book';
  const attributes = `data-render-icon="${name}" data-render-set="${set}" aria-hidden="true"`;
  if (set === 'fluent' || alwaysFluent.has(name)) {
    const glyph = fluentGlyph(name);
    if (glyph) return `<span class="ui-icon fluent-icon" ${attributes}${glyph.font ? ` data-icon-font="${glyph.font}"` : ''}>&#x${glyph.code.toString(16)};</span>`;
  }
  const path = materialPaths[material[name] ?? material.book];
  return `<span class="ui-icon material-icon" ${attributes}><svg viewBox="0 -960 960 960" focusable="false"><path d="${path}"/></svg></span>`;
}
export function hydrate(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach(el => {
    const set = el.closest<HTMLElement>('[data-icon-set]')?.dataset.iconSet === 'fluent' ? 'fluent' : 'material';
    el.innerHTML = icon(el.dataset.icon ?? 'book', set);
  });
}
