import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CinematicDialogue } from './CinematicDialogue';
import { dialogueGlyphs } from './cinematic';
import type { ModelState, Speech } from './state';
import { bridge } from './state';
import type { DialogueLanguage } from './dialogueLanguages';
import type { CaptionLayout } from './captionLayout';

export function CompanionWorkspace(props: {
  state: ModelState; speech?: Speech; textOnly: boolean; show: boolean; primaryLanguage: DialogueLanguage;
  translationLanguage: 'none' | DialogueLanguage; onVisibilityChange: (visible: boolean) => void;
  layout?: CaptionLayout;
}) {
  return <DialogueScene key={props.state.conversation?.conversation_id || 'initial'} {...props}/>;
}
function DialogueScene({ state, speech, textOnly, show, primaryLanguage, translationLanguage, onVisibilityChange, layout }: Parameters<typeof CompanionWorkspace>[0]) {
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const older = useRef<{ height: number; top: number; history: ModelState['history'] } | undefined>(undefined);
  const previous = useRef(new Map<string, { top: number }>());
  const animations = useRef<Animation[]>([]);
  const frame = useRef(0), animateUntil = useRef(0);
  const translationsRequested = useRef(new Set<string>());
  const cid = state.conversation?.conversation_id;
  useEffect(() => { if (state.connected && cid) void bridge.send({ type: 'history.get' }); }, [cid, state.connected]);
  useEffect(() => { setLoading(false); if (state.error) older.current = undefined; }, [state.history, state.error]);
  useEffect(() => () => { cancelAnimationFrame(frame.current); animations.current.forEach(animation => animation.cancel()); }, []);
  const entries = useMemo(() => {
    const index = state.speeches.findIndex(item => item.id === speech?.id);
    const seen = (item: Speech, at: number) => item.id === speech?.id || (index >= 0 && at < index && item.state !== 'cancelled')
      || item.state === 'played' || (item.state === 'partial' && item.played > 0);
    const result: Speech[] = state.history.filter(item => item.role === 'assistant').filter(item => {
      const at = state.speeches.findIndex(reply => reply.id === item.utterance_id);
      return at >= 0 ? seen(state.speeches[at], at) : item.displayed === true || ['played', 'partial'].includes(String(item.status));
    }).map(item => ({ id: String(item.utterance_id || `stored-${item.id}`), order: Number(item.id), ja: String(item.speech_ja || ''), zh: String(item.display_zh || ''), en: String(item.display_en || ''), enError: item.en_error ? String(item.en_error) : undefined,
      state: item.status === 'partial' ? 'partial' : 'played', played: Number(item.played_samples || 0), total: Number(item.total_samples || 0), generation: 0, intent: '', intensity: 0, affect: '', assetId: '' }));
    state.speeches.forEach((reply, at) => {
      if (!seen(reply, at)) return;
      const stored = result.find(item => item.id === reply.id);
      if (stored) Object.assign(stored, reply, { order: stored.order }); else result.push(reply);
    });
    return result.sort((a, b) => (a.order || 0) - (b.order || 0));
  }, [state.history, state.speeches, speech?.id]);
  const activeId = speech?.id || entries.at(-1)?.id;
  const questionText = String(state.questions.at(-1)?.text || [...state.history].reverse().find(item => item.role === 'user')?.text || '');
  const signature = entries.map(item => `${item.id}:${item.zh}:${item.en}:${item.ja}`).join('|') + `:${activeId}:${primaryLanguage}:${translationLanguage}:${show}`;
  useEffect(() => {
    if (primaryLanguage !== 'en' && translationLanguage !== 'en') { translationsRequested.current.clear(); return; }
    if (!state.connected || !show) return;
    const ids = entries.filter(item => !item.en && !translationsRequested.current.has(item.id)).slice(-30).map(item => item.id);
    if (!ids.length) return;
    ids.forEach(id => translationsRequested.current.add(id));
    void bridge.send({ type: 'subtitles.translate', utterance_ids: ids, language: 'en' }).then(result => {
      if (!result.ok) ids.forEach(id => translationsRequested.current.delete(id));
    });
  }, [signature, state.connected]);

  function focusFrame() {
    frame.current = 0;
    const node = list.current;
    if (!node) return;
    const viewport = node.getBoundingClientRect(), center = viewport.top + viewport.height / 2;
    const rows = [...node.querySelectorAll<HTMLElement>('[data-caption-id]')];
    const positions = rows.map(row => { const rect = row.getBoundingClientRect(); return { row, top: rect.top, distance: Math.abs(rect.top + rect.height / 2 - center) }; });
    const nearest = positions.reduce<typeof positions[number] | undefined>((best, row) => !best || row.distance < best.distance ? row : best, undefined);
    for (const { row, top, distance } of positions) {
      const closeness = Math.max(0, 1 - distance / Math.max(1, viewport.height * .72));
      const caption = row.firstElementChild as HTMLElement;
      caption.style.setProperty('--caption-scale', String(.78 + .22 * closeness));
      caption.style.setProperty('--caption-opacity', String(.25 + .75 * closeness * closeness));
      row.style.zIndex = String(Math.round(closeness * 100));
      row.dataset.focused = String(row === nearest?.row);
      previous.current.set(row.dataset.captionId!, { top });
    }
    if (performance.now() < animateUntil.current) frame.current = requestAnimationFrame(focusFrame);
  }
  function scheduleFocus(duration = 240) {
    animateUntil.current = Math.max(animateUntil.current, performance.now() + duration);
    if (!frame.current) frame.current = requestAnimationFrame(focusFrame);
  }
  function centerLatest() {
    const node = list.current, row = node?.querySelector<HTMLElement>(`[data-caption-id="${activeId}"]`);
    if (!node || !row) return;
    node.scrollTop = row.offsetTop + row.offsetHeight / 2 - node.clientHeight / 2;
  }
  useLayoutEffect(() => {
    const node = list.current;
    if (!node) return;
    const rows = [...node.querySelectorAll<HTMLElement>('[data-caption-id]')];
    const snapshot = new Map(previous.current);
    animations.current.forEach(animation => animation.cancel()); animations.current = [];
    node.style.setProperty('--scene-height', `${node.clientHeight}px`);
    if (older.current && older.current.history !== state.history) {
      node.scrollTop = older.current.top + node.scrollHeight - older.current.height;
      older.current = undefined;
    } else if (follow.current && !older.current) centerLatest();
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduced && follow.current) for (const row of rows) {
      const saved = snapshot.get(row.dataset.captionId!), top = row.getBoundingClientRect().top;
      const delta = saved ? saved.top - top : 24;
      if (Math.abs(delta) > .5 && Math.abs(delta) < node.clientHeight * 3) animations.current.push(row.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0px)' }],
        { duration: 560, easing: 'cubic-bezier(.22,1,.36,1)' }));
    }
    scheduleFocus(650);
  }, [signature, state.history]);
  const resizeRef = useRef(() => {});
  resizeRef.current = () => {
    const node = list.current;
    if (!node) return;
    node.style.setProperty('--scene-height', `${node.clientHeight}px`);
    if (follow.current) centerLatest(); scheduleFocus();
  };
  useLayoutEffect(() => {
    const node = list.current!;
    const observer = new ResizeObserver(() => resizeRef.current());
    observer.observe(node); observer.observe(node.firstElementChild!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (!show || !entries.length) onVisibilityChange(false); }, [show, entries.length, onVisibilityChange]);
  function loadOlder() {
    const node = list.current;
    if (!node || loading || older.current || !state.historyHasMore || !state.connected) return;
    older.current = { height: node.scrollHeight, top: node.scrollTop, history: state.history }; setLoading(true);
    void bridge.send({ type: 'history.get', before: state.historyBefore }).then(result => { if (!result.ok) { older.current = undefined; setLoading(false); } });
  }
  return <section className="companion-workspace" aria-label="对话与工作区" data-companion-interactive
    data-caption-layout={layout?.mode} style={layout && { left: layout.x, top: layout.y, width: layout.width, height: layout.height }}>
    {questionText && <aside className="cinematic-question" aria-label="你上一句说的话"><span className="cinematic-question-label">你</span><p key={questionText}>{dialogueGlyphs(questionText).map((glyph, index) => <span key={index} className="cinematic-question-glyph" style={{ animationDelay: `${Math.min(index * 14, 560)}ms` }}>{glyph}</span>)}</p></aside>}
    <div className="cinematic-memory" aria-label="彩名的台词与历史，向上滚动查看" tabIndex={0} ref={list} data-reading={reading} hidden={!show}
      onWheel={event => { if (event.deltaY) { follow.current = false; setReading(true); scheduleFocus(); if (event.deltaY < 0 && event.currentTarget.scrollTop < 40) loadOlder(); } }}
      onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) { follow.current = false; setReading(true); scheduleFocus(); if (event.currentTarget.scrollTop < 40) loadOlder(); } }}
      onScroll={event => {
        const node = event.currentTarget, row = node.querySelector<HTMLElement>(`[data-caption-id="${activeId}"]`);
        if (!older.current) follow.current = Boolean(row && Math.abs(row.offsetTop + row.offsetHeight / 2 - node.scrollTop - node.clientHeight / 2) < 14);
        setReading(!follow.current); scheduleFocus();
        if (!follow.current && node.scrollTop < 24) loadOlder();
      }}>
      <div className="cinematic-memory-track">
        {loading && <span className="cinematic-history-loading" role="status">正在读取…</span>}
        {entries.map(item => <article key={item.id} data-caption-id={item.id} className={`cinematic-memory-row ${activeId === item.id ? 'is-current' : 'is-memory'}`}>
          <CinematicDialogue speech={item} primaryLanguage={primaryLanguage} translationLanguage={translationLanguage} textOnly={textOnly}
            active={item.id === speech?.id} show={show} onVisibilityChange={onVisibilityChange}/>
        </article>)}
      </div>
    </div>
  </section>;
}
