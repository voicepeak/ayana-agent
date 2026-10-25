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

export interface Conversation {
  conversation_id: string;
  title: string;
  preview?: string;
  updated?: number;
  created?: number;
}

export interface Speech {
  id: string;
  turnId?: string;
  ja: string;
  zh: string;
  en?: string;
  generation: number;
  assetId: string;
  audioEnabled: boolean;
  previewed?: boolean;
  intent: string;
  intensity: number;
  state: 'generated' | 'playing' | 'played' | 'partial' | 'cancelled';
  played: number;
  total: number;
}

export interface HistoryRecord {
  id?: number;
  role?: string;
  text?: string;
  display_zh?: string;
  display_en?: string;
  speech_ja?: string;
  utterance_id?: string;
  turn_id?: string;
  status?: string;
  displayed?: boolean;
  played_samples?: number;
  total_samples?: number;
  generation_id?: number;
  asset_id?: string;
}

export interface PublicSettings {
  user_name?: string;
  avatar_costume?: string;
  character?: string;
  volume?: number;
  subtitles?: boolean;
  primary_language?: string;
  translation_language?: string;
  companion_ui?: {
    theme?: string;
    background_color?: string;
    bubble_color?: string;
    primary_language?: string;
    translation_language?: string;
    show_subtitles?: boolean;
    [key: string]: unknown;
  };
  voice?: { voice_mode?: string; restart_pending?: boolean; [key: string]: unknown };
  [key: string]: unknown;
}

export interface Bootstrap {
  version: string;
  protocol_version: number;
  settings: PublicSettings;
  tts: Record<string, unknown>;
  avatar_character: string;
  avatar_costume: string;
  default_asset_id: string;
}

export interface ConnectionState {
  paired: boolean;
  connected: boolean;
  service: string;
  error?: string;
}
