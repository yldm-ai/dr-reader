export type Theme = 'light' | 'sepia' | 'dark';
export interface ReadingSettings {
  theme: Theme;
  mode: 'paged' | 'scroll';
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
  fullBackground: boolean;
  fullWidth: boolean;
  animation: 'none' | 'slide' | 'fade' | 'turn' | 'turn-hard';
  animationDuration: number;
  publisherStyles: boolean;
}
/** Reading settings contain primitive values; identity of the transport object is irrelevant. */
export function sameReading(a?: ReadingSettings, b?: ReadingSettings): boolean {
  if (!a || !b) return false;
  return (Object.keys(b) as (keyof ReadingSettings)[]).every(key => Object.is(a[key], b[key])) &&
    Object.keys(a).length === Object.keys(b).length;
}
