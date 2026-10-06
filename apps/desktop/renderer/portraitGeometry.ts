export interface PortraitLayout { x: number; y: number; width: number; height: number; anchorX: number }

/** Full-body source; 100% frames the character at the knees (72% of its height). */
export function portraitLayout(area: { width: number; height: number }, aspect: number,
  design: { portrait_size: number; portrait_side: 'left' | 'right'; portrait_x: number; portrait_y: number }): PortraitLayout {
  const height = Math.max(1, area.height) / .72 * design.portrait_size / 320;
  const width = Math.min(Math.max(1, area.width), height * aspect);
  const anchorX = area.width * (design.portrait_side === 'left' ? .22 : .78) - width / 2;
  return {
    width, height, anchorX,
    x: Math.max(0, Math.min(area.width - width, anchorX + design.portrait_x)),
    // Larger drawings can be moved up to reveal their feet, or down within the clipped scene.
    y: Math.max(Math.min(0, area.height - height), Math.min(Math.max(0, area.height - Math.min(height, 96)), design.portrait_y)),
  };
}
