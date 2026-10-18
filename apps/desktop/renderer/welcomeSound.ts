import type { Chapter } from './WelcomeMotion';

export type WelcomeCue = 'hover' | 'press' | 'focus' | 'type' | 'confirm' | 'send' | 'reply'
  | 'record-start' | 'record-stop' | 'search' | 'source' | 'toggle-on' | 'toggle-off' | 'theme' | 'ready' | 'error';

/** Layered UI foley and occasional short Ayana lines, mixed for laptop speakers. */
export class WelcomeSound {
  private context?: AudioContext;
  private output?: GainNode;
  private air?: AudioBuffer;
  private sources = new Set<AudioScheduledSourceNode>();
  private last = new Map<string, number>();
  private level = 1;
  private muted = false;
  private disposed = false;
  private generation = 0;
  private speechGeneration = 0;
  private speech?: AudioBufferSourceNode;
  private speechOutput?: GainNode;
  private speechBuffers = new Map<string, Promise<AudioBuffer>>();
  private speechFinished?: (completed: boolean) => void;

  constructor(private onSpeech: (speaking: boolean) => void = () => {}) {}

  setVolume(volume: number, muted: boolean) {
    this.level = Number.isFinite(volume) ? Math.max(0, Math.min(1.5, volume)) : 1;
    this.muted = muted;
    if (muted) this.stop();
    if (this.context && this.output) {
      this.output.gain.setTargetAtTime(muted ? 0 : this.level * 1.15 * (this.speech ? .3 : 1), this.context.currentTime, .015);
      this.speechOutput?.gain.setTargetAtTime(muted ? 0 : this.level, this.context.currentTime, .015);
    }
  }

  unlock() {
    if (this.disposed) return;
    try {
      if (!this.context) {
        this.context = new AudioContext();
        this.output = this.context.createGain();
        this.output.gain.value = this.muted ? 0 : this.level * 1.15;
        const limiter = this.context.createDynamicsCompressor();
        limiter.threshold.value = -8; limiter.knee.value = 8; limiter.ratio.value = 8;
        limiter.attack.value = .003; limiter.release.value = .12;
        const ceiling = this.context.createWaveShaper();
        ceiling.curve = Float32Array.from({ length: 4097 }, (_, i) => Math.tanh((i / 2048 - 1) * 1.35) * .92);
        ceiling.oversample = '2x';
        this.output.connect(limiter).connect(ceiling).connect(this.context.destination);
        this.speechOutput = this.context.createGain();
        this.speechOutput.gain.value = this.muted ? 0 : this.level;
        this.speechOutput.connect(limiter);
      }
      if (this.context.state === 'suspended') void this.context.resume().catch(() => {});
    } catch { /* All interactions remain available without an audio device. */ }
  }

  /** A few short, bundled Ayana lines; generation guards prevent delayed playback after navigation. */
  private loadSpeech(clip: string, ctx: AudioContext) {
    let buffer = this.speechBuffers.get(clip);
    if (!buffer) {
      buffer = fetch(new URL(`./welcome/snippets/${clip}.wav`, document.baseURI)).then(response => {
        if (!response.ok) throw new Error('Voice clip unavailable');
        return response.arrayBuffer();
      }).then(bytes => ctx.decodeAudioData(bytes));
      this.speechBuffers.set(clip, buffer);
    }
    return buffer;
  }

  async preloadCompletion() {
    this.unlock();
    if (!this.context) return;
    try { await this.loadSpeech('champion', this.context); } catch { this.speechBuffers.delete('champion'); }
  }

