export type CaptureState = 'idle' | 'preparing' | 'recording' | 'transcribing' | 'failed';
type Capture = { id: string; cancelled: boolean; stream?: MediaStream; recorder?: MediaRecorder; chunks: Blob[]; started: number };

/** Owns one recording, including permission/release races and stream cleanup. */
export class HoldRecorder {
  private current?: Capture;
  constructor(private deps: {
    getStream(): Promise<MediaStream>; makeRecorder(stream: MediaStream): MediaRecorder;
    submit(id: string, base64: string, mime: string): Promise<void>;
    state(state: CaptureState): void; error(message: string): void; now?(): number;
  }) {}
  private stopTracks(c: Capture) { c.stream?.getTracks().forEach(track => track.stop()); }
  async start(id: string) {
    this.cancel();
    const c: Capture = { id, cancelled: false, chunks: [], started: 0 };
    this.current = c; this.deps.state('preparing');
    try {
      c.stream = await this.deps.getStream();
      if (this.current !== c || c.cancelled) { this.stopTracks(c); return; }
      const recorder = c.recorder = this.deps.makeRecorder(c.stream);
      recorder.ondataavailable = event => { if (event.data.size) c.chunks.push(event.data); };
      recorder.onstop = () => { void this.complete(c); };
      recorder.onerror = () => {
        if (this.current !== c) return;
        this.cancel(); this.deps.state('failed'); this.deps.error('录音中断，请重试。');
      };
      recorder.start(200); c.started = (this.deps.now || performance.now.bind(performance))();
      this.deps.state('recording');
    } catch (error) {
      this.stopTracks(c);
      if (this.current !== c) return;
      this.current = undefined; this.deps.state('failed');
      this.deps.error(error instanceof DOMException && error.name === 'NotAllowedError' ? '请允许使用麦克风。' : '无法打开麦克风，请检查设备。');
    }
  }
  release(id: string, cancelled = false) {
    const c = this.current;
    if (!c || c.id !== id) return;
    c.cancelled = cancelled;
    if (!c.recorder) { this.cancel(); return; }
    if (c.recorder.state !== 'inactive') c.recorder.stop();
    this.stopTracks(c);
  }
  cancel() {
    const c = this.current; this.current = undefined;
    if (c) { c.cancelled = true; if (c.recorder && c.recorder.state !== 'inactive') c.recorder.stop(); this.stopTracks(c); }
    this.deps.state('idle');
  }
  private async complete(c: Capture) {
    this.stopTracks(c);
    if (this.current !== c) return;
    if (c.cancelled || (this.deps.now || performance.now.bind(performance))() - c.started < 150 || !c.chunks.length) {
      this.current = undefined; this.deps.state('idle'); return;
    }
    try {
      const mime = c.recorder?.mimeType || 'audio/webm';
      const blob = new Blob(c.chunks, { type: mime });
      if (blob.size > 1_400_000) throw new Error('录音过长，请分段说。');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (this.current !== c || c.cancelled) return;
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
      this.deps.state('transcribing');
      await this.deps.submit(c.id, btoa(binary), mime);
      if (this.current === c) this.current = undefined;
    } catch (error) {
      if (this.current !== c) return;
      this.current = undefined; this.deps.state('failed');
      this.deps.error(error instanceof Error ? error.message : '识别未完成，请重试。');
    }
  }
}
