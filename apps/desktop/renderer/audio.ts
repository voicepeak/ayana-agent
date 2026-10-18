import type { AyanaBridge, RuntimeEvent } from './types';
import { publishAudioLevel, resetAudioLevel } from './audioLevel';

/** Bounded, mono float32 LE queue. Avatar and highlight never instantiate this. */
export class AudioPlayer {
  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private initializing?: Promise<void>;
  private cancelledGeneration = -1;
  private pending = new Map<string, { event: RuntimeEvent; duration: number }>();
  private seen = new Set<string>();
  private disposed = false;
  private volume = 1;
  private gain?: GainNode;
  private analyser?: AnalyserNode;
  private levelRaf = 0;
  private levelValue = 0;
  private chain = Promise.resolve();

  constructor(private bridge: AyanaBridge, private onLocal: (event: RuntimeEvent) => void) {}

  async unlock() {
    if (this.disposed) return;
    if (!this.initializing) {
      this.initializing = (async () => {
        this.context = new AudioContext({ latencyHint: 'interactive' });
        await this.context.audioWorklet.addModule('./pcm-player.js');
        this.node = new AudioWorkletNode(this.context, 'ayana-pcm-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
        this.gain = this.context.createGain();
        this.gain.gain.value = this.volume;
        this.analyser = this.context.createAnalyser();
        this.analyser.fftSize = 512;
        this.node.connect(this.analyser).connect(this.gain).connect(this.context.destination);
        this.watchLevel();
        this.node.port.onmessage = ({ data }: MessageEvent<Record<string, unknown>>) => {
          const utterance = this.pending.get(String(data.utterance_id));
          if (!utterance) return;
          const generation = Number(data.generation_id);
          const receipt: RuntimeEvent = {
            protocol_version: 1, type: `playback.${data.type}`,
            session_id: utterance.event.session_id, turn_id: utterance.event.turn_id,
            generation_id: generation, utterance_id: data.utterance_id,
            played_samples: data.played_samples, total_samples: data.total_samples,
            sample_rate: data.sample_rate, cancelled: data.cancelled,
            played_audio_ms: Number(data.played_samples) / Number(data.sample_rate) * 1000,
            output_sample_rate: this.context?.sampleRate,
            estimated_device_latency_ms: ((this.context?.baseLatency || 0) + (this.context?.outputLatency || 0)) * 1000,
          };
          if (data.type === 'ended' || data.type === 'cancelled') this.pending.delete(String(data.utterance_id));
          if (generation <= this.cancelledGeneration && data.type !== 'cancelled') return;
          this.bridge.playback(receipt);
          this.onLocal(receipt);
        };
      })().catch(error => {
        this.initializing = undefined;
        this.onLocal({ protocol_version: 1, type: 'error', code: 'audio_device', message: `音频设备无法初始化：${String(error)}` });
      });
    }
    await this.initializing;
    if (this.context?.state === 'suspended') await this.context.resume();
  }

  enqueue(event: RuntimeEvent) {
    const generation = Number(event.generation_id);
    const id = String(event.utterance_id || '');
    if (!id || generation <= this.cancelledGeneration || this.seen.has(id)) return;
    const duration = Number(event.duration_ms || 0) / 1000;
    const totalDuration = [...this.pending.values()].reduce((sum, item) => sum + item.duration, 0);
    if (this.pending.size >= 3 || (this.pending.size > 0 && totalDuration + duration > 12)) {
      this.fail(event, '音频缓冲已达到上限，本轮语音已停止。');
      this.cancel(generation);
      void this.bridge.send({ type: 'generation.cancel' });
      return;
    }
    this.seen.add(id);
    if (this.seen.size > 1000) this.seen = new Set([...this.seen].slice(-500));
    this.pending.set(id, { event, duration });
    this.chain = this.chain.then(async () => {
      await this.unlock();
      if (this.disposed || generation <= this.cancelledGeneration) { this.pending.delete(id); return; }
      const rate = Number(event.sample_rate);
      const channels = Number(event.channels ?? 1);
      const encoded = String(event.pcm_base64 || '');
      if (channels !== 1 || !Number.isFinite(rate) || rate < 8000 || rate > 192000 || !encoded) throw new Error('不支持的 PCM 格式');
      const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
      if (bytes.length % 4 || bytes.length > 32 * 1024 * 1024) throw new Error('PCM 载荷长度无效');
      const view = new DataView(bytes.buffer);
      const samples = new Float32Array(bytes.length / 4);
      for (let i = 0; i < samples.length; i++) {
        const sample = view.getFloat32(i * 4, true);
        if (!Number.isFinite(sample)) throw new Error('PCM 包含无效样本');
        samples[i] = Math.max(-1, Math.min(1, sample));
      }
      this.pending.get(id)!.duration = samples.length / rate;
      if (!this.node) throw new Error('播放器未就绪');
      this.node.port.postMessage({ type: 'enqueue', utterance_id: id, generation_id: generation, sample_rate: rate, samples }, [samples.buffer]);
    }).catch(error => { this.pending.delete(id); this.fail(event, `语音播放失败：${String(error)}`); });
  }

  private watchLevel() {
    const analyser = this.analyser;
    if (!analyser) return;
    const samples = new Float32Array(analyser.fftSize);
    let last = 0;
    const tick = (now: number) => {
      if (this.disposed) return;
      if (now - last >= 33) {
        last = now;
        analyser.getFloatTimeDomainData(samples);
        let energy = 0;
        for (const sample of samples) energy += sample * sample;
        const target = Math.min(1, Math.sqrt(energy / samples.length) * 5.5);
        this.levelValue += (target - this.levelValue) * (target > this.levelValue ? .65 : .38);
        publishAudioLevel(this.levelValue);
      }
      this.levelRaf = requestAnimationFrame(tick);
    };
    this.levelRaf = requestAnimationFrame(tick);
  }

  private fail(event: RuntimeEvent, message: string) {
    this.levelValue = 0;
    resetAudioLevel();
    const receipt: RuntimeEvent = {
      protocol_version: 1, type: 'playback.error', generation_id: event.generation_id,
      session_id: event.session_id, turn_id: event.turn_id, utterance_id: event.utterance_id,
      played_samples: 0, total_samples: 0, sample_rate: event.sample_rate, message,
    };
    this.bridge.playback(receipt);
    this.onLocal({ ...receipt, type: 'error', code: 'audio_playback' });
  }

  cancel(generation: number) {
    this.cancelledGeneration = Math.max(this.cancelledGeneration, generation);
    this.node?.port.postMessage({ type: 'cancel', generation_id: this.cancelledGeneration });
    this.levelValue = 0;
    resetAudioLevel();
    // Worklet sends the exact final consumed position for an active cancelled segment.
    for (const [id, item] of this.pending) {
      if (Number(item.event.generation_id) <= generation) {
        setTimeout(() => this.pending.delete(id), 300);
      }
    }
  }

  setVolume(value: number) {
    this.volume = Math.max(0, Math.min(1, value));
    this.gain?.gain.setTargetAtTime(this.volume, this.context!.currentTime, .02);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.levelRaf);
    this.node?.disconnect();
    this.analyser?.disconnect();
    void this.context?.close();
    this.pending.clear();
    resetAudioLevel();
  }
}
