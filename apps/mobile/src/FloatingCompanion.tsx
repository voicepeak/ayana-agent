import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
import type { MobileState } from './state';
import { replyWaitLabel } from './state';
import { SpeechLine, textFor, languageFor } from './SpeechLine';
import { NativeCompanion, nativeAndroid } from './companionNative';
import { UiIcon } from './UiIcon';

interface Props {
  state: MobileState;
  portrait: React.ReactNode;
  style: CSSProperties;
  collapsed: boolean;
  text: string;
  notice: string;
  sending: boolean;
  onText(text: string): void;
  onSend(): void;
  onCancel(): void;
  onCollapse(collapsed: boolean): void;
  onRestore(): void;
  onClose(): void;
  onError(error: unknown): void;
}
export function FloatingCompanion(props: Props) {
  const { state, collapsed } = props;
  const drag = useRef<{ x: number; y: number; startX: number; startY: number; moved: boolean } | null>(null);
  const pending = useRef({ x: 0, y: 0, frame: 0 });
  const resizeStart = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const caption = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [reading, setReading] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const active = state.speeches.find(speech => speech.id === state.presented);
  const recent = [...state.history].reverse().find(item => item.role === 'assistant' && item.displayed !== false && item.status !== 'cancelled');
  const ui = state.settings.companion_ui || {};
  const primary = String(ui.primary_language || 'ja');
  const translation = String(ui.translation_language || 'zh');
  const main = active ? textFor(active, primary) : recent ? textFor({ ja: recent.speech_ja || '', zh: recent.display_zh || '', en: recent.display_en }, primary) : '';
  const secondary = recent && translation !== 'none' && translation !== primary
    ? textFor({ ja: recent.speech_ja || '', zh: recent.display_zh || '', en: recent.display_en }, translation) : '';
  const recentLanguages = { ja: recent?.speech_ja || '', zh: recent?.display_zh || '', en: recent?.display_en };
  useEffect(() => {
    const element = caption.current;
    if (!element || reading) return;
    const check = () => setOverflow(element.scrollHeight > element.clientHeight + 2);
    const observer = new ResizeObserver(check); observer.observe(element); check();
    return () => observer.disconnect();
  }, [main, translation, secondary, active?.zh, active?.en, reading]);
  useEffect(() => {
    if (!textarea.current) return;
    textarea.current.style.height = 'auto';
    textarea.current.style.height = `${Math.min(96, textarea.current.scrollHeight)}px`;
  }, [props.text, collapsed]);
  const moving = (event: PointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    const dx = event.screenX - drag.current.x, dy = event.screenY - drag.current.y;
    if (Math.abs(event.screenX - drag.current.startX) + Math.abs(event.screenY - drag.current.startY) > 3) drag.current.moved = true;
    drag.current.x = event.screenX; drag.current.y = event.screenY;
    pending.current.x += dx; pending.current.y += dy;
    if (nativeAndroid && !pending.current.frame) pending.current.frame = requestAnimationFrame(() => {
      const { x, y } = pending.current;
      pending.current = { x: 0, y: 0, frame: 0 };
      void NativeCompanion.move({ dx: x, dy: y }).catch(props.onError);
    });
  };
  const down = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.screenX, y: event.screenY, startX: event.screenX, startY: event.screenY, moved: false };
  };
  const up = (event: PointerEvent<HTMLElement>) => {
    const moved = drag.current?.moved;
    drag.current = null;
    if (pending.current.frame) cancelAnimationFrame(pending.current.frame);
    const { x, y } = pending.current; pending.current = { x: 0, y: 0, frame: 0 };
    if (nativeAndroid) void NativeCompanion.move({ dx: x, dy: y, settle: true }).catch(props.onError);
    if (collapsed && !moved && event.type !== 'pointercancel') props.onCollapse(false);
  };
  const busy = state.task === 'thinking' || Boolean(state.current) || state.speeches.some(item => item.state === 'generated');
  if (collapsed) return <main className="floating-mini" style={props.style} aria-label="彩名悬浮头像"
    onPointerDown={down} onPointerMove={moving} onPointerUp={up} onPointerCancel={up}>
    {props.portrait}<span className={`floating-dot ${state.connected ? 'online' : ''}`} />
    <button className="mini-expand" type="button" onClick={event => { if (event.detail === 0) props.onCollapse(false); }} aria-label="展开悬浮窗" />
  </main>;
  return <main className="floating-companion" style={props.style}>
    <section className="floating-note" data-reading={reading} aria-label="彩名对白便签">
      <header className="floating-heading">
        <div className="floating-drag" onPointerDown={down} onPointerMove={moving} onPointerUp={up} onPointerCancel={up} aria-label="拖动悬浮窗"><i className={`floating-dot ${state.connected ? 'online' : ''}`} /><strong>Ayana</strong><span>陪在你身边</span></div>
        <div className="floating-actions"><button type="button" aria-label="收起悬浮窗" onClick={() => props.onCollapse(true)}><UiIcon name="minimize" size={18}/></button><button type="button" aria-label="返回主界面" onClick={props.onRestore}><UiIcon name="restore" size={17}/></button><button type="button" aria-label="关闭悬浮窗" onClick={props.onClose}><UiIcon name="close" size={18}/></button></div>
      </header>
      <div className="floating-scene"><div className="floating-portrait">{props.portrait}</div>
        <div className="floating-caption-wrap">
        <div className="floating-caption" ref={caption} aria-live={reading ? 'off' : 'polite'} tabIndex={reading ? 0 : undefined} aria-label={reading ? '完整对白' : undefined}>
          {active ? <SpeechLine speech={active} active={!reading} primary={primary} translation={translation} />
            : recent ? <div className="speech-line"><p className="speech-main" lang={languageFor(recentLanguages, primary)}>{main}</p>{secondary && secondary !== main && <p className="speech-secondary" lang={languageFor(recentLanguages, translation)}>{secondary}</p>}</div>
            : <p className="floating-greeting">我在这里。<small>有什么想对我说的吗？</small></p>}
          {replyWaitLabel(state) && !(active?.previewed && active.state === 'generated') && <span className="floating-thinking" role="status">{replyWaitLabel(state)}</span>}
        </div>
        {(overflow || reading) && <button type="button" className="floating-read-more" aria-expanded={reading} onClick={() => { setReading(value => !value); if (caption.current) caption.current.scrollTop = 0; }}>{reading ? '收起全文' : '展开全文'}</button>}
        </div>
      </div>
      {props.notice && <div className="floating-notice" role="status">{props.notice}</div>}
      <form className="floating-composer" onSubmit={event => { event.preventDefault(); props.onSend(); }}>
        <textarea ref={textarea} aria-label="悬浮窗消息" rows={1} maxLength={4000} value={props.text} placeholder={state.connected ? '和彩名说点什么…' : '连接恢复后发送…'} onChange={event => props.onText(event.target.value)}
          onFocus={() => { if (nativeAndroid) void NativeCompanion.focus({ enabled: true }).catch(props.onError); }} onBlur={() => { if (nativeAndroid) void NativeCompanion.focus({ enabled: false }).catch(props.onError); }} />
        {busy && <button type="button" aria-label="打断回复" onClick={props.onCancel}><UiIcon name="stop" size={18}/></button>}
        <button type="submit" aria-label="发送悬浮窗消息" disabled={!state.connected || !props.text.trim() || props.sending}><UiIcon name="send"/></button>
      </form>
      <button type="button" className="floating-resize" aria-label="调整悬浮窗大小" onPointerDown={event => {
        event.currentTarget.setPointerCapture(event.pointerId);
        resizeStart.current = { x: event.screenX, y: event.screenY, width: innerWidth, height: innerHeight };
      }} onPointerMove={event => {
        const start = resizeStart.current;
        if (!start || !nativeAndroid) return;
        void NativeCompanion.resize({ width: start.width + event.screenX - start.x, height: start.height + event.screenY - start.y }).catch(props.onError);
      }} onPointerUp={() => { resizeStart.current = null; }} onPointerCancel={() => { resizeStart.current = null; }}><UiIcon name="resize" size={18}/></button>
    </section>
  </main>;
}
