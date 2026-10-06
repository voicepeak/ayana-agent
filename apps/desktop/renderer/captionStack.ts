/** Neighbouring sentences occupy the same stage, receding into its depth. */
export function captionLayer(index: number, selected: number) {
  const offset = index - selected, depth = Math.abs(offset);
  const visible = offset >= -2 && offset <= 0;
  return { visible, focused: offset === 0, depth, z: offset === 0 ? 40 : 30 - depth,
    x: 0,
    y: offset < 0 ? -Math.min(depth, 3) * 14 : offset > 0 ? 38 : 0,
    scale: offset === 0 ? 1 : 1 - Math.min(depth, 3) * .045,
    opacity: visible ? 1 : 0,
    blur: 0 };
}

export function captionStep(index: number, direction: number, count: number) {
  return Math.max(0, Math.min(Math.max(0, count - 1), index + Math.sign(direction)));
}
