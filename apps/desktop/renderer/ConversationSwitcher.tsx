import { useEffect, useRef, useState } from 'react';
import { Icon } from './components';
import { bridge, type ModelState } from './state';
import './conversation-switcher.css';

export function ConversationSwitcher({ state, open, onOpenChange, onContinue }: {
  state: ModelState; open: boolean; onOpenChange: (open: boolean) => void; onContinue: () => void;
}) {
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<{ from?: string; request: string; target?: string }>();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const cid = state.conversation?.conversation_id;
  const busy = Boolean(pending);
  function close(restoreFocus = true) {
    onOpenChange(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }
  useEffect(() => {
    if (!open) return;
    setQuery(''); setError('');
    void bridge.send({ type: 'conversations.get' });
    const frame = requestAnimationFrame(() => search.current?.focus({ preventScroll: true }));
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('pointerdown', outside); };
  }, [open]);
  useEffect(() => {
    if (!pending || cid === pending.from || pending.target && cid !== pending.target) return;
    setPending(undefined); close(false); onContinue();
  }, [cid, pending]);
  useEffect(() => {
    if (!pending) return;
    const off = bridge.onEvent(event => {
      if (event.type === 'desktop.reset' || event.type === 'error' && event.request_id === pending.request) {
        setError(event.type === 'desktop.reset' ? '服务已重启，请重试。' : String(event.message || '切换未完成，请重试。'));
        setPending(undefined);
      }
    });
    const timer = setTimeout(() => { setPending(undefined); setError('尚未收到切换结果，请核对当前对话后重试。'); }, 20000);
    return () => { off(); clearTimeout(timer); };
  }, [pending]);
  async function change(target?: string) {
    if (busy || !state.connected) return;
    if (target === cid && target) { close(false); onContinue(); return; }
    const request = crypto.randomUUID();
    setPending({ from: cid, target, request }); setError('');
    try {
      const result = await bridge.send(target
        ? { type: 'conversation.select', conversation_id: target, request_id: request }
        : { type: 'conversation.create', keep_materials: false, request_id: request });
      if (!result.ok) { setPending(undefined); setError(result.error || '本地服务未连接。'); }
    } catch (failure) { setPending(undefined); setError(failure instanceof Error ? failure.message : '切换未完成，请重试。'); }
  }
  const needle = query.trim().toLocaleLowerCase();
  const records = state.conversations.filter(item => `${item.title} ${item.preview || ''}`.toLocaleLowerCase().includes(needle));
  return <div ref={container} className="conversation-switcher" data-companion-interactive>
    <button ref={trigger} className="conversation-switch-trigger" type="button" aria-label="切换对话"
      aria-expanded={open} aria-controls="companion-conversations" aria-haspopup="dialog"
      title={`切换对话 · ${state.conversation?.title || '正在加载'}`} onClick={() => onOpenChange(!open)}>
      <Icon name="message" size={13}/><span>{state.conversation?.title || '对话加载中'}</span>
      <svg className="conversation-switch-chevron" aria-hidden="true" viewBox="0 0 16 16"><path d="m4 6 4 4 4-4"/></svg>
    </button>
    {open && <section className="conversation-switch-panel" id="companion-conversations" role="dialog" aria-label="切换对话" aria-busy={busy}
      onContextMenu={event => event.stopPropagation()} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      }}>
      <div className="conversation-switch-heading"><div><strong>我们的对话</strong><small>{state.persistentHistory ? '记录保存在本机' : '仅本次运行'}</small></div>
        <button type="button" aria-label="关闭对话列表" onClick={() => close()}><Icon name="close" size={15}/></button></div>
      <label className="conversation-switch-search"><Icon name="search" size={14}/>
        <input ref={search} aria-label="查找对话" placeholder="查找标题或最近聊过的事" value={query} maxLength={200} onChange={event => setQuery(event.target.value)}/></label>
      <nav className="conversation-switch-list" aria-label="已有对话">
        {records.map(item => <button type="button" key={item.conversation_id} className="conversation-switch-item"
          aria-current={item.conversation_id === cid ? 'true' : undefined} disabled={busy || !state.connected}
          onClick={() => void change(item.conversation_id)}>
          <div className="conversation-switch-item-heading"><strong>{item.title}</strong><small>{item.conversation_id === cid ? '当前' : new Date(item.updated * 1000).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</small></div>
          <p>{item.preview || '还没有消息，从一句话开始。'}</p>
        </button>)}
        {!records.length && <p className="conversation-switch-empty">{needle ? '没有找到这段对话' : state.connected ? '还没有其他对话' : '连接后可查看对话'}</p>}
      </nav>
      <div className="conversation-switch-footer"><button className="conversation-switch-new" type="button" disabled={busy || !state.connected || !cid} onClick={() => void change()}><Icon name="plus" size={15}/>新的对话</button>
        <span role="status">{busy ? '正在切换…' : !state.connected ? '等待连接' : `${state.conversations.length} 段对话`}</span></div>
      {error && <p className="conversation-switch-error" role="alert">{error}</p>}
    </section>}
  </div>;
}
