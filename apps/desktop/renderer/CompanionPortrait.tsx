import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { Character } from './components';
import type { CompanionDesign } from './CompanionDesign';
import { portraitLayout } from './portraitGeometry';
import type { PortraitScene } from './captionLayout';

export function CompanionPortrait({ design, expression, motion, connected, onChange, onCommit, onClick, onSceneChange, bottomInset = 0 }: {
  design: CompanionDesign; expression: string; motion: boolean; connected: boolean;
  onChange: (patch: Partial<CompanionDesign>) => void;
  onCommit: (patch: Partial<CompanionDesign>) => void; onClick: () => void;
  onSceneChange: (scene: PortraitScene) => void; bottomInset?: number;
}) {
  const canvas = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [area, setArea] = useState({ width: 1, height: 1 });
  const [aspect, setAspect] = useState(472 / 1656);
  const [dragging, setDragging] = useState(false);
  const layout = portraitLayout(area, aspect, design);
  useLayoutEffect(() => { onSceneChange({ area, portrait: layout, dragging }); },
    [area.width, area.height, layout.x, layout.y, layout.width, layout.height, dragging, onSceneChange]);
  const latest = useRef({ layout, design, onChange, onCommit });
  latest.current = { layout, design, onChange, onCommit };
  const gesture = useRef<{ id: number; clientX: number; clientY: number; x: number; y: number;
    moved: boolean; patch?: Partial<CompanionDesign> } | null>(null);
  const suppressClick = useRef(false);
  useLayoutEffect(() => {
    const node = canvas.current!;
    const observer = new ResizeObserver(() => setArea({ width: node.clientWidth, height: node.clientHeight }));
    observer.observe(node); return () => observer.disconnect();
  }, []);
  const finish = () => {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    suppressClick.current = current.moved;
    setDragging(false);
    if (button.current?.hasPointerCapture(current.id)) button.current.releasePointerCapture(current.id);
    if (current.patch) latest.current.onCommit(current.patch);
  };
  const finishRef = useRef(finish); finishRef.current = finish;
  useEffect(() => {
    const stop = () => finishRef.current();
    window.addEventListener('blur', stop);
    return () => { window.removeEventListener('blur', stop); stop(); };
  }, []);
  function move(event: PointerEvent<HTMLButtonElement>) {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    if (!(event.buttons & 1)) { finish(); return; }
    event.preventDefault(); event.stopPropagation();
    const dx = event.clientX - current.clientX, dy = event.clientY - current.clientY;
    if (!current.moved && Math.hypot(dx, dy) < 4) return;
    current.moved = true; setDragging(true);
    const next = portraitLayout(area, aspect, { ...design, portrait_x: current.x + dx - layout.anchorX, portrait_y: current.y + dy });
    current.patch = { portrait_x: Math.round(next.x - next.anchorX), portrait_y: Math.round(next.y) };
    onChange(current.patch);
  }
  return <div ref={canvas} className="portrait-canvas" aria-label="立绘位置预览"
    style={{ clipPath: bottomInset ? `inset(0 0 ${bottomInset}px 0)` : undefined }}>
    <button ref={button} className="portrait-stage" type="button" data-dragging={dragging}
      aria-label="彩名：拖动调整框内位置，点击输入，右键操作"
      style={{ left: layout.x, top: layout.y, width: layout.width, height: layout.height }}
      onPointerDown={event => {
        if (event.button !== 0 || gesture.current) return;
        event.preventDefault(); event.stopPropagation(); suppressClick.current = false;
        gesture.current = { id: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: layout.x, y: layout.y, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={move} onPointerUp={event => { move(event); finish(); }}
      onPointerCancel={finish} onLostPointerCapture={finish} onDragStart={event => event.preventDefault()}
      onClick={event => { if (suppressClick.current) { event.preventDefault(); suppressClick.current = false; } else onClick(); }}>
      <div className="portrait-position"><div className="portrait-reveal">
        <Character key={String(connected)} expression={expression} motion={motion}
          onDimensions={(width, height) => setAspect(width / height)}/>
      </div></div>
    </button>
  </div>;
}
