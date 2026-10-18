import type { VoicePackState } from '../electron/voicePack';

export interface RuntimeEvent {
  protocol_version: number;
  type: string;
  session_id?: string;
  turn_id?: string;
  conversation_id?: string;
  generation_id?: number;
  seq?: number;
  [key: string]: unknown;
}

export interface RuntimeCommand {
  type: string;
  [key: string]: unknown;
}

export interface DesktopState {
  companionViewport?: { width: number; height: number };
  inspectorViewport?: { width: number; height: number; x: number; y: number };
  connected: boolean;
  service: string;
  version: string;
  events: RuntimeEvent[];
  composerRequested?: boolean;
  designPreview?: Record<string, unknown>;
  designDraft?: Record<string, unknown>;
  designOpen?: boolean;
  voicePack?: VoicePackState;
  welcomeReplay?: boolean;
  welcomeRun?: number;
}

export interface AyanaBridge {
  send(command: RuntimeCommand): Promise<{ ok: boolean; error?: string }>;
  onEvent(callback: (event: RuntimeEvent) => void): () => void;
  playback(receipt: RuntimeEvent): void;
  summon(): Promise<void>;
  hide(): Promise<void>;
  beginTalk(): Promise<{ ok: boolean; hold_id?: string }>;
  endTalk(id: string, cancelled?: boolean): Promise<void>;
  setCompanionInteractive(interactive: boolean): void;
  moveCompanion(dx: number, dy: number): void;
  beginCompanionDrag(): void;
  endCompanionDrag(): void;
  openDesign(): Promise<void>;
  closeDesign(): Promise<void>;
  previewDesign(value: Record<string, unknown>): void;
  revertDesignPreview(): Promise<void>;
  openCompanionMenu(): Promise<void>;
  chooseNoteBackground(): Promise<{ ok: boolean; error?: string; imageId?: string }>;
  openSettings(tab?: 'history' | 'model'): Promise<void>;
  openWelcome(): Promise<void>;
  welcomeTarget(): Promise<{ x: number; y: number; width: number; height: number; asset: string } | null>;
  finishWelcome(configure?: boolean): Promise<{ ok: boolean; error?: string }>;
  closeWelcome(): Promise<void>;
  welcomeShortcutCapture(capturing: boolean): Promise<{ ok: boolean; summon_ok?: boolean; talk_ok?: boolean; cancel_ok?: boolean }>;
  welcomeShortcutCheck(field: 'hotkey' | 'talk_hotkey', value: string): Promise<{ ok: boolean; normalized?: string; error?: string }>;
  hideSettings(): Promise<void>;
  restart(): Promise<void>;
  restartApp(): Promise<void>;
  voicePack: {
    get(): Promise<VoicePackState | null>;
    start(): Promise<VoicePackState | null>;
    cancel(): Promise<VoicePackState | null>;
    importLocal(): Promise<VoicePackState | null>;
  };
  getState(): Promise<DesktopState>;
}

declare global {
  interface Window { ayana?: AyanaBridge; }
}
