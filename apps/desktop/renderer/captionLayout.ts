import type { PortraitLayout } from './portraitGeometry';

export interface PortraitScene {
  area: { width: number; height: number };
  portrait: PortraitLayout;
  dragging: boolean;
}
export interface CaptionLayout {
  mode: 'left' | 'right';
  x: number; y: number; width: number; height: number;
  portraitBottomInset: number;
}

/** Prefer free space beside the drawing; narrow scenes retain a side column. */
export function captionLayout(scene: PortraitScene, fontSize: number): CaptionLayout {
  const { area, portrait } = scene;
  const width = Math.max(1, area.width), height = Math.max(1, area.height);
  const margin = Math.min(16, width / 12), gap = 16;
  const left = Math.max(0, portrait.x - gap - margin);
  const rightX = Math.min(width, portrait.x + portrait.width + gap);
  const right = Math.max(0, width - margin - rightX);
  const minimum = Math.max(240, fontSize * 11);
  if (Math.max(left, right) >= minimum) {
    const mode = left >= right ? 'left' : 'right';
    return { mode, x: mode === 'left' ? margin : rightX, y: 10,
      width: mode === 'left' ? left : right, height: Math.max(1, height - 22), portraitBottomInset: 0 };
  }
  const mode = left >= right ? 'left' : 'right';
  const column = Math.max(1, Math.min(width - margin * 2, width * .56));
  return { mode, x: mode === 'left' ? margin : width - margin - column, y: Math.min(10, height / 8),
    width: column, height: Math.max(1, height - Math.min(22, height / 4)), portraitBottomInset: 0 };
}
