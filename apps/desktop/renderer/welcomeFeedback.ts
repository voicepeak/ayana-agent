type Motion = 'press' | 'pop' | 'recoil' | 'error' | 'type';
const frames: Record<Motion, Keyframe[]> = {
  press: [{ scale: '1' }, { scale: '.88', offset: .22 }, { scale: '1.08', offset: .6 }, { scale: '1' }],
  pop: [{ scale: '.97' }, { scale: '1.055', offset: .4 }, { scale: '.995', offset: .72 }, { scale: '1' }],
  recoil: [{ translate: '0 0' }, { translate: '0 9px', offset: .18 }, { translate: '0 -5px', offset: .5 }, { translate: '0 0' }],
  error: [{ translate: '0 0' }, { translate: '-10px 0' }, { translate: '10px 0' }, { translate: '-6px 0' }, { translate: '0 0' }],
  type: [{ scale: '1 1' }, { scale: '1.012 1', offset: .3 }, { scale: '1 1' }],
};

/** Noninteractive feedback never moves layout; all particles are bounded and disposable. */
export class WelcomeFeedback {
  private animations = new Map<Element, Animation>();
  private particles = new Set<HTMLElement>();
  private counter = 0;
  constructor(private layer: HTMLElement) {}

  pulse(node: Element | null, kind: Motion = 'press') {
    if (!node || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    this.animations.get(node)?.cancel();
    const animation = node.animate(frames[kind], { duration: kind === 'type' ? 150 : kind === 'press' ? 340 : 540, easing: 'cubic-bezier(.22,.8,.3,1)' });
    this.animations.set(node, animation);
    animation.onfinish = () => { if (this.animations.get(node) === animation) this.animations.delete(node); };
  }

  burst(node: Element | null, strong = false) {
    if (!node || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const rect = node.getBoundingClientRect(), origin = this.layer.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const burst = document.createElement('span');
    burst.className = 'mg-feedback-burst'; burst.dataset.strong = String(strong);
    burst.style.left = `${rect.left + rect.width / 2 - origin.left}px`;
    burst.style.top = `${rect.top + rect.height / 2 - origin.top}px`;
    burst.style.setProperty('--burst-size', `${Math.min(130, Math.max(42, rect.width * .65))}px`);
    for (let i = 0; i < (strong ? 8 : 5); i++) {
      const ray = document.createElement('i'); ray.style.setProperty('--ray', `${i * 360 / (strong ? 8 : 5)}deg`); burst.append(ray);
    }
    this.add(burst);
  }

  fly(from: Element | null, to: Element | null) {
    if (!from || !to || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const start = from.getBoundingClientRect(), end = to.getBoundingClientRect(), origin = this.layer.getBoundingClientRect();
    const flight = document.createElement('span'); flight.className = 'mg-feedback-flight'; flight.textContent = '↗';
    flight.style.left = `${start.left + start.width / 2 - origin.left}px`;
    flight.style.top = `${start.top + start.height / 2 - origin.top}px`;
    flight.style.setProperty('--flight-x', `${end.left + end.width / 2 - start.left - start.width / 2}px`);
    flight.style.setProperty('--flight-y', `${end.top + end.height / 2 - start.top - start.height / 2}px`);
    this.add(flight);
  }

  private add(node: HTMLElement) {
    if (this.particles.size >= 16) { const oldest = this.particles.values().next().value!; oldest.remove(); this.particles.delete(oldest); }
    node.dataset.feedbackId = String(++this.counter);
    this.layer.append(node); this.particles.add(node);
    node.addEventListener('animationend', event => {
      if (event.target === node) { node.remove(); this.particles.delete(node); }
    });
  }

  clear() {
    for (const animation of this.animations.values()) animation.cancel();
    this.animations.clear();
    for (const node of this.particles) node.remove();
    this.particles.clear();
  }
}
