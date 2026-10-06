import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CinematicDialogue } from './CinematicDialogue';
import { dialogueGlyphs } from './cinematic';
import type { ModelState, Speech } from './state';
import { bridge } from './state';

export function CompanionWorkspace({ state, speech, textOnly, show, showJapanese, onVisibilityChange }: {
  state: ModelState; speech?: Speech; textOnly: boolean; show: boolean; showJapanese: boolean; onVisibilityChange: (visible: boolean) => void;
}) {
  const cid = state.conversation?.conversation_id;
  // Remount on a topic change, including timers, scroll position and retired captions.
  return <DialogueScene key={cid || 'initial'} {...{ state, speech, textOnly, show, showJapanese, onVisibilityChange }}/>;
}

function DialogueScene({ state, speech, textOnly, show, showJapanese, onVisibilityChange }: Parameters<typeof CompanionWorkspace>[0]) {
  const [retired, setRetired] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const older = useRef<{ height: number; top: number; history: ModelState['history'] } | undefined>(undefined);
  const previous = useRef(new Map<string, { bottom: number; opacity: number }>());
  const animations = useRef<Animation[]>([]);
  const cid = state.conversation?.conversation_id;
  const translate = state.settings.subtitles !== false;
  useEffect(() => { if (state.connected && cid) void bridge.send({ type: 'history.get' }); }, [cid, state.connected]);
  useEffect(() => { setLoading(false); if (state.error) older.current = undefined; }, [state.history, state.error]);
  useEffect(() => () => animations.current.forEach(animation => animation.cancel()), []);
  const complete = useCallback((id: string) => setRetired(value => value.has(id) ? value : new Set([...value, id])), []);
  const active = speech && !retired.has(speech.id) ? speech : undefined;
  const entries = useMemo(() => {
    const index = state.speeches.findIndex(item => item.id === speech?.id);
    const seen = (item: Speech, at: number) => item.id === speech?.id || retired.has(item.id)
      || (index >= 0 && at < index && item.state !== 'cancelled') || item.state === 'played' || (item.state === 'partial' && item.played > 0);
    const result = state.history.filter(item => item.role === 'assistant').filter(item => {
      const at = state.speeches.findIndex(reply => reply.id === item.utterance_id);
      return at >= 0 ? seen(state.speeches[at], at) : item.displayed === true || ['played', 'partial'].includes(String(item.status));
    }).map(item => ({ id: String(item.utterance_id || `stored-${item.id}`), order: Number(item.id), ja: String(item.speech_ja || ''), zh: String(item.display_zh || ''), status: String(item.status || '') }));
    state.speeches.forEach((reply, at) => {
      if (!seen(reply, at)) return;
      const stored = result.find(item => item.id === reply.id);
      if (stored) { stored.zh = reply.zh; stored.ja = reply.ja; stored.status = reply.state; }
      else result.push({ id: reply.id, order: reply.order || 0, ja: reply.ja, zh: reply.zh, status: reply.state });
    });
    return result.sort((a, b) => a.order - b.order);
  }, [state.history, state.speeches, speech?.id, retired]);
  const question = state.questions.at(-1)?.text || [...state.history].reverse().find(item => item.role === 'user')?.text;
  const questionText = String(question || '');
  const signature = entries.map(item => `${item.id}:${item.zh}:${item.ja}`).join('|') + `:${active?.id || ''}:${showJapanese}:${translate}:${show}`;

  // Native scrolling belongs to the reader. Only animate existing rows when
  // following the newest sentence; preserve the viewport when adding older pages.
  useLayoutEffect(() => {
    const node = list.current;
    if (!node) return;
    const rows = [...node.querySelectorAll<HTMLElement>('[data-caption-id]')];
    animations.current.forEach(animation => animation.cancel());
    animations.current = [];
    if (older.current && older.current.history !== state.history) {
      node.scrollTop = older.current.top + node.scrollHeight - older.current.height;
      older.current = undefined;
    } else if (follow.current && !older.current) node.scrollTop = node.scrollHeight;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const next = new Map<string, { bottom: number; opacity: number }>();
    for (const row of rows) {
      const id = row.dataset.captionId!, rect = row.getBoundingClientRect(), style = getComputedStyle(row);
      const saved = previous.current.get(id), opacity = Number(style.opacity);
      next.set(id, { bottom: rect.bottom, opacity });
      if (!saved || !follow.current || reduced) continue;
      const delta = saved.bottom - rect.bottom;
      const base = new DOMMatrixReadOnly(style.transform === 'none' ? undefined : style.transform).m42;
      if (Math.abs(delta) < node.clientHeight * 2 && (Math.abs(delta) > 1 || saved.opacity !== opacity)) {
        animations.current.push(row.animate([
          { transform: `translateY(${base + delta}px)`, opacity: saved.opacity },
          { transform: `translateY(${base}px)`, opacity },
        ], { duration: 620, easing: 'cubic-bezier(.22,1,.36,1)' }));
      }
    }
    previous.current = next;
  }, [signature, state.history]);
  useLayoutEffect(() => {
    const node = list.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      node.style.setProperty('--scene-height', `${node.clientHeight}px`);
      if (follow.current) node.scrollTop = node.scrollHeight;
    });
    observer.observe(node); return () => observer.disconnect();
  }, []);
  useEffect(() => { if (!active || !show) onVisibilityChange(false); }, [active?.id, show, onVisibilityChange]);
  function loadOlder() {
    const node = list.current;
    if (!node || loading || older.current || !state.historyHasMore || !state.connected) return;
    older.current = { height: node.scrollHeight, top: node.scrollTop, history: state.history };
    setLoading(true);
    void bridge.send({ type: 'history.get', before: state.historyBefore }).then(result => {
      if (!result.ok) { older.current = undefined; setLoading(false); }
    });
  }
  return <section className="companion-workspace" aria-label="对话与工作区" data-companion-interactive>
    {questionText && <aside className="cinematic-question" aria-label="你上一句说的话"><span className="cinematic-question-label">你</span><p key={questionText}>{dialogueGlyphs(questionText).map((glyph, index) => <span key={index} className="cinematic-question-glyph" style={{ animationDelay: `${Math.min(index * 14, 560)}ms` }}>{glyph}</span>)}</p></aside>}
    <div className="cinematic-memory" aria-label="彩名的台词与历史，向上滚动查看" tabIndex={0} ref={list} data-reading={reading} hidden={!show}
      onWheel={event => { if (event.deltaY < 0) { follow.current = false; setReading(true); if (event.currentTarget.scrollTop < 40) loadOlder(); } }}
      onKeyDown={event => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) { follow.current = false; setReading(true); if (event.currentTarget.scrollTop < 40) loadOlder(); } }}
      onScroll={event => {
        const node = event.currentTarget;
        follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 8;
        setReading(!follow.current);
        if (!follow.current && node.scrollTop < 24) loadOlder();
        previous.current = new Map([...node.querySelectorAll<HTMLElement>('[data-caption-id]')].map(row => [row.dataset.captionId!, { bottom: row.getBoundingClientRect().bottom, opacity: Number(getComputedStyle(row).opacity) }]));
      }}>
      <div className="cinematic-memory-track">
        {loading && <span className="cinematic-history-loading" role="status">正在读取…</span>}
        {entries.map(item => <article key={item.id} data-caption-id={item.id} className={`cinematic-memory-row ${active?.id === item.id ? 'is-current' : 'is-memory'}`}>
          {active?.id === item.id ? <CinematicDialogue speech={active} translate={translate} textOnly={textOnly} show={show} showJapanese={showJapanese} onVisibilityChange={onVisibilityChange} onComplete={complete}/>
            : <div className="cinematic-memory-caption"><p>{translate ? item.zh || item.ja : item.ja}</p>{showJapanese && translate && item.zh && <p className="cinematic-original" lang="ja">{item.ja}</p>}{item.status === 'partial' && <small className="cinematic-interrupted">已打断</small>}</div>}
        </article>)}
      </div>
    </div>
  </section>;
}
