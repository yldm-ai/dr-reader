import type { ReadingBackground } from './settings-state.ts';

/**
 * Page backgrounds are textures laid over the paper colour, so every texture works with every
 * theme. They are generated with SVG turbulence (seamless thanks to stitchTiles) rather than
 * shipped as images: dark specks on light papers, light specks on dark ones.
 */
interface Texture {
  /** Tile edge in CSS pixels. */
  size: number;
  /** Filter primitives producing the noise; the shared tail turns it into translucent ink. */
  noise: string;
  /** The noise's mean value, which maps to half the opacity. */
  center: number;
  /** How far the specks spread around that mean. */
  contrast: number;
  /** Ink opacity at full strength on a light paper. Kept low: the page is for reading. */
  opacity: number;
}
const textures: Record<Exclude<ReadingBackground, 'plain'>, Texture> = {
  // Fine sand-like grain, the most neutral texture.
  grain: { size: 160, noise: '<feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/>', center: 0.5, contrast: 3, opacity: 0.07 },
  // Short fibres running along the sheet, as in handmade paper.
  fiber: { size: 240, noise: '<feTurbulence type="fractalNoise" baseFrequency="0.05 0.42" numOctaves="3" stitchTiles="stitch"/>', center: 0.5, contrast: 2.6, opacity: 0.06 },
  // A woven cloth: horizontal and vertical threads blended.
  linen: { size: 200, noise: '<feTurbulence type="fractalNoise" baseFrequency="0.7 0.035" numOctaves="2" stitchTiles="stitch" result="a"/><feTurbulence type="fractalNoise" baseFrequency="0.035 0.7" numOctaves="2" stitchTiles="stitch" result="b"/><feBlend in="a" in2="b" mode="multiply"/>', center: 0.25, contrast: 3, opacity: 0.07 },
  // Soft clouds of ink, like a washed rice paper.
  wash: { size: 480, noise: '<feTurbulence type="fractalNoise" baseFrequency="0.006" numOctaves="4" stitchTiles="stitch"/>', center: 0.5, contrast: 3, opacity: 0.06 },
};

/** Backgrounds in the order the pickers show them. */
export const readingBackgrounds: [ReadingBackground, string][] = [
  ['plain', '纯色'], ['grain', '细砂'], ['fiber', '纸纹'], ['linen', '布纹'], ['wash', '晕染'],
];

const cache = new Map<string, string>();
/**
 * The CSS image for a background on a light or dark paper, or `none` for a plain page.
 * `strength` scales the ink; previews use a stronger one so small swatches still show it.
 */
export function backgroundImage(background: string | undefined, dark: boolean, strength = 1): string {
  const texture = textures[background as keyof typeof textures];
  if (!texture) return 'none';
  const key = `${background}:${dark}:${strength}`;
  const cached = cache.get(key);
  if (cached) return cached;
  // Dark papers need less ink: light specks on black read stronger than dark ones on white.
  const ink = dark ? 1 : 0;
  const { size, noise, center, contrast } = texture;
  const opacity = texture.opacity * strength * (dark ? 0.75 : 1);
  // alpha = opacity * (contrast * (noise - center) + 0.5), read from the noise's red channel.
  const gain = +(opacity * contrast).toFixed(4), offset = +(opacity * (0.5 - contrast * center)).toFixed(4);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><filter id="t" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">${noise}<feColorMatrix values="0 0 0 0 ${ink} 0 0 0 0 ${ink} 0 0 0 0 ${ink} ${gain} 0 0 0 ${offset}"/></filter><rect width="100%" height="100%" filter="url(#t)"/></svg>`;
  const image = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  cache.set(key, image);
  return image;
}
