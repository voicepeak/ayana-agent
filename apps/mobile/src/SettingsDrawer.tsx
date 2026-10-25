import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { costumes } from './character';
import { serverLabel } from './api';
import type { MobileState } from './state';
import type { CSSProperties } from 'react';
import type { useCompanion } from './useCompanion';
import { nativeAndroid, nativeIOS } from './companionNative';
import { UiIcon } from './UiIcon';

export const themes = [
  { id: 'ink', name: '夜墨', background: '#25282d', bubble: '#30343d' },
  { id: 'paper', name: '茶白', background: '#e6dfd0', bubble: '#faf3e5' },
  { id: 'forest', name: '苔绿', background: '#293831', bubble: '#dbe8db' },
  { id: 'sea', name: '雾蓝', background: '#1c3042', bubble: '#dce6ed' },
  { id: 'sakura', name: '樱夜', background: '#3a2430', bubble: '#f4d9e4' },
  { id: 'sky', name: '晴空', background: '#dceaf2', bubble: '#f7fcff' },
  { id: 'amber', name: '琥珀', background: '#3b2b1f', bubble: '#f3e2c9' },
  { id: 'bamboo', name: '竹月', background: '#23302c', bubble: '#d9ebe2' },
];
type Command = Record<string, unknown> & { type: string };
interface Props {
  state: MobileState;
  memoryText: string;
  version: string;
  onClose(): void;
  onCommand(command: Command): Promise<boolean>;
  onConversation(id?: string): Promise<void>;
  onCancel(): void;
  onReconnect(): void;
  onSignOut(): Promise<void>;
  onExport(): Promise<unknown>;
  companion: ReturnType<typeof useCompanion>;
  onCompanion(): void;
}
export function SettingsDrawer(props: Props) {
  const { state, onCommand, onClose } = props;
  const [name, setName] = useState(String(state.settings.user_name || ''));
  const [memory, setMemory] = useState(props.memoryText);
  const [search, setSearch] = useState('');
  const [rename, setRename] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [working, setWorking] = useState(false);
  const [exportError, setExportError] = useState('');
  const dirty = useRef({ name: false, memory: false });
  const fields = useRef({ name, memory });
  fields.current = { name, memory };
  const latest = useRef(props);
  latest.current = props;
  const dialog = useRef<HTMLElement>(null);
  const flush = async () => {
    const value = fields.current;
    if (dirty.current.name) {
      const ok = await latest.current.onCommand({ type: 'settings.update', settings: { user_name: value.name.trim() } });
      if (ok && value.name === fields.current.name) dirty.current.name = false;
    }
    if (dirty.current.memory) {
      const ok = await latest.current.onCommand({ type: 'memory.set', text: value.memory });
      if (ok && value.memory === fields.current.memory) dirty.current.memory = false;
    }
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    if (!dirty.current.name) setName(String(state.settings.user_name || ''));
    if (!dirty.current.memory) setMemory(props.memoryText);
  }, [state.settings.user_name, props.memoryText]);
  useEffect(() => {
    const timer = window.setTimeout(() => void flushRef.current(), 600);
    return () => window.clearTimeout(timer);
  }, [name, memory]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>('[aria-label="关闭"]')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); latest.current.onClose(); }
      if (event.key !== 'Tab') return;
      const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, textarea, a[href]') || [])]
        .filter(element => element.getClientRects().length);
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    const native = Capacitor.isNativePlatform() ? import('@capacitor/app').then(({ App }) => App.addListener('backButton', () => latest.current.onClose())) : undefined;
    return () => {
      void flushRef.current();
      document.removeEventListener('keydown', keydown);
      previous?.focus({ preventScroll: true });
      void native?.then(listener => listener.remove());
    };
  }, []);
  const update = (settings: Record<string, unknown>) => onCommand({ type: 'settings.update', settings });
  const ui = state.settings.companion_ui || {};
  const theme = String(ui.theme || 'ink');
  const conversations = state.conversations.filter(item => `${item.title} ${item.preview || ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    .sort((a, b) => Number(b.updated || 0) - Number(a.updated || 0));
  const run = async (action: () => Promise<unknown>) => {
    if (working) return;
    setWorking(true);
    try { await flush(); await action(); }
    finally { setWorking(false); }
  };
  const exportTopic = async () => {
    setExportError('');
    try {
      const result = await props.onExport();
      const file = new File([JSON.stringify(result, null, 2)], `Ayana-${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' });
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: 'Ayana 话题' });
      else {
        const url = URL.createObjectURL(file);
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.name;
        document.body.append(anchor); anchor.click(); anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 30000);
      }
    } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) setExportError('导出失败，请使用浏览器版导出话题。'); }
  };
  return <div className="drawer-backdrop" onClick={onClose}>
    <aside id="mobile-drawer" ref={dialog} className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" onClick={event => event.stopPropagation()}>
      <header><div><span className="eyebrow">你的空间</span><strong id="drawer-title">与彩名的日常</strong></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭"><UiIcon name="close"/></button></header>
      <div className="drawer-scroll">
        <div className="drawer-status"><span><i className={`status-dot ${state.connected ? 'is-on' : ''}`} />{state.connected ? '服务已连接' : '服务暂未连接'}</span><span>v{props.version}</span></div>
        <section><div className="section-heading"><h2>我的话题</h2><span>{state.conversations.length}</span></div>
          <input className="topic-search" type="search" aria-label="搜索话题" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索话题…" />
          <div className="conversation-list">{conversations.map(item => <button key={item.conversation_id} type="button" disabled={working} className={item.conversation_id === state.conversation?.conversation_id ? 'is-current' : ''} aria-current={item.conversation_id === state.conversation?.conversation_id ? 'true' : undefined} onClick={() => void run(() => props.onConversation(item.conversation_id))}><strong>{item.title}</strong><small>{item.preview || '故事从这里开始'}</small></button>)}{!conversations.length && <p className="field-hint">没有找到这个话题</p>}</div>
          <button className="new-conversation" type="button" disabled={working} onClick={() => void run(() => props.onConversation())}>＋ 新的对话</button>
          <form className="topic-tools" onSubmit={event => { event.preventDefault(); void run(async () => { if (await onCommand({ type: 'conversation.rename', conversation_id: state.conversation?.conversation_id, title: rename })) setRename(''); }); }}><input aria-label="重命名当前话题" value={rename} maxLength={60} onChange={event => setRename(event.target.value)} placeholder="给当前话题起个名字" /><button type="submit" disabled={!rename.trim() || working}>改名</button></form>
          <div className="topic-buttons"><button type="button" onClick={() => void exportTopic()}>导出话题</button><button type="button" className="danger-link" onClick={() => setDeleting(value => !value)}>删除话题</button></div>
          {exportError && <p className="field-hint" role="alert">{exportError}</p>}
          {deleting && <div className="delete-confirm"><p>删除「{state.conversation?.title}」及其本地消息？此操作无法撤销。</p><button type="button" onClick={() => setDeleting(false)}>保留</button><button className="danger-link" type="button" disabled={working} onClick={() => void run(async () => { if (await onCommand({ type: 'conversation.delete', conversation_id: state.conversation?.conversation_id })) setDeleting(false); })}>确认删除</button></div>}
        </section>
        <section className="drawer-actions"><h2>外观与陪伴</h2>
          <div className="field-row"><div className="identity-field"><span>角色</span><output aria-label="角色">彩名 · 黑制服</output></div><label>服装<select value={state.costume} onChange={event => { props.onCancel(); void update({ avatar_costume: event.target.value }); }}>{costumes().map(item => <option key={item}>{item}</option>)}</select></label></div>
          <label>称呼<input value={name} maxLength={32} onChange={event => { dirty.current.name = true; setName(event.target.value); }} onBlur={() => void flush()} placeholder="希望彩名称呼你的名字" /></label>
          <fieldset className="theme-picker"><legend>心情底色</legend><div>{themes.map(item => <button key={item.id} type="button" aria-label={`主题：${item.name}`} aria-pressed={theme === item.id} style={{ '--swatch': item.background, '--swatch-accent': item.bubble } as CSSProperties} onClick={() => void update({ companion_ui: { theme: item.id, background_color: '', bubble_color: '' } })}><i /><span>{item.name}</span></button>)}</div></fieldset>
          <label className="switch-field"><span>语音回复<small>关闭后按阅读节奏显示文字</small></span><input type="checkbox" role="switch" checked={state.settings.voice?.voice_mode !== 'silent'} onChange={event => { props.onCancel(); void update({ voice: { voice_mode: event.target.checked ? 'auto' : 'silent' } }); }} /></label>
          <label>音量 <span className="range-value">{Math.round(Number(state.settings.volume ?? 1) * 100)}%</span><input aria-label="音量" type="range" min="0" max="1" step="0.05" value={Number(state.settings.volume ?? 1)} onChange={event => void update({ volume: Number(event.target.value) })} /></label>
          <div className="field-row"><label>对白语言<select aria-label="对白语言" value={String(ui.primary_language || 'ja')} onChange={event => void update({ companion_ui: { primary_language: event.target.value } })}><option value="zh">中文</option><option value="ja">日语</option><option value="en">英语</option></select></label><label>翻译语言<select aria-label="翻译语言" value={String(ui.translation_language || 'zh')} onChange={event => void update({ companion_ui: { translation_language: event.target.value } })}><option value="none">不显示</option><option value="ja">日语</option><option value="zh">中文</option><option value="en">英语</option></select></label></div>
          <p className="field-hint">英语译文暂缺时，将显示已有的中文或日文。</p>
        </section>
        <section className="drawer-actions"><h2>记住关于你的事</h2><label>本机记忆（每行一条）<textarea rows={4} maxLength={15000} value={memory} onChange={event => { dirty.current.memory = true; setMemory(event.target.value); }} onBlur={() => void flush()} placeholder="例如：喜欢安静的咖啡店" /></label><p className="field-hint">自动保存，最多 50 条，每条 300 字。也可以对彩名说「记住：…」。</p></section>
        <section className="drawer-actions"><h2>连接与资料</h2><button type="button" onClick={() => { props.onReconnect(); onClose(); }}>重新连接</button><button type="button" disabled={working} onClick={() => void run(props.onSignOut)}>退出激活（保留本地历史）</button><p className="drawer-hint">语音状态：{state.voice === 'ready' ? '可用' : state.voice === 'failed' ? '暂不可用，文字仍可使用' : '等待服务'}<br />服务器：{serverLabel()}<br />历史保存在这台设备，卸载应用前请导出需要的话题。</p></section>
        <section className="drawer-actions"><h2>随身陪伴</h2>
          <p className="field-hint">{nativeAndroid ? '像电脑端一样，把立绘与对白便签留在其他应用上方。首次开启需允许悬浮窗权限。' : nativeIOS ? '通过系统画中画继续看立绘、字幕和听语音，返回 Ayana 可继续输入。' : '预览电脑端风格的立绘便签。跨应用悬浮窗和画中画需使用原生安装包。'}</p>
          <button type="button" disabled={props.companion.working || (nativeIOS && !props.companion.status.pip)} onClick={props.companion.status.active && nativeIOS ? () => void props.companion.stop(true) : props.onCompanion}>
            {props.companion.working ? '正在打开…' : nativeAndroid ? '开启悬浮陪伴' : nativeIOS ? props.companion.status.active ? '关闭画中画' : '开启画中画' : '预览悬浮便签'}</button>
        </section>
      </div>
    </aside>
  </div>;
}
