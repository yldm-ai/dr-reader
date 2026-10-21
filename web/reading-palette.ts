import type { Theme } from './settings-state.ts';

interface ReadingPalette {
  paper: string;
  text: string;
  link: string;
  selection: string;
}
// One palette for EPUB documents, theme swatches and the typography preview.
const palettes: Record<Theme, ReadingPalette> = {
  light: { paper: '#ffffff', text: '#37352f', link: '#2f6f9f', selection: '#2f6f9f33' },
  sepia: { paper: '#fffaf3', text: '#4a4036', link: '#845e43', selection: '#845e4333' },
  dark: { paper: '#191919', text: '#cfcfcd', link: '#86b4dc', selection: '#86b4dc55' },
};
export function readingPalette(theme: string): ReadingPalette {
  return palettes[theme as Theme] ?? palettes.light;
}
