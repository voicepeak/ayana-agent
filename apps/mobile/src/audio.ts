import type { RuntimeEvent } from './types';

type Playback = (receipt: RuntimeEvent) => void;

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
  private chain = Promise.resolve();
  private fallback = false;
  private fallbackQueue: { event: RuntimeEvent; samples: Float32Array; rate: number }[] = [];
  private fallbackAudio?: HTMLAudioElement;
  private fallbackUrl = '';
  private fallbackTimer?: number;
  private fallbackItem?: { event: RuntimeEvent; samples: Float32Array; rate: number };

  constructor(private sendPlayback: Playback, private onLocal: (event: RuntimeEvent) => void) {}

  async unlock() {
    if (this.disposed) return;
    if (!this.initializing) {
      this.initializing = (async () => {
        this.context = new AudioContext({ latencyHint: 'interactive' });
        if (!this.context.audioWorklet) {
          this.fallback = true;
          this.fallbackAudio = new Audio();
          // Prime the same media element in the send-button gesture for Safari.
          this.fallbackAudio.src = 'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA==';
          await this.fallbackAudio.play().catch(() => {});
          return;
        }
        await this.context.audioWorklet.addModule(new URL('pcm-player.js', document.baseURI).href);
        this.node = new AudioWorkletNode(this.context, 'ayana-pcm-player', {
          numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
        });
        this.gain = this.context.createGain();
        this.gain.gain.value = this.volume;
        this.node.connect(this.gain).connect(this.context.destination);
        this.node.port.onmessage = ({ data }: MessageEvent<Record<string, unknown>>) => {
          const utterance = this.pending.get(String(data.utterance_id));
          if (!utterance) return;
          const generation = Number(data.generation_id);
          const receipt: RuntimeEvent = {
            protocol_version: 1,
            type: `playback.${data.type}`,
            session_id: utterance.event.session_id,
            turn_id: utterance.event.turn_id,
            generation_id: generation,
            utterance_id: data.utterance_id,
            played_samples: data.played_samples,
            total_samples: data.total_samples,
            sample_rate: data.sample_rate,
            cancelled: data.cancelled,
            played_audio_ms: Number(data.played_samples) / Number(data.sample_rate) * 1000,
            output_sample_rate: this.context?.sampleRate,
            estimated_device_latency_ms: ((this.context?.baseLatency || 0) + (this.context?.outputLatency || 0)) * 1000,
          };
          if (data.type === 'ended' || data.type === 'cancelled') this.pending.delete(String(data.utterance_id));
          if (generation <= this.cancelledGeneration && data.type !== 'cancelled') return;
          this.sendPlayback(receipt);
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
    if (this.pending.size >= 3 || (this.pending.size > 0 && totalDuration + duration > 30)) {
      this.fail(event, '音频缓冲已达到上限，本轮语音已停止。');
      this.cancel(generation);
      void this.sendPlayback({ protocol_version: 1, type: 'generation.cancel', generation_id: generation });
      return;
    }
    this.seen.add(id);
    if (this.seen.size > 1000) this.seen = new Set([...this.seen].slice(-500));
    this.pending.set(id, { event, duration });
    this.chain = this.chain.then(async () => {
      await this.unlock();
      if (this.disposed || generation <= this.cancelledGeneration) {
        this.pending.delete(id);
        return;
      }
      const rate = Number(event.sample_rate);
      const channels = Number(event.channels ?? 1);
      const format = String(event.format || 'pcm_f32le');
      const encoded = String(event.pcm_base64 || '');
      const binary = event.pcm_bytes instanceof Uint8Array ? event.pcm_bytes : undefined;
      if (channels !== 1 || !Number.isFinite(rate) || rate < 8000 || rate > 192000 || (!encoded && !binary)) {
        throw new Error('不支持的 PCM 格式');
      }
      const bytes = binary || Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
      let samples: Float32Array;
      if (format === 'pcm_s16le') {
        if (bytes.length % 2 || bytes.length > 32 * 1024 * 1024) throw new Error('PCM 载荷长度无效');
        const view = new DataView(bytes.buffer);
        samples = new Float32Array(bytes.length / 2);
        for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
      } else {
        if (bytes.length % 4 || bytes.length > 32 * 1024 * 1024) throw new Error('PCM 载荷长度无效');
        const view = new DataView(bytes.buffer);
        samples = new Float32Array(bytes.length / 4);
        for (let i = 0; i < samples.length; i++) {
          const sample = view.getFloat32(i * 4, true);
          if (!Number.isFinite(sample)) throw new Error('PCM 包含无效样本');
          samples[i] = Math.max(-1, Math.min(1, sample));
        }
      }
      this.pending.get(id)!.duration = samples.length / rate;
      if (this.fallback) {
        this.fallbackQueue.push({ event, samples, rate });
        this.playFallback();
        return;
      }
      if (!this.node) throw new Error('播放器未就绪');
      this.node.port.postMessage({ type: 'enqueue', utterance_id: id, generation_id: generation, sample_rate: rate, samples }, [samples.buffer]);
    }).catch(error => {
      this.pending.delete(id);
      this.fail(event, `语音播放失败：${String(error)}`);
    });
  }

  private fail(event: RuntimeEvent, message: string) {
    const receipt: RuntimeEvent = {
      protocol_version: 1, type: 'playback.error', generation_id: event.generation_id,
      session_id: event.session_id, turn_id: event.turn_id, utterance_id: event.utterance_id,
      played_samples: 0, total_samples: 0, sample_rate: event.sample_rate, message,
    };
    this.sendPlayback(receipt);
    this.onLocal({ ...receipt, type: 'error', code: 'audio_playback' });
  }

  private fallbackReceipt(type: string, item: { event: RuntimeEvent; samples: Float32Array; rate: number }) {
    const played = type === 'ended' ? item.samples.length : Math.min(item.samples.length, Math.floor((this.fallbackAudio?.currentTime || 0) * item.rate));
    const receipt: RuntimeEvent = { ...item.event, pcm_bytes: undefined, pcm_base64: undefined, type: `playback.${type}`,
      played_samples: played, total_samples: item.samples.length, sample_rate: item.rate };
    this.sendPlayback(receipt);
    this.onLocal(receipt);
  }
  private playFallback() {
    if (this.fallbackItem || this.disposed) return;
    const item = this.fallbackQueue.shift();
    if (!item) return;
    if (Number(item.event.generation_id) <= this.cancelledGeneration) { this.playFallback(); return; }
    this.fallbackItem = item;
    const buffer = new ArrayBuffer(44 + item.samples.length * 2);
    const view = new DataView(buffer);
    const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
    text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, item.rate, true); view.setUint32(28, item.rate * 2, true); view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, item.samples.length * 2, true);
    for (let i = 0; i < item.samples.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, item.samples[i])) * 32767, true);
    const audio = this.fallbackAudio || new Audio(); this.fallbackAudio = audio;
    this.fallbackUrl = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
    audio.src = this.fallbackUrl; audio.volume = this.volume;
    audio.onplaying = () => { this.fallbackReceipt('started', item); };
    this.fallbackTimer = window.setInterval(() => { if (!audio.paused) this.fallbackReceipt('progress', item); }, 100);
    const finish = () => {
      window.clearInterval(this.fallbackTimer); URL.revokeObjectURL(this.fallbackUrl);
      audio.onplaying = null; audio.onended = null; audio.onerror = null;
      this.pending.delete(String(item.event.utterance_id)); this.fallbackItem = undefined;
      this.playFallback();
    };
    audio.onended = () => { this.fallbackReceipt('ended', item); finish(); };
    audio.onerror = () => { this.fail(item.event, '音频播放失败'); finish(); };
    void audio.play().catch(() => { this.fail(item.event, '请点击发送消息以允许播放声音'); finish(); });
  }

  cancel(generation: number) {
    this.cancelledGeneration = Math.max(this.cancelledGeneration, generation);
    this.node?.port.postMessage({ type: 'cancel', generation_id: this.cancelledGeneration });
    this.fallbackQueue = this.fallbackQueue.filter(item => Number(item.event.generation_id) > generation);
    if (this.fallbackItem && Number(this.fallbackItem.event.generation_id) <= generation) {
      this.fallbackReceipt('cancelled', this.fallbackItem);
      this.fallbackAudio?.pause();
      if (this.fallbackAudio) { this.fallbackAudio.onplaying = null; this.fallbackAudio.onended = null; this.fallbackAudio.onerror = null; }
      window.clearInterval(this.fallbackTimer); URL.revokeObjectURL(this.fallbackUrl);
      this.fallbackItem = undefined;
    }
    for (const [id, item] of this.pending) {
      if (Number(item.event.generation_id) <= generation) {
        window.setTimeout(() => this.pending.delete(id), 300);
      }
    }
  }

  setVolume(value: number) {
    this.volume = Math.max(0, Math.min(1, value));
    this.gain?.gain.setTargetAtTime(this.volume, this.context!.currentTime, .02);
    if (this.fallbackAudio) this.fallbackAudio.volume = this.volume;
  }

  dispose() {
    this.disposed = true;
    this.cancel(Number.MAX_SAFE_INTEGER);
    this.node?.disconnect();
    this.gain?.disconnect();
    void this.context?.close();
    this.pending.clear();
  }
}
