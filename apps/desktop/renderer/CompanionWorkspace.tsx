import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CinematicDialogue } from './CinematicDialogue';
import type { ModelState, Speech } from './state';
import { bridge } from './state';
import type { DialogueLanguage } from './dialogueLanguages';
import type { CaptionLayout } from './captionLayout';
import { captionAnchor, captionSpring, captionStep } from './captionStack';
import { captionFocus } from './captionFocus';
import { activeWaitingTool, dialogueWaiting } from './dialogueWaiting';
import { CompanionWaiting } from './CompanionWaiting';

type AssistantEntry = { id: string; order: number; role: 'assistant'; speech: Speech };
type UserEntry = { id: string; order: number; role: 'user'; text: string; live: boolean; turnId?: string };
type DialogueEntry = AssistantEntry | UserEntry;

export function CompanionWorkspace(props: {
  state: ModelState; speech?: Speech; textOnly: boolean; show: boolean; primaryLanguage: DialogueLanguage;
  translationLanguage: 'none' | DialogueLanguage; onVisibilityChange: (visible: boolean) => void;
  layout?: CaptionLayout;
}) {
  return <DialogueScene key={props.state.conversation?.conversation_id || 'initial'} {...props}/>;
}
function DialogueScene({ state, speech, textOnly, show, primaryLanguage, translationLanguage, onVisibilityChange, layout }: Parameters<typeof CompanionWorkspace>[0]) {
  const [loading, setLoading] = useState(false);
  const [focusedId, setFocusedId] = useState<string>();
  const [reading, setReading] = useState(false);
  const [overview, setOverview] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const older = useRef<{ height: number; top: number; history: ModelState['history'] } | undefined>(undefined);
  const translationsRequested = useRef(new Set<string>());
  // Wheel input feeds a spring, so one gesture can travel past several sentences and settle softly.
  const wheel = useRef({ target: 0, current: 0, velocity: 0, frame: 0, last: 0 });
  const follow = useRef(true);
  const focusedRef = useRef<string | undefined>(undefined);
  const readingRef = useRef(false);
  const mounted = useRef(false);
  const cid = state.conversation?.conversation_id;
  useEffect(() => { if (state.connected && cid) void bridge.send({ type: 'history.get' }); }, [cid, state.connected]);
  useEffect(() => {
    setLoading(false);
    if (state.error) older.current = undefined;
  }, [state.history, state.error]);
  const entries = useMemo(() => {
    const index = state.speeches.findIndex(item => item.id === speech?.id);
    const seen = (item: Speech, at: number) => item.id === speech?.id || (index >= 0 && at < index && item.state !== 'cancelled')
      || item.state === 'played' || (item.state === 'partial' && item.played > 0);
    const historyEntries: DialogueEntry[] = [], assistants = new Map<string, AssistantEntry>(), userTurns = new Set<string>();
    let lastUser: UserEntry | undefined;
    for (const item of state.history) {
      const order = Number(item.id) || 0, role = String(item.role || '');
      if (role === 'user') {
        const text = String(item.text || '');
        if (!text) continue;
        const turnId = String(item.turn_id || '');
        if (turnId) userTurns.add(turnId);
        lastUser = { id: `user:${item.id ?? historyEntries.length}`, order, role: 'user', text, live: false, turnId: turnId || undefined };
        historyEntries.push(lastUser);
        continue;
      }
      if (role !== 'assistant') continue;
      const at = state.speeches.findIndex(reply => reply.id === item.utterance_id);
      const storedVisible = item.displayed === true || ['played', 'partial'].includes(String(item.status));
      if (!(at >= 0 ? seen(state.speeches[at], at) || storedVisible : storedVisible)) continue;
      const speech: Speech = { id: String(item.utterance_id || `stored-${item.id}`), order, ja: String(item.speech_ja || ''), zh: String(item.display_zh || ''), en: String(item.display_en || ''), enError: item.en_error ? String(item.en_error) : undefined,
        state: item.status === 'partial' ? 'partial' : 'played', played: Number(item.played_samples || 0), total: Number(item.total_samples || 0), generation: 0, intent: '', intensity: 0, affect: '', assetId: '' };
      const entry: AssistantEntry = { id: speech.id, order, role: 'assistant', speech };
      historyEntries.push(entry); assistants.set(entry.id, entry);
    }
    const liveEntries: DialogueEntry[] = [];
    state.speeches.forEach((reply, at) => {
      if (!seen(reply, at)) return;
      const stored = assistants.get(reply.id);
      if (stored) Object.assign(stored.speech, reply, { order: stored.order });
      else liveEntries.push({ id: reply.id, order: reply.order || 0, role: 'assistant', speech: reply });
    });
    const latestQuestion = state.questions.at(-1);
    state.questions.forEach(question => {
      const turnId = String(question.id || ''), text = String(question.text || '');
      if (!text || (turnId && userTurns.has(turnId))) return;
      if (question === latestQuestion && lastUser && !lastUser.turnId && lastUser.text === text) return;
      liveEntries.push({ id: `question:${turnId || text}`, order: Number(question.order) || 0, role: 'user', text, live: true, turnId: turnId || undefined });
    });
    liveEntries.sort((a, b) => (a.order || 0) - (b.order || 0));
    return [...historyEntries, ...liveEntries];
  }, [state.history, state.speeches, state.questions, speech?.id]);
  const lastAssistant = [...entries].reverse().find((entry): entry is AssistantEntry => entry.role === 'assistant');
  const activeId = speech?.id || lastAssistant?.id;
  const signature = entries.map(entry => entry.role === 'assistant'
    ? `${entry.id}:${entry.speech.zh}:${entry.speech.en}:${entry.speech.ja}`
    : `${entry.id}:${entry.text}`).join('|') + `:${activeId}:${primaryLanguage}:${translationLanguage}:${show}`;
  const entriesRef = useRef(entries); entriesRef.current = entries;
  const waiting = dialogueWaiting(state);
  const toolWaiting = waiting && Boolean(activeWaitingTool(state));
  const waitingContinuation = state.speeches.some(item => item.generation === state.generation
    && (item.id === state.presented || ['playing', 'played', 'partial'].includes(item.state)));
  useEffect(() => {
    if (primaryLanguage !== 'en' && translationLanguage !== 'en') { translationsRequested.current.clear(); return; }
    if (!state.connected || !show) return;
    const ids = entries.filter((entry): entry is AssistantEntry => entry.role === 'assistant')
      .filter(entry => !entry.speech.en && !translationsRequested.current.has(entry.id)).slice(-30).map(entry => entry.id);
    if (!ids.length) return;
    ids.forEach(id => translationsRequested.current.add(id));
    void bridge.send({ type: 'subtitles.translate', utterance_ids: ids, language: 'en' }).then(result => {
      if (!result.ok) ids.forEach(id => translationsRequested.current.delete(id));
    });
  }, [signature, state.connected]);

  function bounds(node: HTMLElement) { return Math.max(0, node.scrollHeight - node.clientHeight); }
  function syncReading() {
    const next = !follow.current;
    if (readingRef.current !== next) { readingRef.current = next; setReading(next); }
  }
  function updateFocus(node: HTMLElement) {
    const latest = entriesRef.current.at(-1)?.id;
    let next = latest;
    if (!follow.current) {
      const center = node.scrollTop + node.clientHeight / 2;
      const rows = [...node.querySelectorAll<HTMLElement>('.cinematic-memory-row')];
      next = captionFocus(rows.map(row => ({ id: row.dataset.captionId || '', center: row.offsetTop + row.offsetHeight / 2 })), center, focusedRef.current);
    }
    if (focusedRef.current !== next) { focusedRef.current = next; setFocusedId(next); }
  }
  function tick(now: number) {
    const node = list.current;
    const current = wheel.current;
    current.frame = 0;
    if (!node) return;
    const dt = Math.min(.05, Math.max(.001, (now - current.last) / 1000));
    current.last = now;
    const maximum = bounds(node);
    current.target = Math.max(0, Math.min(maximum, current.target));
    const step = captionSpring(current.current, current.target, current.velocity, dt);
    current.current = step.value; current.velocity = step.velocity;
    if (current.current < 0) { current.current = 0; current.velocity = 0; }
    else if (current.current > maximum) { current.current = maximum; current.velocity = 0; }
    node.scrollTop = current.current;
    syncReading(); updateFocus(node);
    if (!follow.current && node.scrollTop < 80) loadOlderRef.current();
    if (step.settled) {
      current.current = current.target = Math.max(0, Math.min(maximum, current.target));
      current.velocity = 0; node.scrollTop = current.current;
      syncReading(); updateFocus(node);
      return;
    }
    current.frame = requestAnimationFrame(tick);
  }
  function animateTo(value: number, instant = false) {
    const node = list.current;
    if (!node) return;
    const maximum = bounds(node), target = Math.max(0, Math.min(maximum, value));
    const jump = instant || Math.abs(target - node.scrollTop) > node.clientHeight * 2;
    const current = wheel.current;
    if (!current.frame) { current.current = node.scrollTop; current.velocity = 0; }
    current.target = target;
    if (jump || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      if (current.frame) cancelAnimationFrame(current.frame);
      current.frame = 0; current.current = target; current.velocity = 0; node.scrollTop = target;
      syncReading(); updateFocus(node);
      return;
    }
    if (!current.frame) { current.last = performance.now(); current.frame = requestAnimationFrame(tick); }
  }
  function focusRow(id: string) {
    const node = list.current;
    if (!node) return;
    const row = [...node.querySelectorAll<HTMLElement>('.cinematic-memory-row')].find(item => item.dataset.captionId === id);
    if (!row) return;
    const latest = id === entriesRef.current.at(-1)?.id;
    follow.current = latest;
    if (readingRef.current !== !latest) { readingRef.current = !latest; setReading(!latest); }
    if (focusedRef.current !== id) { focusedRef.current = id; setFocusedId(id); }
    animateTo(latest ? bounds(node) : captionAnchor(row.offsetTop, row.offsetHeight, node.clientHeight));
  }
  function currentIndex() {
    const index = entries.findIndex(item => item.id === focusedRef.current);
    return index >= 0 ? index : Math.max(0, entries.findIndex(item => item.id === activeId));
  }
  function navigate(direction: number) {
    const index = currentIndex();
    if (direction < 0 && index === 0) { loadOlder(); return; }
    const item = entries[captionStep(index, direction, entries.length)];
    if (item) focusRow(item.id);
  }
  function jump(distance: number) {
    const index = currentIndex();
    if (distance < 0 && index === 0) { loadOlder(); return; }
    const item = entries[Math.max(0, Math.min(entries.length - 1, index + distance))];
    if (item) focusRow(item.id);
  }
  function latest() {
    const node = list.current;
    if (!node) return;
    follow.current = true;
    if (readingRef.current) { readingRef.current = false; setReading(false); }
    const id = entriesRef.current.at(-1)?.id;
    if (id && focusedRef.current !== id) { focusedRef.current = id; setFocusedId(id); }
    animateTo(bounds(node));
  }
  const latestRef = useRef(latest); latestRef.current = latest;
  function loadOlder() {
    const node = list.current;
    if (!node || loading || older.current || !state.historyHasMore || !state.connected) return;
    follow.current = false; syncReading();
    older.current = { height: node.scrollHeight, top: node.scrollTop, history: state.history }; setLoading(true);
    void bridge.send({ type: 'history.get', before: state.historyBefore }).then(result => {
      if (!result.ok) { older.current = undefined; setLoading(false); }
    });
  }
  const loadOlderRef = useRef(loadOlder); loadOlderRef.current = loadOlder;

  useLayoutEffect(() => {
    const node = list.current!;
    const track = node.querySelector<HTMLElement>('.cinematic-memory-track')!;
    const resize = () => {
      const height = `${Math.round(node.clientHeight)}px`;
      if (node.style.getPropertyValue('--stack-height') !== height) node.style.setProperty('--stack-height', height);
      const bottom = bounds(node);
      if (!follow.current) return;
      if (wheel.current.frame) { wheel.current.target = bottom; return; }
      wheel.current.current = bottom; wheel.current.target = bottom; wheel.current.velocity = 0;
      node.scrollTop = bottom;
      syncReading(); updateFocus(node);
    };
    const observer = new ResizeObserver(resize); observer.observe(node); observer.observe(track); resize();
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const node = list.current;
    if (!node) return;
    if (wheel.current.frame) cancelAnimationFrame(wheel.current.frame);
    wheel.current.frame = 0; wheel.current.velocity = 0;
    const id = focusedRef.current || entriesRef.current.at(-1)?.id;
    let top = bounds(node);
    if (!follow.current && id) {
      const row = [...node.querySelectorAll<HTMLElement>('.cinematic-memory-row')].find(item => item.dataset.captionId === id);
      if (row) top = captionAnchor(row.offsetTop, row.offsetHeight, node.clientHeight);
    }
    wheel.current.current = top; wheel.current.target = top; node.scrollTop = top;
    syncReading(); updateFocus(node);
  }, [overview]);
  useLayoutEffect(() => {
    const pending = older.current;
    if (!pending || pending.history === state.history) return;
    older.current = undefined;
    const node = list.current;
    if (!node) return;
    const top = pending.top + (node.scrollHeight - pending.height);
    if (wheel.current.frame) cancelAnimationFrame(wheel.current.frame);
    wheel.current.frame = 0; wheel.current.current = top; wheel.current.target = top; wheel.current.velocity = 0;
    node.scrollTop = top;
    follow.current = false;
    syncReading(); updateFocus(node);
  }, [state.history]);
  useLayoutEffect(() => {
    const node = list.current;
    if (!node) return;
    if (follow.current) animateTo(bounds(node), !mounted.current);
    else updateFocus(node);
    mounted.current = true;
  }, [signature]);
  useLayoutEffect(() => {
    const node = list.current;
    if (node && follow.current) animateTo(bounds(node), !mounted.current);
  }, [waiting, toolWaiting]);
  useLayoutEffect(() => { if (mounted.current) latestRef.current(); }, [state.questions.at(-1)?.id, state.summonVersion]);

  useEffect(() => {
    const node = list.current!;
    const browse = (event: WheelEvent) => {
      if (!event.deltaY) return;
      event.preventDefault();
      const current = wheel.current, now = performance.now();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1);
      if (!current.frame) { current.current = node.scrollTop; current.target = node.scrollTop; current.velocity = 0; }
      const maximum = bounds(node);
      current.target = Math.max(0, Math.min(maximum, current.target + delta * .92));
      follow.current = maximum <= 2 || current.target >= maximum - 2;
      syncReading();
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
        if (current.frame) cancelAnimationFrame(current.frame);
        current.frame = 0; current.current = current.target; current.velocity = 0; node.scrollTop = current.target;
        syncReading(); updateFocus(node);
        if (!follow.current && node.scrollTop < 80) loadOlderRef.current();
        return;
      }
      if (!current.frame) { current.last = now; current.frame = requestAnimationFrame(tick); }
    };
    const scrolled = () => {
      if (wheel.current.frame) return;
      wheel.current.current = node.scrollTop; wheel.current.target = node.scrollTop; wheel.current.velocity = 0;
      follow.current = bounds(node) - node.scrollTop <= 2;
      syncReading(); updateFocus(node);
      if (!follow.current && node.scrollTop < 80) loadOlderRef.current();
    };
    node.addEventListener('wheel', browse, { passive: false });
    node.addEventListener('scroll', scrolled, { passive: true });
    return () => {
      node.removeEventListener('wheel', browse); node.removeEventListener('scroll', scrolled);
      if (wheel.current.frame) cancelAnimationFrame(wheel.current.frame); wheel.current.frame = 0;
    };
  }, []);
  useEffect(() => { if (!show || !entries.length) onVisibilityChange(false); }, [show, entries.length, onVisibilityChange]);

  const focused = focusedId || activeId;
  const index = Math.max(0, entries.findIndex(item => item.id === (focusedId || activeId)));
  return <section className="companion-workspace cinematic-reel-workspace" aria-label="对话与工作区" data-companion-interactive
    data-caption-layout={layout?.mode} style={layout && { left: layout.x, top: layout.y, width: layout.width, height: layout.height }}>
    <div className="cinematic-memory-wrap" hidden={!show && !waiting}>
      <div className="cinematic-memory cinematic-reel" aria-label="彩名与你的对话，滚动查看历史，方向键切换焦点" tabIndex={0} ref={list}
        data-reading={reading} data-overview={overview} data-waiting={waiting} data-waiting-continuation={show && waitingContinuation}
        onKeyDown={event => {
          if ((event.target as Element).closest('button')) return;
          if (event.key === 'End') { event.preventDefault(); latest(); }
          else if (event.key === 'Home') { event.preventDefault(); const first = entries[0]; if (first) focusRow(first.id); }
          else if (event.key === 'PageUp') { event.preventDefault(); jump(-3); }
          else if (event.key === 'PageDown') { event.preventDefault(); jump(3); }
          else if (['ArrowUp', 'ArrowLeft'].includes(event.key)) { event.preventDefault(); navigate(-1); }
          else if (['ArrowDown', 'ArrowRight'].includes(event.key)) { event.preventDefault(); navigate(1); }
        }}>
        <div className="cinematic-memory-track">
          {loading && <div className="cinematic-history-loading" role="status">正在读取更早的台词…</div>}
          {show && entries.map(entry =>
            <article key={entry.id} data-caption-id={entry.id} data-role={entry.role} data-focused={entry.id === focused}
              data-current={entry.role === 'assistant' && entry.id === activeId}
              className={`cinematic-memory-row ${entry.role === 'user' ? 'is-user' : entry.id === activeId ? 'is-current' : 'is-memory'}`}
              onClick={() => { const selection = window.getSelection(); if (!selection || selection.isCollapsed) { focusRow(entry.id); setOverview(false); } }}>
              {entry.role === 'assistant'
                ? <CinematicDialogue speech={entry.speech} primaryLanguage={primaryLanguage} translationLanguage={translationLanguage} textOnly={textOnly}
                    active={entry.id === speech?.id} show={show} onVisibilityChange={onVisibilityChange}/>
                : <p className="cinematic-user-bubble">{entry.text}</p>}
            </article>)}
          {toolWaiting && <div className="cinematic-waiting-row"><CompanionWaiting key={state.questions.at(-1)?.id} state={state}/></div>}
          {waiting && !toolWaiting && <div className="cinematic-waiting-row">
            <div className="cinematic-waiting" role="status" aria-label="彩名正在思考" title="彩名正在思考">
              <span className="cinematic-waiting-light" aria-hidden="true"/>
              <span className="cinematic-waiting-dots" aria-hidden="true"><i/><i/><i/></span>
            </div>
          </div>}
        </div>
      </div>
      {show && entries.length > 0 && <nav className="cinematic-stack-navigation" aria-label="浏览对白" aria-busy={loading}>
        <button type="button" className="cinematic-stack-overview" aria-pressed={overview} aria-label={overview ? '收起台词总览' : '查看台词总览'} title={overview ? '收起台词总览' : '查看台词总览'} onClick={() => setOverview(value => !value)}>
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 7h14M5 12h14M5 17h9"/></svg>
        </button>
        {reading && <button type="button" className="cinematic-stack-latest" aria-label="回到最新台词" title="回到最新台词" onClick={latest}>
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 8v5a6 6 0 0 0 12 0V5m-4 4 4-4 4 4"/></svg>
        </button>}
        <button type="button" aria-label="上一句台词" title="上一句台词" disabled={loading || index === 0 && !state.historyHasMore} onClick={() => navigate(-1)}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m7 14 5-5 5 5"/></svg></button>
        <button type="button" aria-label="下一句台词" title="下一句台词" disabled={index >= entries.length - 1} onClick={() => navigate(1)}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg></button>
      </nav>}
    </div>
  </section>;
}
