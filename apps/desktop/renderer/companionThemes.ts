export const themes = [
  { id: 'ink', name: '夜墨 · 暖金', background: '#25282d', bubble: '#30343d' },
  { id: 'paper', name: '纸笺 · 茶白', background: '#e6dfd0', bubble: '#faf3e5' },
  { id: 'forest', name: '林间 · 苔绿', background: '#293831', bubble: '#dbe8db' },
  { id: 'sea', name: '暮海 · 雾蓝', background: '#1c3042', bubble: '#dce6ed' },
  { id: 'sakura', name: '樱夜 · 霞粉', background: '#3a2430', bubble: '#f4d9e4' },
  { id: 'sky', name: '晴空 · 天青', background: '#dceaf2', bubble: '#f7fcff' },
  { id: 'amber', name: '琥珀 · 夕照', background: '#3b2b1f', bubble: '#f3e2c9' },
  { id: 'bamboo', name: '竹月 · 霜青', background: '#23302c', bubble: '#d9ebe2' },
] as const;
export type CompanionTheme = typeof themes[number]['id'] | 'custom';
export const themeIds = new Set<string>(['custom', ...themes.map(theme => theme.id)]);
export function resolveTheme(stored: { theme?: string; background_mode?: string; background_color?: string; bubble_color?: string }): CompanionTheme {
  if (stored.theme === 'custom' || themes.some(theme => theme.id === stored.theme)) return stored.theme as CompanionTheme;
  if (stored.background_mode === 'image') return 'custom';
  return themes.find(theme => theme.background === stored.background_color && theme.bubble === stored.bubble_color)?.id
    || (!stored.background_color ? 'ink' : 'custom');
}
