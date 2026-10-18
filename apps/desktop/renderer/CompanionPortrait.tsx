import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { Character } from './components';
import type { CompanionDesign } from './CompanionDesign';
import { portraitLayout, portraitSlotAspect } from './portraitGeometry';
import type { PortraitScene } from './captionLayout';
import { wheelZoom } from './designZoom';
import { subscribeAudioLevel } from './audioLevel';

export function CompanionPortrait({ design, expression, motion, bounce = true, connected, editable, onChange, onCommit, onClick, onSceneChange, bottomInset = 0, aspect = portraitSlotAspect, interactionScale = 1, character }: {
  design: CompanionDesign; expression: string; motion: boolean; bounce?: boolean; connected: boolean;
  editable: boolean; aspect?: number; interactionScale?: number; character?: string;
  onChange: (patch: Partial<CompanionDesign>) => void;
  onCommit: (patch: Partial<CompanionDesign>) => void; onClick: () => void;
  onSceneChange: (scene: PortraitScene) => void; bottomInset?: number;
}) {
  const canvas = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const squash = useRef<HTMLDivElement>(null);
  const spring = useRef({ value: 0, velocity: 0, target: 0, impulse: 0 });
  const previousExpression = useRef(expression);
  const [area, setArea] = useState({ width: 1, height: 1 });
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
  useEffect(() => { if (!editable) finishRef.current(); }, [editable]);
  useEffect(() => {
    if (!editable) return;
    const node = button.current!;
    const zoom = (event: WheelEvent) => {
      if (!event.deltaY || gesture.current) return;
      event.preventDefault(); event.stopPropagation();
      const current = latest.current;
      const portrait_size = wheelZoom(current.design.portrait_size, event.deltaY, event.deltaMode, 160, 640);
      if (portrait_size === current.design.portrait_size) return;
      latest.current = { ...current, design: { ...current.design, portrait_size } };
      current.onChange({ portrait_size });
    };
    node.addEventListener('wheel', zoom, { passive: false });
    return () => node.removeEventListener('wheel', zoom);
  }, [editable]);
  useEffect(() => {
    const stop = () => finishRef.current();
    window.addEventListener('blur', stop);
    return () => { window.removeEventListener('blur', stop); stop(); };
  }, []);
  useEffect(() => {
    const node = squash.current;
    if (!node || !bounce || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      if (node) node.style.transform = '';
      spring.current = { value: 0, velocity: 0, target: 0, impulse: 0 };
      return;
    }
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(.05, Math.max(.001, (now - last) / 1000));
      last = now;
      const state = spring.current;
      const target = state.target + state.impulse;
      const force = (target - state.value) * 460 - state.velocity * 14;
      state.velocity += force * dt;
      state.value = Math.max(-.12, Math.min(.18, state.value + state.velocity * dt));
      state.impulse *= Math.exp(-dt * 8);
      if (Math.abs(state.value) < .0004 && Math.abs(state.velocity) < .0004) {
        state.value = 0; state.velocity = 0;
      }
      node.style.transform = `scale(${(1 + state.value).toFixed(4)}, ${(1 - state.value * .82).toFixed(4)})`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [bounce]);
  useEffect(() => {
    if (!bounce || editable) {
      spring.current.target = 0;
      return;
    }
    let previous = 0;
    return subscribeAudioLevel(level => {
      const jump = level - previous;
      previous = level;
      spring.current.target = level * .04;
      if (jump > .06) {
        spring.current.impulse = Math.min(.16, spring.current.impulse + jump * .12);
      }
    });
  }, [bounce, editable]);
  useEffect(() => {
    if (previousExpression.current !== expression && bounce && motion && !editable
        && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      spring.current.impulse += .1;
    }
    previousExpression.current = expression;
  }, [expression, bounce, motion, editable]);
  function move(event: PointerEvent<HTMLButtonElement>) {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    if (!(event.buttons & 1)) { finish(); return; }
    event.preventDefault(); event.stopPropagation();
    const clientDx = event.clientX - current.clientX, clientDy = event.clientY - current.clientY;
    if (!current.moved && Math.hypot(clientDx, clientDy) < 4) return;
    const dx = clientDx / Math.max(.01, interactionScale), dy = clientDy / Math.max(.01, interactionScale);
    current.moved = true; setDragging(true);
    const next = portraitLayout(area, aspect, { ...design, portrait_x: current.x + dx - layout.anchorX, portrait_y: current.y + dy });
    current.patch = { portrait_x: Math.round(next.x - next.anchorX), portrait_y: Math.round(next.y) };
    onChange(current.patch);
  }
  return <div ref={canvas} className="portrait-canvas" aria-label="立绘位置预览"
    style={{ clipPath: bottomInset ? `inset(0 0 ${bottomInset}px 0)` : undefined }}>
    <button ref={button} className="portrait-stage" type="button" data-dragging={dragging} data-editable={editable}
      aria-label={editable ? '彩名：拖动调整框内位置，点击输入，右键操作' : '彩名：点击输入，右键操作'}
      style={{ left: layout.x, top: layout.y, width: layout.width, height: layout.height }}
      onPointerDown={event => {
        if (!editable || event.button !== 0 || gesture.current) return;
        event.preventDefault(); event.stopPropagation(); suppressClick.current = false;
        gesture.current = { id: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: layout.x, y: layout.y, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={move} onPointerUp={event => { move(event); finish(); }}
      onPointerCancel={finish} onLostPointerCapture={finish} onDragStart={event => event.preventDefault()}
      onClick={event => {
        if (suppressClick.current) { event.preventDefault(); suppressClick.current = false; return; }
        if (bounce && !matchMedia('(prefers-reduced-motion: reduce)').matches) spring.current.impulse += .14;
        onClick();
      }}>
      <div className="portrait-position"><div className="portrait-reveal">
        <div ref={squash} className="portrait-squash"><Character key={String(connected)} expression={expression} motion={motion} character={character}/></div>
      </div></div>
      {editable && <span className="portrait-position-hint">{dragging ? '气泡实时跟随' : '拖动移动 · 滚轮缩放'}</span>}
    </button>
  </div>;
}
