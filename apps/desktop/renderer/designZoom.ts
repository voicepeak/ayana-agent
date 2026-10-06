/** Normalize mouse and trackpad wheels, and bound both scaling directions. */
export function wheelZoom(value: number, delta: number, mode: number, minimum: number, maximum: number) {
  const pixels = delta * (mode === 1 ? 16 : mode === 2 ? 240 : 1);
  if (!Number.isFinite(pixels) || !pixels) return value;
  return Math.round(Math.max(minimum, Math.min(maximum, value * Math.exp(-Math.max(-240, Math.min(240, pixels)) * .0015))));
}
