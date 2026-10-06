import { useEffect, useRef, type PointerEvent } from 'react';
import { bridge } from './state';

/** Native cursor coordinates own movement, independent of the moving DOM. */
export function useCompanionDrag(enabled: boolean) {
  const gesture = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const stop = () => { bridge.endCompanionDrag(); };
    window.addEventListener('blur', stop);
    return () => { stop(); window.removeEventListener('blur', stop); };
  }, [enabled]);
  const end = (event: PointerEvent<HTMLElement>) => {
    bridge.endCompanionDrag();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return {
    handlers: {
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        if (!enabled || event.button !== 0) return;
        const control = (event.target as Element).closest('button, input, textarea, select, a');
        if (control && control !== event.currentTarget) return;
        event.preventDefault();
        gesture.current = { x: event.screenX, y: event.screenY, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
        bridge.beginCompanionDrag();
      },
      onPointerMove: (event: PointerEvent<HTMLElement>) => {
        const current = gesture.current;
        if (current && event.currentTarget.hasPointerCapture(event.pointerId)
          && Math.hypot(event.screenX - current.x, event.screenY - current.y) >= 4) current.moved = true;
      },
      onPointerUp: end,
      onPointerCancel: (event: PointerEvent<HTMLElement>) => { end(event); gesture.current = null; },
      onLostPointerCapture: () => bridge.endCompanionDrag(),
    },
    consumeClick: () => { const moved = gesture.current?.moved; gesture.current = null; return Boolean(moved); },
  };
}
