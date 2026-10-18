export type ShortcutField = 'hotkey' | 'talk_hotkey';
export const modifierNames = ['Control', 'Alt', 'Shift', 'Super'];
const aliases: Record<string, string> = { ctrl: 'Control', control: 'Control', commandorcontrol: 'Control', alt: 'Alt', shift: 'Shift', meta: 'Super', super: 'Super', win: 'Super' };

export function normalizeShortcut(value: string) {
  const parts = value.split('+').map(part => part.trim());
  if (parts.some(part => !part)) throw new Error('快捷键组合不完整，请重新录入。');
  const rawKey = parts.pop() || '';
  const modifiers = parts.map(part => aliases[part.toLowerCase()]);
  if (!modifiers.length || modifiers.some(part => !part) || new Set(modifiers).size !== modifiers.length) throw new Error('请使用 Ctrl、Alt 或 Shift 加一个字母、数字、空格或 F 键。');
  const key = /^space$/i.test(rawKey) ? 'Space' : rawKey.toUpperCase();
  if (!/^(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|Space)$/.test(key)) throw new Error('最后一个按键需要是字母、数字、空格或 F1–F24。');
  const normalized = [...modifierNames.filter(part => modifiers.includes(part)), key].join('+');
  if (modifiers.includes('Super') || /^(?:Control\+Alt\+F4|Alt\+F4|Control\+Space|Alt\+Space)$/.test(normalized)) throw new Error('这组按键容易与系统操作冲突，请换一组 Ctrl、Alt、Shift 的组合。');
  return normalized;
}

export function shortcutKeys(value: string) {
  return value.split('+').map(part => ({ Control: 'Ctrl', CommandOrControl: 'Ctrl', Super: 'Win', Space: '空格' }[part] || part));
}

export function eventShortcut(event: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'key' | 'code'>) {
  const modifiers = [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Super'].filter(Boolean) as string[];
  if (/^(?:Control|Alt|Shift|Meta|OS)$/.test(event.key)) return { keys: modifiers, complete: false, value: '' };
  const key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : /^Digit\d$/.test(event.code) ? event.code.slice(5) : event.code === 'Space' ? 'Space' : event.key.toUpperCase();
  return { keys: [...modifiers, key], complete: true, value: [...modifiers, key].join('+') };
}

export function matchesShortcut(event: KeyboardEvent, value: string) {
  const captured = eventShortcut(event);
  if (!captured.complete) return false;
  try { return normalizeShortcut(captured.value) === normalizeShortcut(value); } catch { return false; }
}
