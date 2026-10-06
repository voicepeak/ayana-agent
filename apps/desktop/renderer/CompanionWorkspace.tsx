import { useEffect, useMemo, useRef, useState } from 'react';
import { CinematicDialogue } from './CinematicDialogue';
import type { ModelState, Speech } from './state';
import { bridge } from './state';

export function CompanionWorkspace({ state, speech, textOnly, show, showJapanese, onVisibilityChange }: {
  state: ModelState; speech?: Speech; textOnly: boolean; show: boolean; showJapanese: boolean; onVisibilityChange: (visible: boolean) => void;
}) {
  const [contextOpen, setContextOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const cid = state.conversation?.conversation_id;
  useEffect(() => { setContextOpen(false); follow.current = true; }, [cid]);
  useEffect(() => { if (state.connected && cid) void bridge.send({ type: 'history.get' }); }, [cid, state.connected]);
  useEffect(() => { setLoading(false); }, [state.history, state.error]);
  const entries = useMemo(() => {
    const result = state.history.map(item => ({ id: String(item.id), order: Number(item.id), role: String(item.role), text: String(item.role === 'user' ? item.text : item.display_zh || item.speech_ja || ''),
      utterance: String(item.utterance_id || ''), turn: String(item.turn_id || ''), status: String(item.status || '') }));
    for (const question of state.questions) if (!result.some(item => item.role === 'user' && item.turn === question.id)) {
      result.push({ id: `question-${question.id}`, order: question.order || 0, role: 'user', text: question.text, utterance: '', turn: question.id, status: '' });
    }
    for (const reply of state.speeches) {
      const stored = result.find(item => item.utterance === reply.id);
      if (stored) { stored.text = reply.zh || reply.ja; stored.status = reply.state; }
      else result.push({ id: reply.id, order: reply.order || 0, role: 'assistant', text: reply.zh || reply.ja, utterance: reply.id, turn: '', status: reply.state });
    }
    return result.sort((a, b) => a.order - b.order);
  }, [state.history, state.questions, state.speeches]);
  useEffect(() => {
    if (contextOpen && follow.current && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [entries, contextOpen]);
  const lastQuestion = state.questions.at(-1)?.text || [...entries].reverse().find(item => item.role === 'user')?.text;
  function openContext() {
    setContextOpen(value => !value);
    if (!contextOpen && state.connected && cid) void bridge.send({ type: 'history.get' });
  }
  return <section className="companion-workspace" aria-label="对话与工作区" data-companion-interactive>
    <header className="companion-workspace-heading"><div><i/><span>对话 / 工作区</span></div><button type="button" aria-label="查看上下文" aria-expanded={contextOpen} onClick={openContext}>上下文{entries.length > 0 && <small>{entries.length}</small>}</button></header>
    <div className="companion-workspace-topic" title={state.conversation?.title}>{state.conversation?.title || '与彩名聊一聊'}<span>{state.task === 'thinking' ? '思考中' : state.task === 'acting' ? '工作中' : '当前话题'}</span></div>
    <div className="companion-live-dialogue" hidden={contextOpen}>
      {lastQuestion && <p className="companion-last-question"><span>你</span>{lastQuestion}</p>}
      <CinematicDialogue speech={speech} translate={state.settings.subtitles !== false} textOnly={textOnly} show={show} showJapanese={showJapanese} onVisibilityChange={onVisibilityChange}/>
      {!speech && <p className="companion-workspace-empty">从这里开始，对话会留在当前话题里。</p>}
    </div>
    <div className="companion-context" hidden={!contextOpen} ref={list} onScroll={event => {
      const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
    }}>
      <div className="companion-context-materials"><strong>话题上下文</strong><p>{state.contextSummary || '记录本话题中的对话与工作材料。'}</p>
        {(state.target || state.repository) && <p>{[state.target?.title, state.repository?.name].filter(Boolean).join(' · ')}</p>}
        <button type="button" onClick={() => void bridge.openSettings('tasks')}>查看任务与结果 ↗</button>
      </div>
      {state.historyHasMore && <button type="button" className="companion-context-more" disabled={loading} onClick={() => {
        setLoading(true); follow.current = false;
        void bridge.send({ type: 'history.get', before: state.historyBefore }).then(result => { if (!result.ok) setLoading(false); });
      }}>{loading ? '正在读取…' : '加载更早的记录'}</button>}
      {entries.map(item => <article key={item.id} className={`companion-context-message from-${item.role}`}><header><strong>{item.role === 'user' ? '你' : '彩名'}</strong>{['partial', 'cancelled'].includes(item.status) && <small>已打断</small>}</header><p>{item.text}</p></article>)}
      {!entries.length && <p className="companion-workspace-empty">这个话题还没有对话。</p>}
    </div>
  </section>;
}
