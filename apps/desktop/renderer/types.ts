export interface RuntimeEvent {
  protocol_version: number;
  type: string;
  session_id?: string;
  turn_id?: string;
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
}

export interface AyanaBridge {
  send(command: RuntimeCommand): Promise<{ ok: boolean; error?: string }>;
  onEvent(callback: (event: RuntimeEvent) => void): () => void;
  playback(receipt: RuntimeEvent): void;
  summon(): Promise<void>;
  hide(): Promise<void>;
  openSettings(tab?: 'tasks'): Promise<void>;
  hideSettings(): Promise<void>;
  chooseRepository(): Promise<string | null>;
  chooseDirectory(): Promise<string | null>;
  restart(): Promise<void>;
  getState(): Promise<DesktopState>;
}

declare global {
  interface Window { ayana?: AyanaBridge; }
}
