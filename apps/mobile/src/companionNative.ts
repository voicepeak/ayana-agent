import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

export interface CompanionStatus {
  overlay: boolean;
  pip: boolean;
  active: boolean;
  collapsed: boolean;
  permission: boolean;
}
export const nativeIOS = Capacitor.getPlatform() === 'ios';
export const nativeAndroid = Capacitor.getPlatform() === 'android';
interface CompanionPlugin {
  status(): Promise<CompanionStatus>;
  requestPermission(): Promise<{ granted: boolean }>;
  start(): Promise<void>;
  stop(options?: { restore?: boolean }): Promise<void>;
  move(options: { dx: number; dy: number; settle?: boolean }): Promise<void>;
  resize(options: { width: number; height: number }): Promise<void>;
  collapse(options: { collapsed: boolean }): Promise<void>;
  focus(options: { enabled: boolean }): Promise<void>;
  present(options: Record<string, unknown>): Promise<void>;
  connect(options: Record<string, unknown>): Promise<void>;
  send(options: { id: string; text: string }): Promise<void>;
  disconnect(options: { id: string }): Promise<void>;
  addListener(name: 'state', callback: (state: CompanionStatus) => void): Promise<PluginListenerHandle>;
  addListener(name: 'action', callback: (event: { action: string }) => void): Promise<PluginListenerHandle>;
  addListener(name: 'transport', callback: (event: { id: string; kind: string; text?: string; code?: number }) => void): Promise<PluginListenerHandle>;
}
export const NativeCompanion = registerPlugin<CompanionPlugin>('AyanaCompanion');

/** One native iOS socket/player remains alive while WebKit is backgrounded by PiP. */
export class IosGatewaySocket {
  readyState: number = WebSocket.CONNECTING;
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  private id = crypto.randomUUID();
  private listener?: PluginListenerHandle;
  private closed = false;
  constructor(session: Record<string, unknown>) {
    void (async () => {
      this.listener = await NativeCompanion.addListener('transport', event => {
        if (event.id !== this.id || this.closed) return;
        if (event.kind === 'open') { this.readyState = WebSocket.OPEN; this.onopen?.(); }
        if (event.kind === 'message' && event.text) this.onmessage?.({ data: event.text });
        if (event.kind === 'close') this.finish(event.code || 1006);
      });
      if (!this.closed) await NativeCompanion.connect({ ...session, id: this.id });
      else void this.listener.remove();
    })().catch(() => this.finish(1006));
  }
  send(text: string) {
    if (this.readyState !== WebSocket.OPEN) throw new Error('连接已关闭');
    void NativeCompanion.send({ id: this.id, text }).catch(() => this.finish(1006));
  }
  close() {
    if (this.closed) return;
    void NativeCompanion.disconnect({ id: this.id }).catch(() => {});
    this.finish(1000);
  }
  private finish(code: number) {
    if (this.closed) return;
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
    void this.listener?.remove();
    this.onclose?.({ code });
  }
}
