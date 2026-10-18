import { useEffect, useState } from 'react';

export interface WelcomeLine { id: number; text: string }

/** Text remains available with audio muted; a new line cancels the previous typewriter. */
export function WelcomeCaption({ line }: { line: WelcomeLine | null }) {
  const [typed, setTyped] = useState({ id: 0, count: 0 });
  useEffect(() => {
    setTyped({ id: line?.id || 0, count: 0 });
    if (!line) return;
    const letters = [...line.text];
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setTyped({ id: line.id, count: letters.length }); return; }
    let shown = 0;
    const clock = window.setInterval(() => {
      shown++; setTyped({ id: line.id, count: shown });
      if (shown >= letters.length) window.clearInterval(clock);
    }, 48);
    return () => window.clearInterval(clock);
  }, [line?.id]);
  return <p className="mg-character-caption" data-visible={!!line} role="status" aria-label={line?.text || undefined}>
    <span aria-hidden="true">{line ? [...line.text].slice(0, typed.id === line.id ? typed.count : 0).join('') : '\u00a0'}</span>
  </p>;
}
