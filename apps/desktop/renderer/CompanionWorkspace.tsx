import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { CinematicDialogue } from './CinematicDialogue';
import { dialogueGlyphs } from './cinematic';
import type { ModelState, Speech } from './state';
import { bridge } from './state';
import type { DialogueLanguage } from './dialogueLanguages';
import type { CaptionLayout } from './captionLayout';
import { captionLayer, captionStep } from './captionStack';
import { dialogueWaiting } from './dialogueWaiting';
import { CompanionWaiting } from './CompanionWaiting';

export function CompanionWorkspace(props: {
  state: ModelState; speech?: Speech; textOnly: boolean; show: boolean; primaryLanguage: DialogueLanguage;
  translationLanguage: 'none' | DialogueLanguage; onVisibilityChange: (visible: boolean) => void;
  layout?: CaptionLayout;
}) {
  return <DialogueScene key={props.state.conversation?.conversation_id || 'initial'} {...props}/>;
}
function DialogueScene({ state, speech, textOnly, show, primaryLanguage, translationLanguage, onVisibilityChange, layout }: Parameters<typeof CompanionWorkspace>[0]) {
  const [loading, setLoading] = useState(false);
  const [browsedId, setBrowsedId] = useState<string>();
  const list = useRef<HTMLDivElement>(null);
  const older = useRef<{ id?: string; history: ModelState['history'] } | undefined>(undefined);
  const translationsRequested = useRef(new Set<string>());
  const wheel = useRef({ amount: 0, at: 0, steppedAt: 0 });
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
    const result: Speech[] = state.history.filter(item => item.role === 'assistant').filter(item => {
      const at = state.speeches.findIndex(reply => reply.id === item.utterance_id);
      const storedVisible = item.displayed === true || ['played', 'partial'].includes(String(item.status));
      return at >= 0 ? seen(state.speeches[at], at) || storedVisible : storedVisible;
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

  const activeIndex = Math.max(0, entries.findIndex(item => item.id === activeId));
  const foundIndex = browsedId ? entries.findIndex(item => item.id === browsedId) : -1;
  const selectedIndex = foundIndex >= 0 ? foundIndex : activeIndex;
  const selectedId = entries[selectedIndex]?.id;
  const reading = Boolean(selectedId && selectedId !== activeId);
  const waiting = dialogueWaiting(state);
  const waitingContinuation = state.speeches.some(item => item.generation === state.generation
    && (item.id === state.presented || ['playing', 'played', 'partial'].includes(item.state)));
  const previousSelection = useRef<{ id?: string; index: number }>({ index: selectedIndex });
  useLayoutEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = { id: selectedId, index: selectedIndex };
    if (!previous.id || previous.id === selectedId || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const focused = list.current?.querySelector('[data-focused=true]');
    const direction = selectedIndex < previous.index ? -1 : 1;
    const animations = [...(focused?.querySelectorAll('.cinematic-shot, .cinematic-original') || [])].map(node => node.animate([
      { opacity: 0, transform: `translateY(${direction * 18}px)` },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: 380, easing: 'cubic-bezier(.22,1,.36,1)' }));
    return () => animations.forEach(animation => animation.cancel());
  }, [selectedId]);
  function latest() { setBrowsedId(undefined); wheel.current.amount = 0; }
  // New replies follow automatically unless the user is browsing an earlier sentence.
  useLayoutEffect(latest, [state.questions.at(-1)?.id, state.summonVersion]);
  useLayoutEffect(() => {
    const pending = older.current;
    if (!pending || pending.history === state.history) return;
    older.current = undefined;
    const at = entries.findIndex(item => item.id === pending.id);
    if (at > 0) setBrowsedId(entries[at - 1].id);
  }, [state.history, entries]);
  useLayoutEffect(() => {
    const node = list.current!;
    const resize = () => node.style.setProperty('--stack-height', `${node.clientHeight}px`);
    const observer = new ResizeObserver(resize); observer.observe(node); resize();
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (!show || !entries.length) onVisibilityChange(false); }, [show, entries.length, onVisibilityChange]);
  function loadOlder() {
    if (loading || older.current || !state.historyHasMore || !state.connected) return;
    older.current = { id: selectedId, history: state.history }; setLoading(true);
    void bridge.send({ type: 'history.get', before: state.historyBefore }).then(result => {
      if (!result.ok) { older.current = undefined; setLoading(false); }
    });
  }
  function navigate(direction: number) {
    if (direction < 0 && selectedIndex === 0) { loadOlder(); return; }
    const index = captionStep(selectedIndex, direction, entries.length);
    setBrowsedId(entries[index]?.id === activeId ? undefined : entries[index]?.id);
  }
  const navigateRef = useRef(navigate); navigateRef.current = navigate;
  useEffect(() => {
    const node = list.current!;
    const browse = (event: WheelEvent) => {
      const scrollable = (event.target as Element).closest<HTMLElement>('.cinematic-dialogue');
      if (scrollable && scrollable.scrollHeight > scrollable.clientHeight + 2) {
        const canScroll = event.deltaY < 0 ? scrollable.scrollTop > 1 : scrollable.scrollTop + scrollable.clientHeight < scrollable.scrollHeight - 1;
        if (canScroll) return;
      }
      if (!event.deltaY) return;
      event.preventDefault();
      const current = wheel.current, now = performance.now();
      if (now - current.at > 250 || Math.sign(event.deltaY) !== Math.sign(current.amount)) current.amount = 0;
      current.amount += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1);
      current.at = now;
      if (Math.abs(current.amount) >= 42 && now - current.steppedAt >= 220) {
        navigateRef.current(Math.sign(current.amount)); current.amount = 0; current.steppedAt = now;
      }
    };
    node.addEventListener('wheel', browse, { passive: false });
    return () => node.removeEventListener('wheel', browse);
  }, []);
  const touch = useRef<number | undefined>(undefined);
  return <section className="companion-workspace cinematic-stack-workspace" aria-label="对话与工作区" data-companion-interactive
    data-caption-layout={layout?.mode} style={layout && { left: layout.x, top: layout.y, width: layout.width, height: layout.height }}>
    <div className="cinematic-memory cinematic-stack" aria-label="彩名的台词，滚轮或方向键切换前景台词" tabIndex={0} ref={list} data-reading={reading} data-waiting={waiting} data-waiting-continuation={show && waitingContinuation} hidden={!show && !waiting}
      onTouchStart={event => { touch.current = event.touches[0]?.clientY; }}
      onTouchEnd={event => { const y = event.changedTouches[0]?.clientY; if (touch.current !== undefined && y !== undefined && Math.abs(y - touch.current) > 45) navigate(y > touch.current ? -1 : 1); touch.current = undefined; }}
      onKeyDown={event => {
        if ((event.target as Element).closest('button')) return;
        if (event.key === 'End') { event.preventDefault(); latest(); }
        else if (event.key === 'Home') { event.preventDefault(); setBrowsedId(entries[0]?.id); }
        else if (['ArrowUp', 'ArrowLeft', 'PageUp', 'ArrowDown', 'ArrowRight', 'PageDown'].includes(event.key)) { event.preventDefault(); navigate(['ArrowUp', 'ArrowLeft', 'PageUp'].includes(event.key) ? -1 : 1); }
      }}>
      <div className="cinematic-memory-track">
        {entries.map((item, index) => {
          const layer = captionLayer(index, selectedIndex);
          return <article key={item.id} data-caption-id={item.id} data-focused={layer.focused} data-depth={layer.depth} data-visible={layer.visible} data-behind={index < selectedIndex}
            aria-hidden={!layer.focused} inert={!layer.focused} className={`cinematic-memory-row ${activeId === item.id ? 'is-current' : 'is-memory'}`}
            style={{ '--layer-x': `${layer.x}px`, '--layer-y': `${layer.y}px`, '--layer-scale': layer.scale, '--layer-opacity': layer.opacity,
              '--layer-blur': `${layer.blur}px`, zIndex: layer.z } as CSSProperties}>
            <CinematicDialogue speech={item} primaryLanguage={primaryLanguage} translationLanguage={translationLanguage} textOnly={textOnly}
              active={item.id === speech?.id} show={show} onVisibilityChange={onVisibilityChange}/>
          </article>;
        })}
      </div>
      {waiting && <CompanionWaiting key={state.questions.at(-1)?.id} state={state}/>}
      {show && entries.length > 0 && <nav className="cinematic-stack-navigation" aria-label="浏览对白" aria-busy={loading}>
        {reading && <button type="button" className="cinematic-stack-latest" aria-label="回到最新台词" title="回到最新台词" onClick={latest}>
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 8v5a6 6 0 0 0 12 0V5m-4 4 4-4 4 4"/></svg>
        </button>}
        <button type="button" aria-label="上一句台词" title="上一句台词" disabled={loading || selectedIndex === 0 && !state.historyHasMore} onClick={() => navigate(-1)}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m7 14 5-5 5 5"/></svg></button>
        <button type="button" aria-label="下一句台词" title="下一句台词" disabled={selectedIndex >= entries.length - 1} onClick={() => navigate(1)}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg></button>
      </nav>}
    </div>
    {show && questionText && <aside className="cinematic-question" aria-label="你上一句说的话"><p key={questionText}>{dialogueGlyphs(questionText).map((glyph, index) => <span key={index} className="cinematic-question-glyph" style={{ animationDelay: `${Math.min(index * 14, 560)}ms` }}>{glyph}</span>)}</p></aside>}
  </section>;
}
