import { useEffect, useRef, useState } from 'react';
import { Button, Icon, Input } from './components';
import type { ModelState, PersonalMemory } from './state';
import { bridge } from './state';
import { commandReceipt } from './commandReceipt';
import { savePreferences } from './preferences';

type Send = (command: Record<string, unknown> & { type: string }) => Promise<boolean>;
const date = (value: number, day = false) => new Date(value * 1000).toLocaleString('zh-CN', day
  ? { year: 'numeric', month: 'long', day: 'numeric' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const localDay = (value: string, next = false) => {
  if (!value) return undefined;
  const result = new Date(`${value}T00:00:00`);
  if (next) result.setDate(result.getDate() + 1);
  return result.getTime() / 1000;
};

function Match({ text, query }: { text: string; query: string }) {
  const at = query ? text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : -1;
  return at < 0 ? <>{text}</> : <>{text.slice(0, at)}<mark>{text.slice(at, at + query.length)}</mark>{text.slice(at + query.length)}</>;
}

export function ConversationManager({ state, send }: { state: ModelState; send: Send }) {
  const [tab, setTab] = useState<'records' | 'memory'>('records');
  const [selected, setSelected] = useState(state.conversation?.conversation_id);
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [resume, setResume] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [exportRequest, setExportRequest] = useState('');
  const anchorRequest = useRef<number | undefined>(undefined);
  const reviewRequest = useRef('');
  const searchRequest = useRef('');
  const [highlight, setHighlight] = useState<number>();
  const record = state.conversations.find(item => item.conversation_id === selected);
  const reviewing = Boolean(state.review && state.review.review_id === selected && state.review.request_id === reviewRequest.current);
  const searching = searched && state.searchResults?.request_id !== searchRequest.current;
  const items = reviewing ? state.review!.items : [];

  useEffect(() => { if (state.connected) void send({ type: 'conversations.get' }); }, [state.connected]);
  useEffect(() => {
    if (!selected || !state.conversations.some(item => item.conversation_id === selected)) setSelected(state.conversation?.conversation_id);
  }, [state.conversations, state.conversation?.conversation_id, selected]);
  useEffect(() => {
    setTitle(record?.title || ''); setConfirmDelete(false); setBusy(false);
    setExportRequest('');
    if (selected && state.connected) {
      const anchor = anchorRequest.current;
      anchorRequest.current = undefined;
      loadReview(selected, anchor ? anchor + 1 : undefined, anchor);
    }
  }, [selected, state.connected]);
  useEffect(() => { setTitle(record?.title || ''); }, [record?.title]);
  useEffect(() => {
    if (creating && state.conversation?.conversation_id !== selected) {
      setSelected(state.conversation?.conversation_id); setCreating(false);
    }
  }, [creating, state.conversation?.conversation_id]);
  useEffect(() => { if (state.error) setBusy(false); }, [state.error]);
  useEffect(() => {
    if (resume && state.conversation?.conversation_id === resume) {
      setResume(undefined); void bridge.summon();
    }
  }, [resume, state.conversation?.conversation_id]);
  useEffect(() => {
    if (reviewing && highlight) document.getElementById(`record-${highlight}`)?.scrollIntoView({ block: 'center' });
  }, [reviewing, highlight, state.review]);

  function loadReview(cid: string, before?: number, anchor?: number) {
    reviewRequest.current = crypto.randomUUID();
    if (anchor) setHighlight(anchor);
    else if (!before) setHighlight(undefined);
    void send({ type: 'conversation.history', conversation_id: cid, before, prepend: Boolean(before && !anchor), request_id: reviewRequest.current });
  }
  function search(before?: number) {
    if (!before) searchRequest.current = crypto.randomUUID();
    setSearched(true);
    void send({ type: 'conversation.search', query: query.trim(), start: localDay(start), end: localDay(end, true),
      before, request_id: searchRequest.current });
  }
  function choose(cid: string, anchor?: number) {
    if (cid !== selected) anchorRequest.current = anchor;
    setSelected(cid); setTab('records'); setHighlight(anchor);
    if (cid === selected) loadReview(cid, anchor ? anchor + 1 : undefined, anchor);
  }
  async function continueChat() {
    if (!selected) return;
    if (selected === state.conversation?.conversation_id) { void bridge.summon(); return; }
    setResume(selected);
    if (!await send({ type: 'conversation.select', conversation_id: selected })) setResume(undefined);
  }
  async function remove() {
    setBusy(true);
    if (!await send({ type: 'conversation.delete', conversation_id: selected })) setBusy(false);
  }
  function exportChat(format: string) {
    const request = crypto.randomUUID(); setExportRequest(request);
    void send({ type: 'conversation.export', conversation_id: selected, format, request_id: request });
  }

  return <section className="conversation-manager" aria-label="对话与记忆管理">
    <div className="manager-intro"><div><span className="manager-eyebrow">彩名 · 留在本机</span><h2>留下来的话</h2>
      <p>平时接着聊，需要时回来翻一翻。</p></div><span className="manager-storage">{state.persistentHistory ? '记录自动保存' : '仅本次运行'}</span></div>
    <div className="manager-tabs" role="tablist" aria-label="管理内容">
      <button role="tab" aria-selected={tab === 'records'} onClick={() => setTab('records')}>对话记录 <span>{state.conversations.length}</span></button>
      <button role="tab" aria-selected={tab === 'memory'} onClick={() => setTab('memory')}>彩名记住的事 <span>{state.memories.length}</span></button>
    </div>
    {tab === 'memory' ? <MemoryPanel state={state} send={send} onSource={choose}/> : <>
      <form className="manager-search" onSubmit={event => { event.preventDefault(); search(); }}>
        <div className="manager-search-line"><Icon name="search" size={16}/><Input aria-label="搜索对话内容" placeholder="找一句话、一个名字，或之前聊过的事…" maxLength={200} value={query} onChange={event => setQuery(event.target.value)}/>
          <Button type="submit" disabled={!state.connected}>搜索</Button>{searched && <Button type="button" variant="light" onClick={() => { setSearched(false); setQuery(''); setStart(''); setEnd(''); }}>清除</Button>}</div>
        <details><summary>按日期查找</summary><div className="manager-date-range"><label>从<Input type="date" aria-label="开始日期" value={start} onChange={event => setStart(event.target.value)}/></label>
          <label>到<Input type="date" aria-label="结束日期" min={start || undefined} value={end} onChange={event => setEnd(event.target.value)}/></label></div></details>
      </form>
      <div className="manager-grid"><aside className="manager-index" aria-label={searched ? '搜索结果' : '对话列表'}>
        <div className="manager-index-heading"><span>{searched ? '找到的记录' : '最近的对话'}</span><Button variant="light" disabled={!state.connected || creating} aria-label="开始新的对话" onClick={async () => {
          setResume(undefined); setCreating(true); setSearched(false);
          if (!await send({ type: 'conversation.create', keep_materials: false })) setCreating(false);
        }}><Icon name="plus" size={14}/></Button></div>
        {searching ? <p className="manager-empty" role="status">正在查找…</p> : searched ? <>
          {state.searchResults?.items.map(item => <button className="manager-search-hit" key={Number(item.id)} onClick={() => choose(String(item.conversation_id), Number(item.id))}>
            <small>{String(item.title)} · {date(Number(item.created))}</small><p><Match text={String(item.text)} query={query.trim()}/></p></button>)}
          {!state.searchResults?.items.length && <p className="manager-empty">没有找到记录。试试别的词或日期。</p>}
          {state.searchResults?.has_more && <Button variant="light" onClick={() => search(state.searchResults?.before)}>更多结果</Button>}
        </> : state.conversations.map(item => <button className={`manager-topic ${item.conversation_id === selected ? 'selected' : ''}`} key={item.conversation_id} onClick={() => choose(item.conversation_id)} aria-pressed={item.conversation_id === selected}>
          <small>{date(item.updated)}{item.conversation_id === state.conversation?.conversation_id && <em>正在聊</em>}</small><strong>{item.title}</strong><p>{item.preview || '从下一句话开始。'}</p></button>)}
      </aside>
      <div className="manager-reader" aria-label="对话详情">
        {record ? <>
          <div className="manager-reader-heading"><div><small>{date(record.created, true)}</small><h3>{record.title}</h3></div><Button color="primary" disabled={!state.connected || Boolean(resume)} onClick={() => void continueChat()}>接着聊 <Icon name="arrow" size={14}/></Button></div>
          <div className="manager-record-actions"><details><summary>整理这段对话</summary><form className="manager-rename" onSubmit={async event => {
            event.preventDefault(); await send({ type: 'conversation.rename', conversation_id: selected, title });
          }}><Input aria-label="对话名称" value={title} maxLength={60} onChange={event => setTitle(event.target.value)}/><Button type="submit" disabled={!title.trim() || title.trim() === record.title}>改名</Button></form></details>
            <Button variant="light" disabled={!state.connected} onClick={() => exportChat('markdown')}>导出文字</Button>
            <Button variant="light" disabled={!state.connected} onClick={() => exportChat('json')}>导出 JSON</Button>
            <Button variant="light" className="manager-danger" onClick={() => setConfirmDelete(true)}>删除</Button></div>
          {exportRequest && state.exportRequest === exportRequest && <p className="manager-export" role="status">已导出到本机，文件位置已打开。</p>}
          {confirmDelete && <div className="manager-delete-confirm" role="alertdialog" aria-label="确认删除对话"><strong>删除「{record.title}」？</strong><p>这段记录和从中自动记住的内容会被删除。已经生成的文件保留。</p><div>
            <Button variant="light" disabled={busy} onClick={() => setConfirmDelete(false)}>保留</Button><Button color="danger" disabled={busy || !state.connected} onClick={() => void remove()}>{busy ? '正在删除…' : '确认删除'}</Button></div></div>}
          {!reviewing ? <p className="manager-empty" role="status">正在读取…</p> : <>
            <div className="manager-page-actions">{state.review?.has_more && <Button variant="light" onClick={() => loadReview(selected!, state.review?.before)}>更早的记录</Button>}
              {highlight && <Button variant="light" onClick={() => loadReview(selected!)}>回到最近记录</Button>}</div>
            {!items.length && <div className="manager-empty"><Icon name="message" size={26}/><p>这段对话还没有记录。</p></div>}
            <div className="manager-transcript">{items.map((item, index) => {
              const day = date(Number(item.created), true);
              return <div key={Number(item.id)}>{(index === 0 || day !== date(Number(items[index - 1].created), true)) && <div className="manager-day">{day}</div>}
                <article id={`record-${item.id}`} className={`manager-message ${item.role === 'user' ? 'from-user' : 'from-ayana'} ${Number(item.id) === highlight ? 'is-found' : ''}`}>
                  <header><strong>{item.role === 'user' ? '你' : '彩名'}</strong><time>{new Date(Number(item.created) * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
                    {item.role !== 'user' && ['partial', 'cancelled'].includes(String(item.status)) && <small>{item.status === 'partial' ? '播放被打断' : '未播放'}</small>}</header>
                  <p><Match text={String(item.text || item.display_zh || item.speech_ja || '')} query={searched ? query.trim() : ''}/></p>
                  {Boolean(item.display_zh && item.speech_ja) && <details><summary>日语原文</summary><p lang="ja">{String(item.speech_ja)}</p></details>}
                </article></div>;
            })}</div>
          </>}
        </> : <p className="manager-empty">选择一段对话。</p>}
      </div></div>
    </>}
  </section>;
}

function MemoryPanel({ state, send, onSource }: { state: ModelState; send: Send; onSource: (cid: string, anchor?: number) => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function toggle(enabled: boolean) {
    setSaving(true); setError('');
    try { await savePreferences({ remember_user: enabled }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '记忆设置未保存。'); }
    finally { setSaving(false); }
  }
  return <section className="manager-memory" aria-label="个人记忆">
    <div className="memory-intro"><h3>熟悉，是一点点记住的。</h3><p>从你明确说过的话里，留下长期有用的事实与偏好。换一段对话，也能带着这些记忆。</p>
      <label className="memory-toggle"><input type="checkbox" checked={state.settings.remember_user !== false} disabled={!state.connected || !state.persistentHistory || saving} onChange={event => void toggle(event.target.checked)}/>自动记住我说过的重要事情</label>
      {error && <p className="manager-danger" role="alert">{error}</p>}
      {!state.persistentHistory && <p>开启本机历史保存后，才能自动整理记忆。</p>}
      {state.memoryState === 'learning' && <small role="status">正在整理最近的对话，你可以继续聊天。</small>}
      {state.memoryState === 'failed' && <small role="status">这次整理暂时不可用，已有记忆仍然保留。</small>}
    </div>
    {!state.memories.length ? <div className="memory-empty"><Icon name="sparkles" size={30}/><h4>还没有留下长期记忆</h4><p>照常聊天就好。彩名会在后台整理，记住的内容会出现在这里。</p></div>
      : <div className="memory-list">{state.memories.map(memory => <MemoryEntry key={memory.memory_id} memory={memory} connected={state.connected} send={send} onSource={onSource}/>)}</div>}
    <p className="memory-footnote">你修改的内容优先保留。忘记一条记忆后，原对话记录仍可查看。</p>
  </section>;
}

function MemoryEntry({ memory, connected, send, onSource }: { memory: PersonalMemory; connected: boolean; send: Send; onSource: (cid: string, anchor?: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [content, setContent] = useState(memory.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function change(type: 'memory.update' | 'memory.forget') {
    setBusy(true); setError('');
    try { await commandReceipt({ type, memory_id: memory.memory_id, ...(type === 'memory.update' ? { content } : {}) }, 'memory.ready'); setEditing(false); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '记忆未保存，请重试。'); }
    finally { setBusy(false); }
  }
  useEffect(() => { setContent(memory.content); setEditing(false); }, [memory.content]);
  return <article className="memory-entry" data-memory-id={memory.memory_id}>
    <header><span>{memory.edited ? '你确认过的记忆' : '来自你的话'}</span><small>{date(memory.updated)}</small></header>
    {editing ? <form onSubmit={event => { event.preventDefault(); void change('memory.update'); }}>
      <textarea aria-label="修改记忆" maxLength={240} value={content} onChange={event => setContent(event.target.value)}/><div><Button type="button" variant="light" disabled={busy} onClick={() => { setEditing(false); setContent(memory.content); }}>取消</Button><Button type="submit" color="primary" disabled={busy || !connected || !content.trim()}>{busy ? '正在保存…' : '保存记忆'}</Button></div></form> : <p>{memory.content}</p>}
    {error && <p className="manager-danger" role="alert">{error}</p>}
    {memory.source && <details><summary>为什么记住这件事</summary><blockquote>{memory.source.quote}</blockquote><button className="memory-source" onClick={() => onSource(memory.source!.conversation_id, memory.source!.id)}>查看这句话 <Icon name="arrow" size={12}/></button></details>}
    <footer>{forgetting ? <><span>忘记这条记忆？</span><Button variant="light" disabled={busy} onClick={() => setForgetting(false)}>保留</Button><Button color="danger" disabled={busy || !connected} onClick={() => void change('memory.forget')}>{busy ? '正在忘记…' : '确认忘记'}</Button></> : <>
      <Button variant="light" disabled={!connected} onClick={() => setEditing(true)}>修改</Button><Button variant="light" disabled={!connected} onClick={() => setForgetting(true)}>忘记</Button></>}</footer>
  </article>;
}
