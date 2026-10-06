export interface Point { x: number; y: number }
export interface Bounds extends Point { width: number; height: number }

export function clampCompanion(bounds: Bounds, work: Bounds): Bounds {
  return { ...bounds,
    x: Math.round(Math.max(work.x, Math.min(work.x + work.width - bounds.width, bounds.x))),
    y: Math.round(Math.max(work.y, Math.min(work.y + work.height - bounds.height, bounds.y))),
  };
}

export function companionSize(design: { frame_width: number; frame_height: number }, work: Bounds) {
  // The native window hugs the card; leave room to move it on smaller screens.
  return {
    width: Math.min(design.frame_width + 24, Math.max(240, work.width - 32)),
    height: Math.min(design.frame_height + 24, Math.max(200, Math.round(work.height * .82)), Math.max(200, work.height - 32)),
  };
}

export function companionDragBounds(origin: Bounds, start: Point, cursor: Point, work: Bounds) {
  return clampCompanion({ ...origin, x: origin.x + cursor.x - start.x, y: origin.y + cursor.y - start.y }, work);
}

export function inspectorBounds(card: Bounds, work: Bounds): Bounds {
  const width = Math.min(336, work.width - 24), height = Math.min(600, work.height - 32);
  const left = card.x - width - 10, right = card.x + card.width + 10;
  // The appearance button is at the left of the card's header.
  const x = left >= work.x + 8 ? left : right + width <= work.x + work.width - 8 ? right : card.x + 12;
  return clampCompanion({ x, y: card.y + 12, width, height }, work);
}
