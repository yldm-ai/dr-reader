export interface Choice { value: string; label: string }
export function fontChoices(fonts: readonly string[], current = ''): Choice[] {
  const choices: Choice[] = [
    { value: 'serif', label: '默认衬线字体' },
    { value: 'sans-serif', label: '默认无衬线字体' },
  ];
  const names = [...new Set(fonts.map(name => name.trim()).filter(Boolean))]
    .filter(name => name !== 'serif' && name !== 'sans-serif')
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  if (current && !choices.some(item => item.value === current) && !names.includes(current)) {
    choices.push({ value: current, label: `${current}（当前字体，未安装时使用回退字体）` });
  }
  return [...choices, ...names.map(name => ({ value: name, label: name }))];
}
export function fontStack(font: string): string {
  if (font === 'serif') return "'Noto Serif CJK SC','SimSun',Georgia,serif";
  const fallback = "'Microsoft YaHei','Microsoft YaHei UI','Noto Sans SC','Noto Sans CJK SC','Segoe UI',sans-serif";
  return font === 'sans-serif' ? fallback : `${JSON.stringify(font)},${fallback}`;
}
