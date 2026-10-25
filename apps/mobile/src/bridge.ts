import { access, ApiError } from './api';
import { LocalRuntime } from './localRuntime';
import type { RuntimeEvent } from './types';
import { IosGatewaySocket, nativeIOS } from './companionNative';

export interface BridgeStatus { connected: boolean; service: string; error?: string }
export class MobileBridge {
  private socket?: WebSocket;
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private statusListeners = new Set<(status: BridgeStatus) => void>();
  private runtime = new LocalRuntime(event => this.emit(event));
  private retry = 0;
  private timer?: number;
  private heartbeat?: number;
  private watchdog?: number;
  private lastMessage = 0;
  private refreshAccess = false;
  private sending = Promise.resolve();
  private disposed = false;
  private connecting = false;
  private connectionGeneration = 0;
  status: BridgeStatus = { connected: false, service: 'idle' };
  onEvent(callback: (event: RuntimeEvent) => void) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  onStatus(callback: (status: BridgeStatus) => void) { this.statusListeners.add(callback); callback(this.status); return () => this.statusListeners.delete(callback); }
  private publish(status: BridgeStatus) { this.status = status; this.statusListeners.forEach(listener => listener(status)); }
  private emit(event: RuntimeEvent) { this.listeners.forEach(listener => listener(event)); }
  async connect() {
    if (this.disposed || this.connecting || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    const generation = ++this.connectionGeneration;
    this.connecting = true;
    try {
      await this.runtime.initialize();
      if (this.disposed || generation !== this.connectionGeneration) return;
      this.publish({ connected: false, service: 'connecting' });
      const session = await access(this.refreshAccess);
      this.refreshAccess = false;
      if (this.disposed || generation !== this.connectionGeneration) return;
      const base = new URL(session.gateway);
      const socket = nativeIOS ? new IosGatewaySocket({ ...session }) as unknown as WebSocket
        : new WebSocket(`${base.protocol === 'https:' ? 'wss:' : 'ws:'}//${base.host}/v1/mobile`);
      this.socket = socket;
      window.clearTimeout(this.timer);
      this.timer = undefined;
      this.lastMessage = Date.now();
      window.clearTimeout(this.watchdog);
      this.watchdog = window.setTimeout(() => {
        if (this.socket === socket && !this.status.connected) socket.close();
      }, 15000);
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => socket.send(JSON.stringify({ access_token: session.access_token }));
      socket.onmessage = message => {
        if (this.socket !== socket || this.disposed) return;
        this.lastMessage = Date.now();
        try {
          if (message.data instanceof ArrayBuffer) {
            const view = new DataView(message.data);
            if (view.byteLength < 4) throw new Error('音频包过短');
            const length = view.getUint32(0, true);
            if (length < 1 || length > 8192 || length + 4 > view.byteLength) throw new Error('音频包头无效');
            const event = JSON.parse(new TextDecoder().decode(new Uint8Array(message.data, 4, length))) as RuntimeEvent;
            const pcm = new Uint8Array(message.data, 4 + length);
            if (event.protocol_version !== 1 || event.format !== 'pcm_s16le' || event.channels !== 1
                || event.byte_length !== pcm.length || pcm.length % 2 || event.sample_count !== pcm.length / 2) throw new Error('音频长度无效');
            // Copy the payload: playback's DataView must start at byte offset zero.
            const local = this.runtime.receive({ ...event, pcm_bytes: pcm.slice() });
            if (local) this.emit(local);
            return;
          }
          const event = JSON.parse(String(message.data)) as RuntimeEvent;
          if (event.native_playback && event.type.startsWith('playback.')) this.runtime.playback(event);
          if (event.native_playback && event.type === 'mobile.present') {
            this.runtime.playback({ ...event, type: 'utterance.displayed' });
            this.runtime.playback({ ...event, type: 'playback.ended' });
          }
          if (event.type === 'gateway.ready') {
            window.clearTimeout(this.watchdog);
            this.retry = 0;
            this.publish({ connected: true, service: 'ready' });
            window.clearInterval(this.heartbeat);
            if (!nativeIOS) this.heartbeat = window.setInterval(() => {
              if (Date.now() - this.lastMessage > 50000 || Date.now() / 1000 > session.expires_at - 30) this.reconnect();
              else if (socket.readyState === WebSocket.OPEN) socket.send('{"type":"ping"}');
            }, 20000);
          }
          const local = this.runtime.receive(event);
          if (local) this.emit(local);
          if (nativeIOS && local?.type === 'generation.cancelled') this.runtime.cancel();
        } catch { this.publish({ ...this.status, error: '收到无效数据，本轮语音已停止' }); void this.send({ type: 'generation.cancel' }); }
      };
      socket.onclose = event => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        window.clearInterval(this.heartbeat);
        window.clearTimeout(this.watchdog);
        this.runtime.cancel();
        this.emit({ protocol_version: 1, type: 'service.state', service: 'tts', state: 'failed' });
        this.emit({ protocol_version: 1, type: 'task.state', state: 'idle' });
        if (this.disposed) return;
        if (event.code === 4401) this.refreshAccess = true;
        this.publish({ connected: false, service: 'offline', error: '网关连接中断；本地历史和立绘仍可使用' });
        this.schedule(event.code === 4401 ? 1000 : undefined);
      };
      socket.onerror = () => { /* onclose owns retry and cleanup */ };
    } catch (error) {
      if (this.disposed || generation !== this.connectionGeneration) return;
      if (error instanceof ApiError && error.status === 401) this.publish({ connected: false, service: 'unauthorized', error: error.message });
      else { this.publish({ connected: false, service: 'offline', error: String(error) }); this.schedule(); }
    } finally { if (generation === this.connectionGeneration) this.connecting = false; }
  }
  private schedule(delay?: number) {
    if (this.timer || this.disposed) return;
    this.timer = window.setTimeout(() => { this.timer = undefined; void this.connect(); }, delay ?? Math.min(10000, 700 * 2 ** Math.min(this.retry++, 4)));
  }
  async send(command: Record<string, unknown> & { type: string }): Promise<{ ok: boolean; error?: string }> {
    // Cancellation must invalidate queued packets immediately, even during a local save.
    if (command.type === 'generation.cancel') {
      this.runtime.cancel();
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(command));
      return { ok: true };
    }
    let result: { ok: boolean; error?: string } = { ok: false };
    const action = this.sending.catch(() => {}).then(async () => { result = await this.execute(command); });
    this.sending = action;
    await action;
    return result;
  }
  private async execute(command: Record<string, unknown> & { type: string }): Promise<{ ok: boolean; error?: string }> {
    try {
      if (this.disposed) throw new Error('连接已关闭，请重新连接');
      if (command.type === 'turn.start') {
        if (!this.status.connected || this.socket?.readyState !== WebSocket.OPEN) throw new Error('网关尚未连接');
        const socket = this.socket;
        socket.send('{"type":"generation.cancel"}');
        const outgoing = await this.runtime.start(String(command.text || ''));
        if (outgoing.generation_id !== this.runtime.generation) throw new Error('发送已取消');
        if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) throw new Error('连接中断，消息未发出，请重试');
        socket.send(JSON.stringify(outgoing));
      } else if (command.type === 'input.audio') {
        this.emit({ protocol_version: 1, type: 'input.state', state: 'failed' });
        throw new Error('尚未配置语音识别服务，请先使用文字输入');
      } else {
        if (['conversation.create', 'conversation.select', 'conversation.delete'].includes(command.type)) {
          if (this.socket?.readyState === WebSocket.OPEN) this.socket.send('{"type":"generation.cancel"}');
        }
        await this.runtime.command(command);
      }
      return { ok: true };
    } catch (error) {
      if (command.type === 'turn.start') {
        this.emit({ protocol_version: 1, type: 'task.state', state: 'failed' });
      }
      return { ok: false, error: String(error instanceof Error ? error.message : error) };
    }
  }
  exportConversation() { return this.runtime.exportConversation(); }
  consumeAudio(utteranceId: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'audio.consumed', utterance_id: utteranceId }));
  }
  resume() {
    if (this.disposed) return;
    if (this.socket && !nativeIOS && Date.now() - this.lastMessage > 25000) this.reconnect();
    else void this.connect();
  }
  offline() {
    this.close();
    this.disposed = false;
    this.publish({ connected: false, service: 'offline' });
  }
  playback(receipt: RuntimeEvent) {
    this.runtime.playback(receipt);
    if (['playback.ended', 'playback.cancelled', 'playback.error'].includes(receipt.type) && this.socket?.readyState === WebSocket.OPEN) {
      this.consumeAudio(receipt.utterance_id);
    } else if (receipt.type === 'generation.cancel') void this.send({ type: 'generation.cancel' });
  }
  close() {
    this.disposed = true;
    this.connectionGeneration++;
    this.runtime.cancel();
    this.connecting = false;
    window.clearTimeout(this.timer);
    window.clearInterval(this.heartbeat);
    window.clearTimeout(this.watchdog);
    this.timer = undefined;
    this.socket?.close();
    this.socket = undefined;
  }
  reconnect() { this.close(); this.disposed = false; this.retry = 0; this.publish({ connected: false, service: 'connecting' }); void this.connect(); }
}
