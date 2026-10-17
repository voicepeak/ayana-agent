/** The reel scrolls freely; anchoring centers one sentence without moving layout. */
export function captionAnchor(offsetTop: number, offsetHeight: number, viewportHeight: number) {
  return Math.max(0, offsetTop + offsetHeight / 2 - viewportHeight / 2);
}

export function captionStep(index: number, direction: number, count: number) {
  return Math.max(0, Math.min(Math.max(0, count - 1), index + Math.sign(direction)));
}

/** A damped spring keeps wheel scrolling continuous instead of stepping card by card. */
export function captionSpring(current: number, target: number, velocity: number, dt: number, stiffness = 210, damping = 30) {
  const nextVelocity = (velocity + (target - current) * stiffness * dt) * Math.exp(-damping * dt);
  const value = current + nextVelocity * dt;
  const settled = Math.abs(target - value) < .4 && Math.abs(nextVelocity) < 3;
  return { value, velocity: nextVelocity, settled };
}
