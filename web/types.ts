// JSON shapes exchanged with the native host through bridge.ts `call`. They mirror the engine's
// serialisation (engine/src/library.cpp, annotations.cpp, settings.cpp, app/src/application.cpp).
import type { ReadingSettings, Theme } from './settings-state.ts';
import type { IconFontGlyphs } from './icons.ts';

export interface Chapter { href: string; title: string }
export interface TocEntry { href: string; title: string; depth?: number }
export interface Bookmark { chapter: number; ratio: number; title?: string }
export interface ReadingPosition { chapter: number; ratio: number }

export interface Book {
  id: string;
  title: string;
  author: string;
  cover?: string;
  chapters: Chapter[];
  toc: TocEntry[];
  bookmarks: Bookmark[];
  position?: ReadingPosition;
  lastRead?: number;
  addedAt?: number;
  progress: number;
  warnings?: string[];
}

export type AnnotationStyle = 'highlight' | 'underline' | 'note';
/** Text position of a passage; offsets are UTF-16 code units (see anchors.ts). */
export interface TextAnchor { start: number; end: number; quote: string; prefix?: string; suffix?: string }
export interface Annotation extends TextAnchor {
  id: string;
  chapter: number;
  href: string;
  note: string;
  color: string;
  style: AnnotationStyle;
  createdAt?: number;
  updatedAt?: number;
}

export interface Dictionary { id: string; name: string; url: string; enabled: boolean }
export type SelectionAction = 'highlight' | 'underline' | 'note' | 'copy' | 'search' | 'dictionary';
export type BookOpeningAnimation = 'circles' | 'book' | 'cover' | 'none';
export type LibrarySort = 'added' | 'read' | 'title' | 'author';

export interface ApplicationSettings {
  theme: Theme;
  shell: 'mica' | 'direct2d';
  animations: boolean;
  bookOpeningEnabled?: boolean;
  bookOpeningAnimation?: BookOpeningAnimation;
  librarySort?: LibrarySort;
  selectionActions: Record<SelectionAction, boolean>;
  dictionaries: Dictionary[];
  highlightColors?: string[];
  underlineColor?: string;
}

export interface Settings { version?: number; application: ApplicationSettings; reading: ReadingSettings }
/** A partial update for `call('settings')`; each group is merged key by key. */
export interface SettingsPatch { application?: Partial<ApplicationSettings>; reading?: Partial<ReadingSettings> }

export interface Shelf { id: string; name: string; bookIds: string[]; cover?: ShelfCover | null }
export type ShelfCover = { image: string; bookId?: undefined } | { bookId: string; image?: undefined };

export interface Bootstrap {
  settings: Settings;
  defaults: Settings;
  books: Book[];
  shelves?: Shelf[];
  dataPath: string;
  fonts?: string[];
  iconFonts?: IconFontGlyphs;
  importErrors?: string[];
}
