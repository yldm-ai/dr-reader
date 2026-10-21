/** Book titles past `max` characters (code points, so CJK and emoji count once) end in an ellipsis. */
export function shortTitle(title: string, max = 20): string {
  const chars = Array.from(title.trim());
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}
