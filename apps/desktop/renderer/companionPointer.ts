import { useEffect, type RefObject } from 'react';
import { bridge } from './state';

/** An alpha mask keeps the invisible PNG padding clickable by the desktop below. */
export function useCompanionPointer(root: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    const shell = root.current;
    if (!enabled || !shell) return;
    const masks = new WeakMap<HTMLImageElement, { src: string; width: number; height: number; alpha: Uint8ClampedArray }>();
    let interactive: boolean | undefined, held = false;
    const set = (next: boolean) => { if (interactive !== next) { interactive = next; bridge.setCompanionInteractive(next); } };
    const hitPortrait = (x: number, y: number) => {
      const stage = shell.querySelector('.portrait-stage')?.getBoundingClientRect();
      const image = shell.querySelector<HTMLImageElement>('.portrait-stage img.character');
      if (!stage || !image || x < stage.left || x > stage.right || y < stage.top || y > stage.bottom - 20) return false;
      const bounds = image.getBoundingClientRect();
      if (x < bounds.left || x >= bounds.right || y < bounds.top || y >= bounds.bottom) return false;
      let mask = masks.get(image);
      if ((!mask || mask.src !== image.currentSrc) && image.complete && image.naturalWidth) {
        try {
          const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = Math.round(image.naturalHeight / image.naturalWidth * 160);
          const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
          ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
          mask = { src: image.currentSrc, width: canvas.width, height: canvas.height, alpha: ctx.getImageData(0, 0, canvas.width, canvas.height).data }; masks.set(image, mask);
        } catch { /* Keep the visible portrait accessible if a platform rejects canvas access. */ }
      }
      if (!mask) return true;
      const mx = Math.min(mask.width - 1, Math.floor((x - bounds.left) / bounds.width * mask.width));
      const my = Math.min(mask.height - 1, Math.floor((y - bounds.top) / bounds.height * mask.height));
      return mask.alpha[(my * mask.width + mx) * 4 + 3] > 24;
    };
    const move = (event: MouseEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      set(held || Boolean(target?.closest('[data-companion-interactive]')) || hitPortrait(event.clientX, event.clientY));
    };
    const down = () => { held = true; set(true); };
    const up = (event: MouseEvent) => { held = false; move(event); };
    const leave = () => { if (!held) set(false); };
    const blur = () => { held = false; set(false); };
    const reset = bridge.onEvent(event => { if (['desktop.focus-input', 'desktop.summoned', 'desktop.hidden'].includes(event.type)) interactive = undefined; });
    document.addEventListener('mousemove', move); shell.addEventListener('mousedown', down);
    document.addEventListener('mouseup', up); document.addEventListener('mouseleave', leave);
    window.addEventListener('blur', blur);
    return () => { reset(); window.removeEventListener('blur', blur); document.removeEventListener('mousemove', move); shell.removeEventListener('mousedown', down); document.removeEventListener('mouseup', up); document.removeEventListener('mouseleave', leave); };
  }, [enabled, root]);
}