  async say(clip: 'remember' | 'setting' | 'champion'): Promise<boolean> {
    this.stopSpeech();
    if (this.disposed || this.muted || this.level === 0) return false;
    this.unlock();
    const ctx = this.context, generation = this.speechGeneration;
    if (!ctx || !this.speechOutput) return false;
    try {
      const decoded = await this.loadSpeech(clip, ctx);
      await ctx.resume();
      if (generation !== this.speechGeneration || this.disposed || this.muted || this.level === 0) return false;
      const source = ctx.createBufferSource(); source.buffer = decoded;
      source.connect(this.speechOutput);
      this.speech = source;
      this.output!.gain.setTargetAtTime(this.level * 1.15 * .3, ctx.currentTime, .06);
      this.onSpeech(true);
      source.onended = () => {
        source.disconnect();
        if (this.speech !== source) return;
        this.speech = undefined;
        const finish = this.speechFinished; this.speechFinished = undefined; finish?.(true);
        this.output?.gain.setTargetAtTime(this.muted ? 0 : this.level * 1.15, ctx.currentTime, .12);
        this.onSpeech(false);
      };
      const finished = new Promise<boolean>(resolve => { this.speechFinished = resolve; });
      source.start();
      return await finished;
    } catch { this.speechBuffers.delete(clip); if (generation === this.speechGeneration) this.stopSpeech(); return false; /* The tour stays usable without voice playback. */ }
  }

  private stopSpeech() {
    this.speechGeneration++;
    const finish = this.speechFinished; this.speechFinished = undefined; finish?.(false);
    if (this.speech) { const source = this.speech; this.speech = undefined; try { source.stop(); } catch { /* Already ended. */ } source.disconnect(); }
    if (this.context) this.output?.gain.setTargetAtTime(this.muted ? 0 : this.level * 1.15, this.context.currentTime, .06);
    this.onSpeech(false);
  }

  private play(build: (time: number) => void) {
    this.unlock();
    const ctx = this.context;
    if (!ctx || this.muted || this.level === 0) return;
    if (ctx.state === 'running') { build(ctx.currentTime + .008); return; }
    // Keep the first click while the device wakes, without replaying stale input later.
    const generation = this.generation, requested = performance.now();
    void ctx.resume().then(() => {
      if (generation === this.generation && !this.muted && !this.disposed && performance.now() - requested < 180) build(ctx.currentTime + .008);
    }).catch(() => {});
  }

  private track(source: AudioScheduledSourceNode, nodes: AudioNode[]) {
    this.sources.add(source);
    source.onended = () => { this.sources.delete(source); source.disconnect(); nodes.forEach(node => node.disconnect()); };
  }

  private tone(at: number, pitch: number, end: number, duration: number, volume: number, type: OscillatorType = 'sine') {
    const ctx = this.context!;
    const oscillator = ctx.createOscillator(), gain = ctx.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(pitch, at);
    oscillator.frequency.exponentialRampToValueAtTime(end, at + duration);
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(volume, at + .005);
    gain.gain.exponentialRampToValueAtTime(Math.max(.0002, volume * .38), at + duration * .3);
    gain.gain.exponentialRampToValueAtTime(.0001, at + duration);
    oscillator.connect(gain).connect(this.output!);
    this.track(oscillator, [gain]); oscillator.start(at); oscillator.stop(at + duration + .015);
  }

  private noise(at: number, duration: number, volume: number, from = 700, to = 3600) {
    const ctx = this.context!;
    if (!this.air) {
      this.air = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const samples = this.air.getChannelData(0);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    }
    const air = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
    air.buffer = this.air; filter.type = 'bandpass'; filter.Q.value = .75;
    filter.frequency.setValueAtTime(from, at); filter.frequency.exponentialRampToValueAtTime(to, at + duration);
    gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(volume, at + duration * .2);
    gain.gain.exponentialRampToValueAtTime(.0001, at + duration);
    air.connect(filter).connect(gain).connect(this.output!);
    this.track(air, [filter, gain]); air.start(at); air.stop(at + duration);
  }

