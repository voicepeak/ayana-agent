import type { ComponentProps, CSSProperties, ReactNode, Ref } from 'react';
import { Icon } from './components';
import { ConversationSwitcher } from './ConversationSwitcher';
import { SourceLinks } from './SourceLinks';
import { designTone, type CompanionDesign } from './CompanionDesign';
import type { ModelState } from './state';
import type { CaptureState } from './holdRecorder';

export interface ComposerProps {
  text: string; textarea?: Ref<HTMLTextAreaElement>;
  onChange: (text: string) => void; onSubmit: () => void; onFocus?: () => void;
  onBlur?: ComponentProps<'form'>['onBlur'];
  onTalkPress: () => void; onTalkRelease: (cancelled?: boolean) => void;
  talkStatus: CaptureState;
}
export function captureLabel(status: CaptureState) {
  return status === 'preparing' ? '正在打开麦克风…' : status === 'recording' ? '正在听 · 松开结束' : status === 'transcribing' ? '正在识别…' : '';
}
/** The production frame, toolbar, input and sources. Tours provide inert data only. */
export function CompanionSurface({ state, design, style, surfaceRef, designOpen = false, portraitEditing = false, conversationsOpen = false,
  onConversations = () => {}, onComposer = () => {}, onDesign = () => {}, onMenu = () => {}, onHide = () => {}, composer, children, extras, passive = false, speaking = false, tone, backgroundRevision = 0,
}: {
  state: ModelState; design: CompanionDesign; style: CSSProperties; surfaceRef?: Ref<HTMLElement>;
  designOpen?: boolean; portraitEditing?: boolean; conversationsOpen?: boolean;
  onConversations?: (open: boolean) => void; onComposer?: () => void; onDesign?: () => void; onMenu?: () => void; onHide?: () => void;
  composer: ComposerProps; children: ReactNode; extras?: ReactNode; passive?: boolean;
  speaking?: boolean; tone?: 'light' | 'dark'; backgroundRevision?: number;
}) {
  return <main ref={surfaceRef} className="companion-shell companion-framed" data-design-open={designOpen} data-portrait-editing={portraitEditing} style={style}
    onContextMenu={event => { event.preventDefault(); if (!passive) onMenu(); }}>
    <section className="companion-frame companion-note is-visible" data-theme={design.theme} data-tone={tone || designTone(design)} data-bubbles={design.show_bubbles} data-background={design.background_mode} data-speaking={speaking} data-portrait-side={design.portrait_side} aria-label="彩名便签" data-companion-interactive>
      {['minimal', 'solid'].includes(design.background_mode) && <div className="note-surface" aria-hidden="true"/>}
      {design.background_mode === 'image' && <div className="note-background-image" aria-hidden="true"><img alt="" src={`ayana-background://custom/?image=${design.background_image}&v=${backgroundRevision}`} style={{ objectPosition: `${design.background_x}% ${design.background_y}%`, transform: `scale(${design.background_zoom / 100})`, transformOrigin: `${design.background_x}% ${design.background_y}%` }}/></div>}
      <header className="companion-frame-heading" title="拖动标题栏移动窗口"><div className="companion-heading-start"><div className="companion-signature"><strong>彩名</strong></div>
        <button className="companion-appearance-button" type="button" aria-label="打开设计控件" aria-expanded={designOpen} title="调整外观" onClick={onDesign}><Icon name="settings" size={14}/></button>
        <ConversationSwitcher state={state} open={conversationsOpen} onOpenChange={onConversations} onContinue={onComposer}/>
      </div><span className="companion-title-drag-area" aria-hidden="true"/><div className="companion-frame-actions">
        {state.attentionObserving && <span className="attention-status" role="status">正在看看屏幕</span>}
        <button type="button" aria-label="更多操作" title="话题与设置" onClick={onMenu}>···</button>
        <button type="button" aria-label="隐藏彩名" title="隐藏彩名" onClick={onHide}><Icon name="close" size={14}/></button>
      </div></header>
      {children}
      <SourceLinks key={state.conversation?.conversation_id || 'initial'} sources={state.sources} passive={passive}/>
      <form className="floating-input" data-companion-interactive onSubmit={event => { event.preventDefault(); composer.onSubmit(); }} onBlur={composer.onBlur}>
        <textarea ref={composer.textarea} value={composer.text} maxLength={4000} rows={1} onFocus={composer.onFocus} onChange={event => composer.onChange(event.target.value)} placeholder="写下一句话…" aria-label="输入问题"
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); composer.onSubmit(); } }}/>
        <button type="button" className="hold-talk" aria-label="按住说话" title={`按住说话 · ${String(state.settings.talk_hotkey || 'Ctrl+Shift+Space').replace('CommandOrControl', 'Ctrl')}`} data-recording={composer.talkStatus === 'recording'} disabled={!state.connected || composer.talkStatus === 'transcribing'}
          onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); composer.onTalkPress(); }} onPointerUp={() => composer.onTalkRelease()} onPointerCancel={() => composer.onTalkRelease(true)} onLostPointerCapture={() => composer.onTalkRelease()}><Icon name="mic" size={17}/></button>
        <button type="submit" aria-label="发送" title="发送 · Enter" disabled={!composer.text.trim() || !state.connected || ['recording', 'transcribing'].includes(composer.talkStatus)}><Icon name="arrow" size={19}/></button>
      </form>
      <div className="hold-talk-status" data-state={composer.talkStatus} role="status">{captureLabel(composer.talkStatus)}</div>
    </section>
    {extras}
  </main>;
}
