import { useEffect, useRef, type RefObject } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import type { Chapter } from './WelcomeMotion';

gsap.registerPlugin(useGSAP);

/** A different assembly for each demo, started only after the full-window cut. */
export function useWelcomeEntrance(root: RefObject<HTMLElement | null>, chapter: Chapter, run: number, active: boolean, transitioning: boolean, beat: () => void, sceneKey = '') {
  const timeline = useRef<gsap.core.Timeline | null>(null);
  const beatRef = useRef(beat); beatRef.current = beat;
  useGSAP(() => {
    const scene = root.current?.querySelector<HTMLElement>('.mg-scene');
    if (!scene || !active) return;
    scene.dataset.choreographed = 'true'; scene.dataset.entrance = 'armed';
    const q = gsap.utils.selector(scene);
    const match = gsap.matchMedia();
    match.add({ reduce: '(prefers-reduced-motion: reduce)', animate: '(prefers-reduced-motion: no-preference)' }, context => {
      if (context.conditions?.reduce) { scene.dataset.entrance = 'done'; timeline.current = null; return; }
      const tl = gsap.timeline({ paused: true, defaults: { duration: .65, ease: 'power3.out' },
        onStart: () => { scene.dataset.entrance = 'playing'; },
        onComplete: () => { scene.dataset.entrance = 'done'; },
      });
      timeline.current = tl;
      // Title lines roll out of their own masks before the controls arrive.
      tl.fromTo(q('.mg-title-line-inner'), { yPercent: 115, rotation: 5, transformOrigin: '0% 100%' }, { yPercent: 0, rotation: 0, stagger: .085, duration: .72 }, 0);
      if (q('.mg-character-stamp').length) tl.fromTo(q('.mg-character-stamp'), { y: 80, rotation: -18, scale: .3, autoAlpha: 0 }, { y: 0, rotation: -5, scale: 1, autoAlpha: 1, duration: .8, ease: 'back.out(2)' }, .35);
      const stamp = (at: number) => tl.call(() => beatRef.current(), [], at);
      if (chapter === 'meet') {
        tl.fromTo(q('.mg-portrait'), { x: 200, y: -90, rotation: 16, scale: 1.18, autoAlpha: 0 }, { x: 0, y: 0, rotation: -4, scale: 1, autoAlpha: 1, duration: .65, ease: 'power3.in' }, .08)
          .to(q('.mg-portrait'), { rotation: 1.6, y: 7, duration: .16, ease: 'power1.out' }, .73)
          .to(q('.mg-portrait'), { rotation: 0, y: 0, duration: .3, ease: 'back.out(2)' }, .89);
        if (q('.mg-name').length) tl.fromTo(q('.mg-name'), { scaleX: .05, transformOrigin: '0% 50%', autoAlpha: 0 }, { scaleX: 1, autoAlpha: 1, duration: .55, ease: 'back.out(1.5)' }, .48);
        stamp(.75);
      } else if (chapter === 'chat') {
        tl.fromTo(q('.mg-note'), { x: 240, y: -140, rotation: 13, scale: 1.13, autoAlpha: 0 }, { x: 0, y: 12, rotation: -3, scale: 1, autoAlpha: 1, duration: .6, ease: 'power3.inOut' }, .12)
          .to(q('.mg-note'), { y: -6, rotation: 1, duration: .18 }, .72)
          .to(q('.mg-note'), { y: 0, rotation: 0, duration: .28, ease: 'back.out(2)' }, .9)
          .fromTo(q('.mg-note-top'), { clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)', duration: .45 }, .58)
          .fromTo(q('.mg-composer'), { y: 65 }, { y: 0, duration: .5, ease: 'back.out(1.8)' }, .7)
          .fromTo(q('.mg-send'), { rotation: -130, scale: .25 }, { rotation: 0, scale: 1, duration: .5, ease: 'back.out(2)' }, .89);
        stamp(.73); stamp(.95);
      } else if (chapter === 'voice') {
        tl.fromTo(q('.mg-shortcut-editor'), { rotationX: -65, y: -55, autoAlpha: 0, transformPerspective: 800 }, { rotationX: 0, y: 0, autoAlpha: 1, duration: .65, ease: 'back.out(1.5)' }, .08)
          .fromTo(q('.mg-keys kbd'), { y: -75, rotationX: 75, scale: .7 }, { y: 0, rotationX: 0, scale: 1, stagger: .09, ease: 'bounce.out', duration: .72 }, .23)
          .fromTo(q('.mg-record'), { scale: .08, rotation: -140, autoAlpha: 0 }, { scale: 1, rotation: 0, autoAlpha: 1, duration: .7, ease: 'back.out(2.2)' }, .44)
          .fromTo(q('.mg-wave i'), { scaleY: .04 }, { scaleY: .6, stagger: { each: .013, from: 'center' }, ease: 'back.out(3)', duration: .4 }, .8);
        stamp(.68); stamp(.94);
      } else if (chapter === 'search') {
        tl.fromTo(q('.mg-search-board'), { clipPath: 'circle(0% at 12% 25%)', scale: .88 }, { clipPath: 'circle(150% at 12% 25%)', scale: 1, duration: .95, ease: 'power3.inOut' }, .1)
          .fromTo(q('.mg-lens'), { rotation: -180, scale: .3 }, { rotation: 0, scale: 1, duration: .8, ease: 'back.out(2)' }, .2)
          .fromTo(q('.mg-query'), { x: -100, scaleX: .7, autoAlpha: 0, transformOrigin: '0% 50%' }, { x: 0, scaleX: 1, autoAlpha: 1, duration: .65, ease: 'back.out(1.5)' }, .5);
        stamp(.65);
      } else if (chapter === 'observe') {
        tl.fromTo(q('.mg-monitor'), { scaleY: .025, scaleX: .35, rotation: -4, transformOrigin: '50% 50%' }, { scaleY: 1, scaleX: 1, rotation: 0, duration: .75, ease: 'back.out(1.5)' }, .12)
          .fromTo(q('.mg-screen'), { clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0% 0)', duration: .5 }, .5)
          .fromTo(q('.mg-window'), { x: 100, y: 30, rotation: 8, scale: .4 }, { x: 0, y: 0, rotation: 0, scale: 1, stagger: .1, duration: .6, ease: 'back.out(1.8)' }, .65)
          .fromTo(q('.mg-switch'), { x: -80, rotation: -8, autoAlpha: 0 }, { x: 0, rotation: 0, autoAlpha: 1, duration: .55, ease: 'back.out(2)' }, .8);
        stamp(.65); stamp(.98);
      } else if (chapter === 'outfit' || chapter === 'placement') {
        tl.fromTo(q('.mg-appearance'), { y: 150, rotation: 9, scale: .7, autoAlpha: 0 }, { y: 0, rotation: 0, scale: 1, autoAlpha: 1, duration: .85, ease: 'back.out(1.6)' }, .1)
          .fromTo(q('.mg-appearance-top i'), { y: -30, scale: .1 }, { y: 0, scale: 1, stagger: .08, duration: .5, ease: 'bounce.out' }, .65);
        if (chapter === 'outfit') tl.fromTo(q('.mg-wardrobe button'), { y: 65, rotation: -15, scale: .4, autoAlpha: 0 }, { y: 0, rotation: 0, scale: 1, autoAlpha: 1, stagger: .14, duration: .6, ease: 'back.out(2)' }, .65);
        else tl.fromTo(q('.mg-position-grid'), { scale: .3, rotation: 25, autoAlpha: 0 }, { scale: 1, rotation: 0, autoAlpha: 1, duration: .8, ease: 'back.out(2)' }, .35);
        stamp(.65); stamp(.95);
      } else if (chapter === 'style') {
        tl.fromTo(q('.mg-swatches button'), { x: i => (i - 1.5) * -70, y: 65, rotation: -90, scale: .15, autoAlpha: 0 }, { x: 0, y: 0, rotation: 0, scale: 1, autoAlpha: 1, stagger: .085, duration: .7, ease: 'back.out(2.1)' }, .1)
          .fromTo(q('.mg-style-note'), { clipPath: 'polygon(0% 100%,100% 100%,100% 100%,0% 100%)', rotation: -7, y: 35 }, { clipPath: 'polygon(0% 0%,100% 0%,100% 100%,0% 100%)', rotation: 0, y: 0, duration: .8, ease: 'power3.inOut' }, .34)
          .fromTo(q('.mg-style-bubble'), { x: -60, scale: .6, rotation: -6, autoAlpha: 0 }, { x: 0, scale: 1, rotation: 0, autoAlpha: 1, duration: .55, ease: 'back.out(2)' }, .86);
        stamp(.56); stamp(.95);
      } else {
        tl.fromTo(q('.mg-ready-orb'), { x: -180, y: 100, rotation: -100, scale: .2, autoAlpha: 0 }, { x: 0, y: 0, rotation: 0, scale: 1, autoAlpha: 1, duration: .85, ease: 'back.out(2)' }, .1)
          .fromTo(q('.mg-shortcut-editor'), { clipPath: 'inset(0 50% 0 50%)', y: 25 }, { clipPath: 'inset(0 0% 0 0%)', y: 0, duration: .7, ease: 'power3.inOut' }, .43)
          .fromTo(q('.mg-keys kbd'), { y: -40, rotation: -12, scale: .75 }, { y: 0, rotation: 0, scale: 1, duration: .6, stagger: .08, ease: 'bounce.out' }, .56);
        stamp(.72); stamp(.98);
      }
    });
    return () => { match.revert(); timeline.current = null; delete scene.dataset.choreographed; delete scene.dataset.entrance; };
  }, { scope: root, dependencies: [chapter, run, active, sceneKey], revertOnUpdate: true });

  useEffect(() => {
    if (active && !transitioning) timeline.current?.play(0);
  }, [chapter, run, active, transitioning, sceneKey]);
}