  transition(chapter: Chapter, duration: number) {
    this.stop();
    this.play(t => {
      const span = duration / 1000;
      const pitch = { meet: 660, chat: 740, voice: 520, search: 880, observe: 620, outfit: 784, placement: 698, style: 830, ready: 990 }[chapter];
      this.noise(t, span * .25, .38, 320, 4200);
      this.tone(t + .04, 240, 460, .14, .13, 'triangle');
      const hit = t + span * .24;
      this.tone(hit, 190, 64, .32, .62);
      this.tone(hit, 420, 160, .12, .26, 'triangle');
      this.noise(hit, .09, .22, 2600, 800);
      const offsets = chapter === 'voice' ? [.32, .38, .44, .50] : chapter === 'style' ? [.31, .37, .43, .49, .55] : [.34, .43, .52];
      offsets.forEach((beat, i) => {
        this.tone(t + span * beat, pitch * (1 + i * .125), pitch * (1 + i * .125), .11, .11, 'triangle');
        this.noise(t + span * beat, .035, .065, 2800, 1400);
      });
      const tail = t + span * .65;
      this.tone(tail, pitch, pitch, .28, .2);
      this.tone(tail + .07, pitch * 1.5, pitch * 1.5, .25, .15);
      this.noise(t + span * .75, span * .22, .19, 3400, 500);
      if (chapter === 'ready') this.tone(tail + .14, pitch * 2, pitch * 2, .32, .13);
    });
  }

  cue(cue: WelcomeCue, variant = 0) {
    const now = performance.now();
    const cooldown = cue === 'hover' ? 110 : cue === 'type' ? 60 : cue === 'press' ? 35 : 0;
    if (now - (this.last.get(cue) ?? -Infinity) < cooldown) return;
    this.last.set(cue, now);
    this.play(t => {
      switch (cue) {
        case 'hover': this.tone(t, 960, 1250, .055, .075, 'triangle'); break;
        case 'press': this.tone(t, 310, 190, .065, .18, 'triangle'); this.noise(t, .025, .08, 2200, 900); break;
        case 'focus': this.tone(t, 520, 780, .12, .14); this.tone(t + .04, 1040, 1040, .11, .07); break;
        case 'type': this.tone(t, 460 + variant % 4 * 65, 320, .04, .115, 'triangle'); this.noise(t, .018, .045); break;
        case 'confirm': case 'reply': case 'record-stop': case 'ready': {
          const pitches = cue === 'reply' ? [660, 880, 1320] : cue === 'record-stop' ? [740, 990, 1480] : [660, 990, 1320];
          pitches.forEach((pitch, i) => this.tone(t + i * .065, pitch, pitch, .23, .24 - i * .035, 'triangle'));
          this.tone(t, 220, 110, .14, .16); break;
        }
        case 'send': this.noise(t, .22, .31, 500, 4200); this.tone(t, 380, 1200, .15, .22, 'triangle'); this.tone(t + .15, 940, 940, .1, .16); break;
        case 'record-start': this.tone(t, 380, 740, .14, .22); this.tone(t + .09, 990, 990, .16, .19); break;
        case 'search':
          this.noise(t, .28, .26, 450, 2800);
          [660, 830, 990].forEach((pitch, i) => this.tone(t + .12 + i * .09, pitch, pitch, .15, .18, 'triangle')); break;
        case 'source': this.tone(t, 580, 880, .09, .23, 'triangle'); this.tone(t + .07, 1320, 1320, .22, .17); break;
        case 'toggle-on': this.tone(t, 420, 840, .13, .24, 'triangle'); this.tone(t + .08, 1260, 1260, .18, .15); break;
        case 'toggle-off': this.tone(t, 840, 320, .17, .23, 'triangle'); this.noise(t, .06, .1, 1400, 600); break;
        case 'theme': {
          const pitch = [587, 622, 660, 698, 784, 831, 880, 932][variant % 8];
          this.noise(t, .22, .2, 1200, 3200);
          [1, 1.25, 1.5].forEach((ratio, i) => this.tone(t + i * .055, pitch * ratio, pitch * ratio, .24, .2 - i * .035)); break;
        }
        case 'error': this.tone(t, 240, 190, .11, .21, 'triangle'); this.tone(t + .13, 220, 170, .13, .18, 'triangle'); break;
      }
    });
  }

  stop() {
    this.generation++;
    this.stopSpeech();
    for (const source of this.sources) { try { source.stop(); } catch { /* Already ended. */ } }
    this.sources.clear();
  }

  dispose() {
    this.disposed = true; this.stop();
    if (this.context) void this.context.close().catch(() => {});
    this.context = undefined; this.output = undefined; this.speechOutput = undefined; this.air = undefined;
    this.speechBuffers.clear();
  }
}
