import { useEffect, useRef, useState } from 'react';
import { bridge } from './state';
import { savePreferences } from './preferences';
import { eventShortcut, matchesShortcut, normalizeShortcut, shortcutKeys, type ShortcutField } from '../shared/shortcut';
import type { WelcomeCue } from './welcomeSound';

type Phase = 'idle' | 'arming' | 'recording' | 'saving' | 'saved' | 'testing' | 'verified' | 'error';
export function WelcomeShortcut({ field, value, disabled, onSaved, onTesting, onTested, onCue }: {
  field: ShortcutField; value: string; disabled: boolean;
  onSaved(): void; onTesting?(): void; onTested(): void; onCue(cue: WelcomeCue): void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [draft, setDraft] = useState(value);
  const [live, setLive] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const root = useRef<HTMLDivElement>(null), input = useRef<HTMLButtonElement>(null);
  const candidate = useRef(''), token = useRef(0), alive = useRef(true), pressed = useRef(false), latest = useRef({ onSaved, onTesting, onTested, onCue });
  latest.current = { onSaved, onTesting, onTested, onCue };
  const recording = phase === 'recording' || phase === 'arming';
  const busy = phase === 'saving' || phase === 'arming';
  const label = field === 'hotkey' ? '设置呼出快捷键' : '设置说话快捷键';
  useEffect(() => { setDraft(value); }, [value]);

  function cancel() {
    token.current++; candidate.current = ''; setPhase('idle'); setLive([]); setDraft(value); setMessage('');
    void bridge.welcomeShortcutCapture(false);
  }
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; token.current++; void bridge.welcomeShortcutCapture(false); };
  }, []);
  useEffect(() => {
    if (!recording) return;
    const blur = () => cancel();
    window.addEventListener('blur', blur);
    return () => window.removeEventListener('blur', blur);
  }, [recording, value]);

  function verified(keys: string) {
    if (disabled || busy || recording || pressed.current) return;
    pressed.current = true;
    setPhase('verified'); setLive(shortcutKeys(keys)); setMessage('检验成功，这组按键已经收到。');
    latest.current.onCue('confirm'); latest.current.onTested();
  }
  useEffect(() => {
    if (disabled || recording || busy) return;
    const down = (event: KeyboardEvent) => {
      if (event.repeat || (event.target instanceof Element && event.target.closest('[data-recording=true]'))) return;
      if (phase === 'testing') setLive(shortcutKeys(eventShortcut(event).keys.join('+')));
      if (matchesShortcut(event, value)) { event.preventDefault(); verified(value); }
    };
    const up = () => { pressed.current = false; setLive([]); };
    const off = bridge.onEvent(event => {
      if (event.type !== 'desktop.welcome-shortcut-used' || event.field !== field) return;
      try { if (normalizeShortcut(String(event.shortcut)) === normalizeShortcut(value)) verified(value); } catch { /* Ignore a stale registration. */ }
    });
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', up);
    return () => { off(); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', up); };
  }, [disabled, busy, recording, phase, value, field]);

  async function begin() {
    if (recording) { cancel(); return; }
    const run = ++token.current; candidate.current = ''; setLive([]); setMessage('按下组合键，松开后自动校验。Esc 取消。'); setPhase('arming');
    try {
      const result = await bridge.welcomeShortcutCapture(true);
      if (!alive.current || run !== token.current) return;
      if (!result.ok) throw new Error('暂时不能录入快捷键，请重试。');
      setPhase('recording'); input.current?.focus({ preventScroll: true });
    } catch (reason) {
      if (alive.current && run === token.current) { setPhase('error'); setMessage(String(reason instanceof Error ? reason.message : reason)); }
    }
  }

  async function commit(raw: string) {
    const run = ++token.current, previous = value;
    setPhase('saving'); setMessage('正在检查按键是否可用…');
    let saved = false;
    try {
      const normalized = normalizeShortcut(raw); setDraft(normalized);
      const check = await bridge.welcomeShortcutCheck(field, normalized);
      if (!alive.current || run !== token.current) return;
      if (!check.ok) throw new Error(check.error || '这组按键不可用，请换一组。');
      await savePreferences({ [field]: normalized }); saved = true;
      const registration = await bridge.welcomeShortcutCapture(false);
      if (!registration.ok || !registration[field === 'hotkey' ? 'summon_ok' : 'talk_ok']) {
        await savePreferences({ [field]: previous }); saved = false;
        throw new Error('注册时这组按键已被占用，已恢复原来的快捷键。');
      }
      if (!alive.current || run !== token.current) return;
      setPhase('saved'); setLive([]); setMessage('已保存。点击检验，再按一次这组快捷键。');
      latest.current.onCue('confirm'); latest.current.onSaved();
    } catch (reason) {
      if (alive.current && run === token.current) {
        if (!saved) setDraft(raw);
        setPhase('error'); setMessage(reason instanceof Error ? reason.message : String(reason)); latest.current.onCue('error');
      }
    } finally { if (alive.current && run === token.current) await bridge.welcomeShortcutCapture(false); }
  }

  async function test() {
    const run = ++token.current; setLive([]); setMessage('正在检查系统注册…'); setPhase('saving');
    try {
      const registration = await bridge.welcomeShortcutCapture(false);
      const result = await bridge.welcomeShortcutCheck(field, value);
      if (!alive.current || run !== token.current) return;
      if (!result.ok || !registration[field === 'hotkey' ? 'summon_ok' : 'talk_ok']) throw new Error(result.error || '系统未能注册这组快捷键，请重新设置。');
      setDraft(value); setPhase('testing'); setMessage('现在按一次这组快捷键，看看屏幕的回应。');
      pressed.current = false; latest.current.onTesting?.();
      input.current?.focus({ preventScroll: true }); latest.current.onCue('focus');
    } catch (reason) {
      if (alive.current && run === token.current) { setPhase('error'); setMessage(reason instanceof Error ? reason.message : String(reason)); latest.current.onCue('error'); }
    }
  }

  const keys = recording ? live : shortcutKeys(draft);
  return <div ref={root} className="mg-shortcut-editor" data-field={field} data-phase={phase} data-recording={recording}>
    <button ref={input} type="button" className="mg-shortcut-capture" aria-label={label} aria-pressed={recording} disabled={disabled || phase === 'saving'} onClick={() => void begin()}
      onBlur={event => { if (recording && !(event.relatedTarget instanceof Node && root.current?.contains(event.relatedTarget))) cancel(); }}
      onKeyDown={event => {
        if (!recording) return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Escape') { cancel(); return; }
        if (phase === 'arming' || event.repeat || event.nativeEvent.isComposing) return;
        const chord = eventShortcut(event.nativeEvent); setLive(shortcutKeys(chord.keys.join('+')));
        if (chord.complete) candidate.current = chord.value;
        latest.current.onCue('press');
      }}
      onKeyUp={event => {
        if (!recording) return;
        event.preventDefault(); event.stopPropagation();
        if (candidate.current) { const raw = candidate.current; candidate.current = ''; void commit(raw); }
        else setLive(shortcutKeys(eventShortcut(event.nativeEvent).keys.join('+')));
      }}>
      <span className="mg-keys mg-keys-big" aria-live="polite">{keys.length ? keys.map((key, index) => <kbd key={`${key}-${index}`} data-pressed={recording || live.includes(key)}>{key}</kbd>) : <span className="mg-shortcut-placeholder">按下你的组合键</span>}</span>
    </button>
    <div className="mg-shortcut-actions">
      <button type="button" disabled={disabled || busy} onClick={() => void begin()}>{recording ? '取消录入' : '更改按键'}</button>
      <button type="button" disabled={disabled || busy || recording} onClick={() => void test()}>检验按键</button>
    </div>
    {message && <p className="mg-shortcut-message" role={phase === 'error' ? 'alert' : 'status'}>{message}</p>}
  </div>;
}
