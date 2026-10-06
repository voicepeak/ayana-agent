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
  connected: boolean;
  service: string;
  version: string;
  repositoryRoot: string;
  events: RuntimeEvent[];
  composerRequested?: boolean;
  designPreview?: Record<string, unknown>;
  designDraft?: Record<string, unknown>;
  designOpen?: boolean;
}

export interface AyanaBridge {
  send(command: RuntimeCommand): Promise<{ ok: boolean; error?: string }>;
  onEvent(callback: (event: RuntimeEvent) => void): () => void;
  playback(receipt: RuntimeEvent): void;
  summon(): Promise<void>;
  hide(): Promise<void>;
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
  openSettings(tab?: 'tasks' | 'history'): Promise<void>;
  hideSettings(): Promise<void>;
  chooseRepository(): Promise<string | null>;
  chooseDirectory(): Promise<string | null>;
  restart(): Promise<void>;
  getState(): Promise<DesktopState>;
}

declare global {
  interface Window { ayana?: AyanaBridge; }
}
