import type { ReadingTheme } from './settings-state.ts';

interface ReadingPalette {
  paper: string;
  text: string;
  link: string;
  selection: string;
  /** Dark papers take dark highlight fills and light underline inks. */
  dark: boolean;
}
// One palette for EPUB documents, theme swatches and the typography preview.
const palettes: Record<ReadingTheme, ReadingPalette> = {
  light: { paper: '#ffffff', text: '#37352f', link: '#2f6f9f', selection: '#2f6f9f33', dark: false },
  dark: { paper: '#191919', text: '#cfcfcd', link: '#86b4dc', selection: '#86b4dc55', dark: true },
  sepia: { paper: '#fffaf3', text: '#4a4036', link: '#845e43', selection: '#845e4333', dark: false },
  green: { paper: '#edf2e7', text: '#33402f', link: '#4c7a47', selection: '#4c7a4733', dark: false },
  gray: { paper: '#f1f1ef', text: '#37352f', link: '#2f6f9f', selection: '#2f6f9f33', dark: false },
  night: { paper: '#1b2230', text: '#c6cfdb', link: '#8ab4e0', selection: '#8ab4e055', dark: true },
};
/** Reading themes in the order the drawer shows them. */
export const readingThemes: [ReadingTheme, string][] = [
  ['light', '明亮'], ['dark', '黑暗'], ['sepia', '纸张'], ['green', '豆绿'], ['gray', '雾灰'], ['night', '夜蓝'],
];
export function readingPalette(theme: string): ReadingPalette {
  return palettes[theme as ReadingTheme] ?? palettes.light;
}
