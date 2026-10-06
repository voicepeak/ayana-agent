import { useEffect, useMemo, useRef, useState } from 'react';
import type { Speech } from './state';
import { dialoguePages, dialoguePageAt, dialogueRevealCount, dialogueRevealDuration } from './cinematic';

export function CinematicDialogue({ speech, translate, textOnly, show = true, showJapanese = false, onVisibilityChange }: { speech?: Speech; translate: boolean; textOnly: boolean; show?: boolean; showJapanese?: boolean; onVisibilityChange?: (visible: boolean) => void }) {
  const ref = useRef<HTMLElement>(null);
  const [columns, setColumns] = useState(14);
  const [originalColumns, setOriginalColumns] = useState(26);
  const [elapsed, setElapsed] = useState(0);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const text = speech ? (translate ? speech.zh || speech.ja : speech.ja) : '';
  const timed = textOnly || speech?.audioEnabled === false;
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(media.matches);
    media.addEventListener('change', change); return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const resize = () => {
      const style = getComputedStyle(node);
      const width = node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      setColumns(Math.max(4, Math.min(26, Math.floor(width / (parseFloat(style.fontSize) * 1.06)))));
      setOriginalColumns(Math.max(4, Math.floor(width / (12 * 1.04))));
    };
    const observer = new ResizeObserver(resize); observer.observe(node); resize();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setElapsed(0);
    if (!text || !timed) return;
    const started = performance.now();
    const duration = dialogueRevealDuration(text);
    const interval = setInterval(() => {
      const next = Math.min(performance.now() - started, duration);
      setElapsed(next);
      if (next >= duration) clearInterval(interval);
    }, 45);
    return () => clearInterval(interval);
  }, [speech?.id, text, timed]);
  const count = dialogueRevealCount(text, timed ? elapsed / dialogueRevealDuration(text) : speech?.state === 'played' ? 1 : (speech?.total ? speech.played / speech.total : 0));
  const pages = useMemo(() => dialoguePages(text, columns), [text, columns]);
  const page = dialoguePageAt(pages, count);
  const visible = Boolean(show && speech && text && page);
  useEffect(() => { onVisibilityChange?.(visible); }, [visible, onVisibilityChange]);
  const original = showJapanese && translate && speech?.zh ? speech.ja : '';
  const originalCount = dialogueRevealCount(original, timed ? elapsed / dialogueRevealDuration(text) : speech?.state === 'played' ? 1 : (speech?.total ? speech.played / speech.total : 0));
  const originalPage = dialoguePageAt(dialoguePages(original, originalColumns), originalCount);
  return <section ref={ref} className="cinematic-dialogue" aria-label="彩名的台词" lang={translate && speech?.zh ? 'zh-CN' : 'ja'}>
    {visible && page && <>
      <span className="cinematic-accessible" aria-live="polite">{page.lines.map(line => line.map(glyph => glyph.value).join('')).join('\n')}</span>
      <div key={`${speech!.id}:${text}:${page.start}`} className="cinematic-shot" aria-hidden="true">
        {page.lines.map((line, row) => <p key={row}>{line.map(glyph => <span key={glyph.index} className={`cinematic-glyph ${reduced || glyph.index < count ? 'is-shown' : ''}`}>{glyph.value}</span>)}</p>)}
      </div>
      {originalPage && <p className="cinematic-original" lang="ja">{originalPage.lines.map(line => line.filter(glyph => glyph.index < originalCount).map(glyph => glyph.value).join('')).join('\n')}</p>}
    </>}
  </section>;
}
