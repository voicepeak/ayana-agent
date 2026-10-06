import type { PortraitLayout } from './portraitGeometry';

export interface PortraitScene {
  area: { width: number; height: number };
  portrait: PortraitLayout;
  dragging: boolean;
}
export interface CaptionLayout {
  mode: 'left' | 'right' | 'bottom';
  x: number; y: number; width: number; height: number;
  portraitBottomInset: number;
}

/** Keep captions outside the visible drawing, without changing its saved position. */
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
  const bandHeight = Math.min(height - 8, Math.max(130, Math.min(252, height * .48)));
  return { mode: 'bottom', x: margin, y: Math.max(0, height - bandHeight - 8),
    width: Math.max(1, width - margin * 2), height: Math.max(1, bandHeight),
    portraitBottomInset: Math.min(height, bandHeight + 20) };
}
