/** Application chrome themes. */
export type Theme = 'system' | 'light' | 'sepia' | 'dark';
/** Reading papers offer more choices than the application chrome. */
export type ReadingTheme = Theme | 'green' | 'gray' | 'night';
export interface ReadingSettings {
  theme: ReadingTheme;
  mode: 'paged' | 'scroll';
  /** Paged reading shows one page, or two side by side like an open book. */
  layout: 'single' | 'double';
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  paragraphSpacing: number;
  letterSpacing: number;
  textIndent: number;
  alignment: 'justify' | 'left' | 'center';
  width: number;
  paddingX: number;
  paddingY: number;
  paddingTop: number;
  paddingBottom: number;
  paddingLeft: number;
  paddingRight: number;
  showToolbar: boolean;
  showToc: boolean;
  tocPinned: boolean;
  showChapterTitle: boolean;
  showPagination: boolean;
  showProgress: boolean;
  autoHideProgress: boolean;
  fullBackground: boolean;
  fullWidth: boolean;
  animation: 'none' | 'slide' | 'cover' | 'fade' | 'turn' | 'turn-hard';
  animationDuration: number;
  /** Two-page spreads only turn like a book: StPageFlip's soft or hard pages, or not at all. */
  doubleAnimation: 'none' | 'turn' | 'turn-hard';
  /** Page curls need far longer than slides and fades, so they keep their own duration. */
  turnDuration: number;
  publisherStyles: boolean;
  /** Shows the estimated whole-book page position beside the chapter location. */
  showBookPages: boolean;
}
/** Reading settings contain primitive values; identity of the transport object is irrelevant. */
export function sameReading(a?: ReadingSettings, b?: ReadingSettings): boolean {
  if (!a || !b) return false;
  return (Object.keys(b) as (keyof ReadingSettings)[]).every(key => Object.is(a[key], b[key])) &&
    Object.keys(a).length === Object.keys(b).length;
}
