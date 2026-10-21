import { materialPaths } from './material-icons.ts';

// Microsoft Segoe Fluent Icons / MDL2 shared code points. No redistributed font files.
// https://learn.microsoft.com/windows/apps/design/iconography/segoe-fluent-icons-font
const fluent: Record<string, number> = {
  book: 0xe736, library: 0xe8f1, plus: 0xe710, clock: 0xed5a, unread: 0xe794,
  bookmark: 0xe8a4, check: 0xe73e, user: 0xe77b, chevron: 0xe76c,
  'chevron-down': 0xe70d, settings: 0xe713, search: 0xe721,
  grid: 0xe74c, list: 0xea37, 'arrow-up': 0xe74a,
  'arrow-left': 0xe72b, 'arrow-right': 0xe72a, type: 0xe8d2,
  close: 0xe711, play: 0xe768, edit: 0xe70f, delete: 0xe74d, pin: 0xe718,
  copy: 0xe8c8, note: 0xe70b, underline: 0xe8dc, dictionary: 0xe82d,
};
// Settings and author keep their Fluent glyphs everywhere.
const alwaysFluent = new Set(['settings', 'user']);

// The reader and settings use Material Symbols Rounded paths (see material-icons.ts).
const material: Record<string, string> = {
  book: 'menu_book', library: 'library_books', plus: 'add', minus: 'remove', clock: 'schedule',
  bookmark: 'bookmark', 'bookmark-filled': 'bookmark-fill', check: 'check', chevron: 'chevron_right',
  'chevron-down': 'keyboard_arrow_down', search: 'search', grid: 'grid_view', list: 'view_list',
  toc: 'menu_open', 'arrow-up': 'arrow_upward', 'arrow-left': 'arrow_back', 'arrow-right': 'arrow_forward',
  type: 'text_fields', tune: 'tune', cookie: 'cookie', close: 'close', play: 'play_arrow', edit: 'edit', delete: 'delete',
  collapse: 'keyboard_double_arrow_up', expand: 'keyboard_double_arrow_down',
  palette: 'palette', highlighter: 'ink_highlighter', info: 'info',
  'page-single': 'crop_portrait', 'page-double': 'two_pager',
  pin: 'keep', copy: 'content_copy', note: 'edit_note', underline: 'format_underlined',
  tip: 'lightbulb-fill', 'note-off': 'speaker_notes_off',
  dictionary: 'dictionary', fullscreen: 'fullscreen', 'fullscreen-exit': 'fullscreen_exit',
  paged: 'auto_stories', scroll: 'view_day', 'align-justify': 'format_align_justify',
  'align-left': 'format_align_left', 'align-center': 'format_align_center',
};

export type IconSet = 'fluent' | 'material';

/** The library home keeps Fluent glyphs; pass 'fluent' or mark a container with data-icon-set. */
export function icon(name: string, set: IconSet = 'material'): string {
  if (set === 'fluent' || alwaysFluent.has(name))
    return `<span class="ui-icon fluent-icon" aria-hidden="true">&#x${(fluent[name] ?? fluent.book).toString(16)};</span>`;
  const path = materialPaths[material[name] ?? material.book];
  return `<span class="ui-icon material-icon" aria-hidden="true"><svg viewBox="0 -960 960 960" focusable="false"><path d="${path}"/></svg></span>`;
}
export function hydrate(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach(el => {
    const set = el.closest<HTMLElement>('[data-icon-set]')?.dataset.iconSet === 'fluent' ? 'fluent' : 'material';
    el.innerHTML = icon(el.dataset.icon ?? 'book', set);
  });
}
