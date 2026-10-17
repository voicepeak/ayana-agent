import { useEffect, useRef } from 'react';

interface Mote {
  x: number; y: number; r: number; speed: number; drift: number; phase: number; alpha: number;
}

export function WelcomeAtmosphere({ layer, paused = false }: { layer: 'back' | 'front'; paused?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const host = canvas.closest('.welcome') as HTMLElement | null;
    const front = layer === 'front';
    let width = 0;
    let height = 0;
    let frame = 0;
    let last = 0;
    let motes: Mote[] = [];
    let lookX = 0;
    let lookY = 0;
    let targetX = 0;
    let targetY = 0;
    const sprite = document.createElement('canvas');
    sprite.width = sprite.height = 96;
    const paint = sprite.getContext('2d')!;
    const glow = paint.createRadialGradient(48, 48, 0, 48, 48, 48);
    glow.addColorStop(0, 'rgba(236,243,255,.95)');
    glow.addColorStop(.25, 'rgba(208,224,250,.4)');
    glow.addColorStop(.62, 'rgba(180,205,245,.09)');
    glow.addColorStop(1, 'rgba(170,195,240,0)');
    paint.fillStyle = glow;
    paint.fillRect(0, 0, 96, 96);
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = front
        ? Math.round(Math.min(13, Math.max(5, width * height / 230000)))
        : Math.round(Math.min(36, Math.max(16, width * height / 54000)));
      motes = Array.from({ length: count }, () => front ? {
        x: Math.random() * width, y: Math.random() * height,
        r: 5 + Math.random() * 10, speed: 3 + Math.random() * 6, drift: 16 + Math.random() * 36,
        phase: Math.random() * Math.PI * 2, alpha: .022 + Math.random() * .045,
      } : {
        x: Math.random() * width, y: Math.random() * height,
        r: .7 + Math.random() * 1.7, speed: 1.2 + Math.random() * 3.2, drift: 6 + Math.random() * 24,
        phase: Math.random() * Math.PI * 2, alpha: .03 + Math.random() * .12,
      });
    };
    const draw = (time: number) => {
      frame = requestAnimationFrame(draw);
      if (!last) last = time;
      if (time - last < 32) return;
      const delta = Math.min(64, time - last);
      last = time;
      if (pausedRef.current || document.hidden) return;
      lookX += (targetX - lookX) * .035;
      lookY += (targetY - lookY) * .035;
      if (host) {
        host.style.setProperty('--look-x', lookX.toFixed(3));
        host.style.setProperty('--look-y', lookY.toFixed(3));
      }
      context.clearRect(0, 0, width, height);
      context.globalCompositeOperation = 'lighter';
      for (const mote of motes) {
        mote.y -= mote.speed * delta / 1000;
        if (mote.y < -mote.r * 3) {
          mote.y = height + mote.r * 3;
          mote.x = Math.random() * width;
        }
        const x = mote.x + Math.sin(time * .00004 + mote.phase) * mote.drift + (front ? lookX * 20 : lookX * 8);
        const y = mote.y + (front ? lookY * 14 : lookY * 5);
        const size = mote.r * 4.2;
        context.globalAlpha = mote.alpha;
        context.drawImage(sprite, x - size / 2, y - size / 2, size, size);
      }
      context.globalAlpha = 1;
    };
    const move = (event: PointerEvent) => {
      targetX = (event.clientX / Math.max(1, width) - .5) * 2;
      targetY = (event.clientY / Math.max(1, height) - .5) * 2;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    window.addEventListener('pointermove', move, { passive: true });
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('pointermove', move);
    };
  }, [layer]);
  return <canvas ref={canvasRef} className={`welcome-dust welcome-dust-${layer}`} aria-hidden="true"/>;
}
