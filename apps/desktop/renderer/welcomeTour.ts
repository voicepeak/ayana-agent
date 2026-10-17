/** A narration-relative playhead keeps demonstrations aligned with pause/seek/replay. */
export type TourScene = 'arrival' | 'name' | 'greeting' | 'chat' | 'voice' | 'search' | 'observe' | 'style' | 'ready';
export interface NarrationTiming { duration: number; segments: { start: number; end: number; until: number; zh: string; from: number; to: number }[] }
export function narrationFrame(timing: NarrationTiming, seconds: number) {
  const time = Math.max(0, Math.min(seconds, timing.duration));
  const segment = timing.segments.find(item => time < item.until) || timing.segments[timing.segments.length - 1];
  const mix = Math.max(0, Math.min(1, (time - segment.start) / (segment.until - segment.start)));
  return { caption: segment.zh, progress: segment.from + (segment.to - segment.from) * mix };
}
const clamp = (value: number) => Math.max(0, Math.min(1, value));
export function typed(text: string, progress: number, start: number, end: number) {
  const letters = Array.from(text);
  return letters.slice(0, Math.floor(letters.length * clamp((progress - start) / (end - start)))).join('');
}
