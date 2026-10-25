import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';

/** Release screen locks after playback; reacquire when returning from background. */
export function usePlaybackWake(active: boolean) {
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let acquiring = false;
    let release: (() => void) | undefined;
    const acquire = async () => {
      if (disposed || acquiring || document.visibilityState !== 'visible') return;
      acquiring = true;
      try {
        release?.(); release = undefined;
        if (Capacitor.isNativePlatform()) {
          const { KeepAwake } = await import('@capacitor-community/keep-awake');
          if (disposed) return;
          await KeepAwake.keepAwake();
          release = () => { void KeepAwake.allowSleep().catch(() => {}); };
        } else if ('wakeLock' in navigator) {
          const lock = await navigator.wakeLock.request('screen');
          release = () => { void lock.release().catch(() => {}); };
        }
        if (disposed) release?.();
      } finally { acquiring = false; }
    };
    const visible = () => { void acquire().catch(() => {}); };
    visible();
    document.addEventListener('visibilitychange', visible);
    return () => { disposed = true; release?.(); document.removeEventListener('visibilitychange', visible); };
  }, [active]);
}
