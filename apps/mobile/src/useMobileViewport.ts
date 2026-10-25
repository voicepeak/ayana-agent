import { useEffect } from 'react';

/** Keep the composer above the keyboard, including iOS's panned visual viewport. */
export function useMobileViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => {
      // Pinch zoom must remain available without resizing the application around it.
      if (viewport && Math.abs(viewport.scale - 1) > .05) return;
      document.documentElement.style.setProperty('--app-height', `${viewport?.height || innerHeight}px`);
      document.documentElement.style.setProperty('--viewport-top', `${viewport?.offsetTop || 0}px`);
      document.documentElement.classList.toggle('keyboard-open', Boolean(viewport && innerHeight - viewport.height > 120));
    };
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);
}
