type AudioLevelListener = (level: number) => void;

const listeners = new Set<AudioLevelListener>();
let current = 0;

export function publishAudioLevel(level: number) {
  current = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
  for (const listener of listeners) listener(current);
}

export function subscribeAudioLevel(listener: AudioLevelListener) {
  listeners.add(listener);
  listener(current);
  return () => { listeners.delete(listener); };
}

export function resetAudioLevel() {
  publishAudioLevel(0);
}
