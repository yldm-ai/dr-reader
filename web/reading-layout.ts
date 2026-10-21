import type { ReadingSettings } from './settings-state.ts';

export function pageMargins(settings: Partial<ReadingSettings>, width: number, height: number) {
  let left = settings.paddingLeft ?? settings.paddingX ?? 44;
  let right = settings.paddingRight ?? settings.paddingX ?? 44;
  let top = settings.paddingTop ?? settings.paddingY ?? 38;
  let bottom = settings.paddingBottom ?? settings.paddingY ?? 38;
  const x = Math.min(1, Math.max(0, width - 80) / Math.max(1, left + right));
  const y = Math.min(1, Math.max(0, height - 80) / Math.max(1, top + bottom));
  left = Math.floor(left * x); right = Math.floor(right * x);
  top = Math.floor(top * y); bottom = Math.floor(bottom * y);
  return { left, right, top, bottom };
}

/** A click becomes navigation only after a stationary, primary-pointer tap. */
export function pageClickDirection(x: number, width: number): -1 | 0 | 1 {
  if (width <= 0 || x < 0 || x > width) return 0;
  return x < width * .3 ? -1 : x > width * .7 ? 1 : 0;
}
