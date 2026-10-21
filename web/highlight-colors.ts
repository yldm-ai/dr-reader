/**
 * Highlight colours. Presets are Notion's background colours (https://docs.super.so/notion-colors);
 * annotations store a lowercase #rrggbb, or one of the five names saved before custom colours.
 */
export interface NotionColor { name: string; label: string; light: string; dark: string; text: string; darkText: string }

export const NOTION_COLORS: NotionColor[] = [
  { name: 'gray', label: '灰', light: '#ebeced', dark: '#454b4e', text: '#9b9a97', darkText: '#979a9b' },
  { name: 'brown', label: '棕', light: '#e9e5e3', dark: '#434040', text: '#64473a', darkText: '#937264' },
  { name: 'orange', label: '橙', light: '#faebdd', dark: '#594a3a', text: '#d9730d', darkText: '#ffa344' },
  { name: 'yellow', label: '黄', light: '#fbf3db', dark: '#59563b', text: '#dfab01', darkText: '#ffdc49' },
  { name: 'green', label: '绿', light: '#ddedea', dark: '#354c4b', text: '#0f7b6c', darkText: '#4dab9a' },
  { name: 'blue', label: '蓝', light: '#ddebf1', dark: '#364954', text: '#0b6e99', darkText: '#529cca' },
  { name: 'purple', label: '紫', light: '#eae4f2', dark: '#443f57', text: '#6940a5', darkText: '#9a6dd7' },
  { name: 'pink', label: '粉', light: '#f4dfeb', dark: '#533b4c', text: '#ad1a72', darkText: '#e255a1' },
  { name: 'red', label: '红', light: '#fbe4e4', dark: '#594141', text: '#e03e3e', darkText: '#ff7369' },
];
export const DEFAULT_PALETTE = ['#fbf3db', '#ddedea', '#ddebf1', '#f4dfeb', '#eae4f2'];
export const PALETTE_SIZE = 5;

const byLight = new Map(NOTION_COLORS.map(color => [color.light, color]));
const legacy: Record<string, string> = { yellow: '#fbf3db', green: '#ddedea', blue: '#ddebf1', pink: '#f4dfeb', purple: '#eae4f2' };

export function normalizeColor(color: string): string {
  const value = (legacy[color] ?? color ?? '').toLowerCase();
  return /^#[0-9a-f]{6}$/.test(value) ? value : DEFAULT_PALETTE[0];
}

/** The newest pick goes first and the oldest falls off; a repeated pick just moves to the front. */
export function pushColor(palette: string[], color: string): string[] {
  const value = normalizeColor(color);
  return [value, ...palette.map(normalizeColor).filter(item => item !== value)].slice(0, PALETTE_SIZE);
}

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const hex = ([r, g, b]: Rgb) => '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

export function toHsl(color: string): [number, number, number] {
  const [r, g, b] = rgb(color).map(v => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}
export function fromHsl(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return hex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}

/**
 * How a stored colour paints on a reading paper: `fill` for highlights, `ink` for underlines
 * and list markers. Notion presets use their exact dark-mode values; on tinted light papers the
 * fill is multiplied onto the paper so it stands out as much as it would on white.
 */
export function paint(color: string, paper: string, dark: boolean): { fill: string; ink: string } {
  const value = normalizeColor(color);
  const preset = byLight.get(value);
  const [h, s] = toHsl(value);
  if (dark) return {
    fill: preset?.dark ?? fromHsl(h, Math.min(s, 0.32), 0.3),
    ink: preset?.darkText ?? fromHsl(h, Math.max(s, 0.55), 0.66),
  };
  const [pr, pg, pb] = rgb(paper), [cr, cg, cb] = rgb(value);
  return {
    fill: hex([pr * cr / 255, pg * cg / 255, pb * cb / 255]),
    ink: preset?.text ?? fromHsl(h, Math.max(s, 0.55), 0.42),
  };
}
