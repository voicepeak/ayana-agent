import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Icon, Input } from './components';
import type { ModelState } from './state';

type Send = (command: Record<string, unknown> & { type: string }) => Promise<boolean>;
const statusLabels: Record<string, string> = { generated: '文字已生成', playing: '正在播放', played: '已播放', partial: '已打断', cancelled: '未播放' };
const dateLabel = (seconds: number) => new Date(seconds * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function ConversationControls({ state, send, disabled, children, onHistory }: {
  state: ModelState; send: Send; disabled: boolean; children: ReactNode; onHistory: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [keep, setKeep] = useState(false);
  const [pending, setPending] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const cid = state.conversation?.conversation_id;
  useEffect(() => { setOpen(false); setPending(false); setKeep(false); }, [cid]);
  useEffect(() => { if (state.error) setPending(false); }, [state.error]);
  const blocked = disabled || pending || !state.connected || !cid;
  async function change(command: Record<string, unknown> & { type: string }) {
    setPending(true);
    if (!await send(command)) setPending(false);
  }
  function close() { setOpen(false); trigger.current?.focus(); }
  return <>
    <div className="topic-bar">
      <button ref={trigger} className="topic-trigger" aria-expanded={open} aria-controls="topic-picker" disabled={!cid}
        onClick={() => { setOpen(!open); if (!open) void send({ type: 'conversations.get' }); }}>
        <span className="topic-dot"/><small>正在聊</small><strong>{state.conversation?.title || '话题加载中…'}</strong><span className="topic-chevron">{open ? '⌃' : '⌄'}</span>
      </button>
      <button className="topic-new" aria-label="新建话题" title="开始新话题，保留旧记录" disabled={blocked}
        onClick={() => void change({ type: 'conversation.create', keep_materials: keep })}>＋</button>
    </div>
    {open ? <section className="topic-picker" id="topic-picker" aria-label="切换话题" onKeyDown={event => { if (event.key === 'Escape') close(); }}>
      <div className="topic-picker-heading"><span>接着哪件事聊？</span><small>{state.persistentHistory ? '保存在本机' : '仅本次运行'}</small></div>
      <p className="topic-preview">{state.contextSummary || state.conversation?.preview || '从一句话开始，这里会留下我们的进度。'}</p>
      <div className="topic-recent">
        {state.conversations.slice(0, 5).map(item => <button key={item.conversation_id} disabled={blocked}
          aria-current={item.conversation_id === cid ? 'true' : undefined}
          onClick={() => item.conversation_id === cid ? close() : void change({ type: 'conversation.select', conversation_id: item.conversation_id })}>
          <Icon name="message" size={13}/><span>{item.title}</span><small>{item.conversation_id === cid ? '当前' : dateLabel(item.updated)}</small>
        </button>)}
      </div>
      <div className="topic-picker-footer">
        <label><input type="checkbox" checked={keep} onChange={event => setKeep(event.target.checked)}/>新话题沿用当前材料</label>
        <button onClick={() => { close(); onHistory(); }}>全部话题与记录 <Icon name="arrow" size={12}/></button>
      </div>
    </section> : children}
    {state.contextState === 'compacting' && <p className="topic-working" role="status">正在整理较早的对话，保留重点…</p>}
  </>;
}

export function ConversationHistory({ state, send }: { state: ModelState; send: Send }) {
  const [filter, setFilter] = useState('');
  const [title, setTitle] = useState(state.conversation?.title || '');
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const cid = state.conversation?.conversation_id;
  useEffect(() => { setTitle(state.conversation?.title || ''); setPending(false); }, [cid, state.conversation?.title]);
  useEffect(() => { setLoading(false); }, [state.history, state.error]);
  useEffect(() => { if (state.error) setPending(false); }, [state.error]);
  const blocked = pending || !state.connected || !cid;
  async function change(command: Record<string, unknown> & { type: string }) {
    setPending(true);
    if (!await send(command)) setPending(false);
  }
  return <section className="conversation-workspace">
    <div className="conversation-section-heading"><span className="conversation-note">{state.persistentHistory ? '保存在本机' : '仅本次运行'}</span><Button color="primary" disabled={blocked} onClick={() => void change({ type: 'conversation.create', keep_materials: false })}>＋ 新话题</Button></div>
    <Input aria-label="搜索话题" placeholder="找一个之前的话题…" value={filter} onChange={event => setFilter(event.target.value)}/>
    <div className="conversation-list" aria-label="全部话题">
      {state.conversations.filter(item => `${item.title} ${item.preview}`.toLowerCase().includes(filter.toLowerCase())).map(item =>
        <button key={item.conversation_id} className={item.conversation_id === cid ? 'selected' : ''} disabled={blocked}
          aria-current={item.conversation_id === cid ? 'true' : undefined}
          onClick={() => { if (item.conversation_id !== cid) void change({ type: 'conversation.select', conversation_id: item.conversation_id }); }}>
          <div><strong>{item.title}</strong><small>{dateLabel(item.updated)}{item.conversation_id === cid ? ' · 当前话题' : ''}</small></div><p>{item.preview || '还没有开始对话'}</p>
        </button>)}
      {!state.conversations.some(item => `${item.title} ${item.preview}`.toLowerCase().includes(filter.toLowerCase())) && <p className="conversation-note">没有匹配的话题。</p>}
    </div>
    <form className="conversation-rename" onSubmit={event => { event.preventDefault(); void send({ type: 'conversation.rename', title }); }}>
      <Input value={title} maxLength={60} aria-label="当前话题名称" onChange={event => setTitle(event.target.value)}/>
      <Button type="submit" disabled={blocked || !title.trim() || title.trim() === state.conversation?.title}>保存名称</Button>
    </form>
    {(state.target || state.repository || state.contextSummary) && <details className="conversation-context"><summary>话题上下文</summary>
      {(state.target || state.repository) && <div className="conversation-context-heading"><span>{state.target?.title || '有已绑定材料'}</span><Button variant="light" disabled={blocked} onClick={() => void send({ type: 'conversation.materials.clear' })}>解除绑定</Button></div>}
      {state.contextSummary && <p>{state.contextSummary}</p>}
    </details>}
    <div className="conversation-transcript-heading"><h3>完整对话记录</h3><Button variant="light" disabled={blocked || loading} onClick={() => { setLoading(true); void send({ type: 'history.get' }).then(ok => { if (!ok) setLoading(false); }); }}>刷新</Button></div>
    {state.historyHasMore && <Button className="conversation-load" disabled={blocked || loading} onClick={() => { setLoading(true); void send({ type: 'history.get', before: state.historyBefore }).then(ok => { if (!ok) setLoading(false); }); }}>{loading ? '正在读取…' : '加载更早的记录'}</Button>}
    {!state.history.length && <p className="conversation-empty">这个话题还没有对话。呼出 Ayana，开始聊吧。</p>}
    <div className="conversation-transcript">{state.history.map(item => <article className={`conversation-message ${item.role === 'user' ? 'from-user' : 'from-ayana'}`} key={String(item.id)}>
      <header><strong>{item.role === 'user' ? '你' : 'Ayana'}</strong><small>{dateLabel(Number(item.created))}</small>
        {item.role !== 'user' && <span>{item.displayed && item.status === 'generated' ? '已显示文字' : statusLabels[String(item.status)] || String(item.status)}</span>}</header>
      <p>{String(item.role === 'user' ? item.text : item.display_zh || item.speech_ja || '')}</p>
      {item.role !== 'user' && Boolean(item.display_zh) && <small lang="ja">{String(item.speech_ja)}</small>}
    </article>)}</div>
  </section>;
}
