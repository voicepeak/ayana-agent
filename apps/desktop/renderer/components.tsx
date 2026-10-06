import { useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import {
  cn, kunVariantClasses, kunRoundedClasses, kunFocusRingClasses, kunControlSizeClasses,
  type KunUIColor, type KunUIVariant,
} from '@kungal/ui-core';
import avatarCatalog from '../../../characters/ayana/avatar-map.json';

const avatarAssets: Record<string, { costume: string }> = avatarCatalog.assets;

export function Button({ color = 'default', variant = 'flat', className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { color?: KunUIColor; variant?: KunUIVariant }) {
  return <button className={cn('kun-button', kunVariantClasses(variant, color), kunRoundedClasses.md, kunFocusRingClasses[color], kunControlSizeClasses.sm, className)} {...props}>{children}</button>;
}
export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn('kun-input', kunRoundedClasses.md, kunFocusRingClasses.primary, className)} {...props} />;
}
export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    sparkles: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/><path d="m20 2 .5 1.5L22 4l-1.5.5L20 6l-.5-1.5L18 4l1.5-.5Z"/></>,
    message: <path d="M21 11a8 8 0 0 1-8 8H7l-5 3 1.7-5.5A8 8 0 1 1 21 11Z"/>,
    folder: <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>,
    monitor: <><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/></>,
    history: <><path d="M3 11a9 9 0 1 1 2 7M3 3v8h8"/><path d="M12 7v5l4 2"/></>,
    settings: <><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></>,
    arrow: <><path d="M5 12h14m-6-6 6 6-6 6"/></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2"/>,
    refresh: <><path d="M20 11a8 8 0 0 0-14-5L3 9m0-6v6h6M4 13a8 8 0 0 0 14 5l3-3m0 6v-6h-6"/></>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8m-8 4h5"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>,
    close: <path d="m6 6 12 12M6 18 18 6"/>,
    volume: <><path d="m11 4-6 5H2v6h3l6 5ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></>,
    book: <><path d="M12 5c-3-3-7-3-10-2v16c3-1 7-1 10 2 3-3 7-3 10-2V3c-3-1-7-1-10 2Zm0 0v16"/></>,
    keyboard: <><rect x="2" y="5" width="20" height="14" rx="3"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M7 16h10"/></>,
    mic: <><rect x="8" y="2" width="8" height="13" rx="4"/><path d="M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3m-4 0h8"/></>,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name] || paths.sparkles}</svg>;
}

export function Character({ expression = 'neutral', className = '', motion = true }: { expression?: string; className?: string; motion?: boolean }) {
  const [loaded, setLoaded] = useState('neutral');
  const [missing, setMissing] = useState(false);
  const previous = useRef<string | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const figure = useRef<HTMLDivElement>(null);
  const shimmer = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const changingCostume = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const animations: Animation[] = [];
    changingCostume.current = false;
    const next = new Image();
    next.crossOrigin = 'anonymous';
    next.onload = async () => {
      if (cancelled) return;
      const oldCostume = avatarAssets[loadedRef.current]?.costume;
      const newCostume = avatarAssets[expression]?.costume;
      const costumeChanged = oldCostume && newCostume && oldCostume !== newCostume;
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      // Preload first, then hide the old portrait in the light before revealing the new one.
      if (costumeChanged && !reduced && figure.current && shimmer.current) {
        changingCostume.current = true;
        const glow = shimmer.current.animate([
          { opacity: 0, transform: 'scale(.88)' },
          { opacity: 1, transform: 'scale(1)', offset: .3 },
          { opacity: .65, transform: 'scale(1.05)', offset: .55 },
          { opacity: 0, transform: 'scale(1.16)' },
        ], { duration: 900, easing: 'ease-out' });
        const fade = figure.current.animate([
          { opacity: 1, filter: 'brightness(1)' },
          { opacity: 0, filter: 'brightness(1.8)' },
        ], { duration: 260, fill: 'forwards', easing: 'ease-in' });
        animations.push(glow, fade);
        try { await fade.finished; } catch { return; }
        if (cancelled) return;
        setLoaded(expression);
        setMissing(false);
        const reveal = figure.current.animate([
          { opacity: 0, filter: 'brightness(1.5)' },
          { opacity: 1, filter: 'brightness(1)' },
        ], { duration: 540, fill: 'backwards', easing: 'ease-out' });
        animations.push(reveal);
        fade.cancel();
      } else {
        setLoaded(expression);
        setMissing(false);
      }
    };
    next.onerror = () => { if (!cancelled && expression === 'neutral') setMissing(true); };
    next.src = `ayana-asset://${expression}/`;
    return () => { cancelled = true; animations.forEach(animation => animation.cancel()); };
  }, [expression]);
  useEffect(() => {
    // Only dip when the visible face actually changes, not on every sentence.
    const changed = previous.current !== null && previous.current !== loaded;
    previous.current = loaded;
    if (!changed || changingCostume.current || !motion || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const animation = frame.current?.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(12px)', offset: .35 }, { transform: 'translateY(0)' }], { duration: 300, easing: 'ease-out' });
    return () => animation?.cancel();
  }, [loaded, motion]);
  return <div ref={frame} className={cn('character-frame', className)}>
    <div ref={figure} className="character-figure">{missing ? <span className="asset-missing">立绘加载中，请在设置中检查素材</span> : <img className="character" crossOrigin="anonymous" src={`ayana-asset://${loaded}/`} alt="Ayana 半身立绘" draggable={false} />}</div>
    <div ref={shimmer} className="costume-shimmer" aria-hidden="true"><i/><i/><i/><i/><i/></div>
  </div>;
}
