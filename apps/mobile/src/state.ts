import type { Conversation, HistoryRecord, PublicSettings, RuntimeEvent, Speech } from './types';

export interface MobileState {
  connected: boolean;
  service: string;
  settings: PublicSettings;
  settingsLoaded: boolean;
  defaultAsset: string;
  character: string;
  costume: string;
  speeches: Speech[];
  history: HistoryRecord[];
  historyConversationId?: string;
  conversation?: Conversation;
  conversations: Conversation[];
  presented?: string;
  current?: string;
  progress: number;
  task: 'idle' | 'thinking' | 'failed';
  inputState: string;
  generation: number;
  cancelledGeneration: number;
  voice: string;
  voiceInfo: Record<string, unknown>;
  error?: string;
  sources: Record<string, unknown>[];
  persistentHistory: boolean;
}

export const initialState: MobileState = {
  connected: false,
  service: 'idle',
  settings: {},
  settingsLoaded: false,
  defaultAsset: 'neutral',
  character: 'ayana',
  costume: '校服',
  speeches: [],
  history: [],
  conversations: [],
  progress: 0,
  task: 'idle',
  inputState: 'idle',
  generation: 0,
  cancelledGeneration: 0,
  voice: 'unknown',
  voiceInfo: {},
  sources: [],
  persistentHistory: true,
};

function speechFromEvent(event: RuntimeEvent): Speech {
  return {
    id: String(event.utterance_id),
    turnId: typeof event.turn_id === 'string' ? event.turn_id : undefined,
    ja: String(event.speech_ja || ''),
    zh: '',
    generation: Number(event.generation_id || 0),
    assetId: String(event.asset_id || ''),
    audioEnabled: event.audio_enabled !== false,
    intent: String(event.intent || 'explain'),
    intensity: Number(event.intensity || 0),
    state: 'generated',
    played: 0,
    total: 0,
  };
}

/** Show only the head sentence while its audio is being prepared. */
export function nextSpeechPreview(state: MobileState, primary: string) {
  if (state.current || state.voice === 'failed' || state.settings.voice?.voice_mode === 'silent') return;
  const speech = state.speeches.find(item => item.state === 'generated' && item.generation > state.cancelledGeneration);
  if (!speech || speech.previewed || !speech.audioEnabled) return;
  if (primary !== 'ja' && !speech.zh && !(primary === 'en' && speech.en)) return;
  return speech;
}

export function replyWaitLabel(state: MobileState) {
  if (state.current) return '';
  const pending = state.speeches.find(item => item.state === 'generated');
  if (pending) return pending.audioEnabled && state.voice !== 'failed' && state.settings.voice?.voice_mode !== 'silent'
    ? '正在准备语音…' : '正在整理文字…';
  return state.task === 'thinking' ? '正在想…' : '';
}

export function reduceEvent(state: MobileState, event: RuntimeEvent): MobileState {
  if (event.type === 'mobile.reset') return { ...initialState };
  if (event.conversation_id && state.conversation && event.conversation_id !== state.conversation.conversation_id
      && !['conversation.changed', 'conversations.ready', 'history.ready', 'conversation.deleted'].includes(event.type)) {
    return state;
  }
  if (event.type === 'bridge.status') {
    return { ...state, connected: Boolean(event.connected), service: String(event.service || state.service) };
  }
  if (event.type.startsWith('playback.') && typeof event.seq === 'number') return state;
  if (event.type === 'generation.cancelled' || event.type === 'mobile.cancelled') {
    const cancelled = Number(event.cancelled_generation_id ?? event.generation_id ?? state.generation);
    return {
      ...state,
      generation: Math.max(state.generation, Number(event.generation_id ?? state.generation)),
      cancelledGeneration: Math.max(state.cancelledGeneration, cancelled),
      current: undefined,
      presented: state.presented,
      progress: 0,
      task: 'idle',
      inputState: 'idle',
      speeches: state.speeches.map(speech => speech.generation <= cancelled && speech.state !== 'played'
        ? { ...speech, state: speech.state === 'playing' || speech.previewed ? 'partial' : 'cancelled' }
        : speech),
    };
  }
  const generation = Number(event.generation_id ?? state.generation);
  if (['utterance.ready', 'subtitle.ready', 'subtitle.translated', 'audio.ready', 'playback.started',
       'playback.progress', 'playback.ended', 'playback.cancelled', 'playback.error', 'mobile.preview', 'mobile.present', 'source.ready', 'task.state', 'error'].includes(event.type)
      && generation <= state.cancelledGeneration) {
    return state;
  }
  let next: MobileState = { ...state, generation: Math.max(state.generation, generation) };
  switch (event.type) {
    case 'session.started':
      return next;
    case 'settings.ready': {
      const settings = (event.settings || {}) as PublicSettings;
      if (settings.character !== state.settings.character || settings.avatar_costume !== state.settings.avatar_costume) {
        next.presented = undefined;
      }
      next.settings = settings;
      next.settingsLoaded = true;
      next.defaultAsset = String(event.default_asset_id || next.defaultAsset);
      next.character = String(event.avatar_character || settings.character || next.character);
      next.costume = String(event.avatar_costume || settings.avatar_costume || next.costume);
      return next;
    }
    case 'service.state': {
      if (event.service === 'tts') {
        next.voice = String(event.state || 'unknown');
        next.voiceInfo = { ...next.voiceInfo, ...event };
      }
      return next;
    }
    case 'utterance.ready': {
      if (next.speeches.some(speech => speech.id === event.utterance_id)) return next;
      const speech = speechFromEvent(event);
      next.speeches = [...next.speeches, speech];
      if (!next.history.some(item => item.utterance_id === speech.id)) {
        next.history = [...next.history, { role: 'assistant', utterance_id: speech.id, turn_id: speech.turnId,
          speech_ja: speech.ja, generation_id: speech.generation, displayed: false, status: 'generated' }];
      }
      return next;
    }
    case 'subtitle.ready':
    case 'subtitle.translated': {
      const patch = {
        ...(typeof event.display_zh === 'string' ? { zh: event.display_zh } : {}),
        ...(typeof event.display_en === 'string' ? { en: event.display_en } : {}),
      };
      next.speeches = next.speeches.map(speech => speech.id === event.utterance_id ? { ...speech, ...patch } : speech);
      next.history = next.history.map(item => item.utterance_id === event.utterance_id ? { ...item,
        ...(typeof event.display_zh === 'string' ? { display_zh: event.display_zh } : {}),
        ...(typeof event.display_en === 'string' ? { display_en: event.display_en } : {}) } : item);
      return next;
    }
    case 'playback.started': {
      const speech = next.speeches.find(item => item.id === event.utterance_id);
      if (!speech) return next;
      next.current = speech.id;
      next.presented = speech.id;
      next.progress = 0;
      next.speeches = next.speeches.map(item => item.id === speech.id
        ? { ...item, state: 'playing', total: Number(event.total_samples || item.total) }
        : item);
      return next;
    }
    case 'playback.progress':
    case 'playback.cancelled':
    case 'playback.error':
    case 'playback.ended': {
      const played = Number(event.played_samples || 0);
      const total = Number(event.total_samples || 0);
      next.speeches = next.speeches.map(speech => speech.id === event.utterance_id ? {
        ...speech,
        played,
        total,
        state: event.type === 'playback.cancelled' ? (played || speech.previewed ? 'partial' : 'cancelled')
          : event.type === 'playback.ended' ? 'played' : event.type === 'playback.error' ? 'generated' : 'playing',
      } : speech);
      if (next.current === event.utterance_id) {
        next.progress = total ? played / total : 0;
        if (event.type !== 'playback.progress') {
          next.current = undefined;
          next.progress = 0;
        }
      }
      return next;
    }
    case 'mobile.preview': {
      const speech = next.speeches.find(item => item.state === 'generated' && item.generation > state.cancelledGeneration);
      if (state.current || !speech || speech.id !== event.utterance_id || speech.previewed) return state;
      next.presented = speech.id;
      next.speeches = next.speeches.map(item => item.id === speech.id ? { ...item, previewed: true } : item);
      return next;
    }
    case 'mobile.present': {
      const speech = next.speeches.find(item => item.id === event.utterance_id && item.state === 'generated');
      if (!speech) return state;
      next.presented = speech.id;
      next.speeches = next.speeches.map(item => item.id === speech.id ? { ...item, state: 'played' } : item);
      return next;
    }
    case 'user.message': {
      const id = event.seq ? Number(event.seq) : undefined;
      const exists = next.history.some(item => item.turn_id && item.turn_id === event.turn_id);
      if (!exists) {
        next.history = [...next.history, {
          id, role: 'user', text: String(event.text || ''), turn_id: String(event.turn_id || ''),
        }];
      }
      next.error = undefined;
      next.task = 'thinking';
      return next;
    }
    case 'history.ready': {
      const cid = String(event.history_conversation_id || '');
      if (next.conversation && cid && cid !== next.conversation.conversation_id) return next;
      const items = (event.history ?? []) as HistoryRecord[];
      if (event.prepend) {
        const existing = next.history.filter(item => !items.some(entry => entry.id === item.id));
        next.history = [...items, ...existing];
      } else {
        next.history = items;
      }
      next.historyConversationId = cid || next.historyConversationId;
      return next;
    }
    case 'conversations.ready':
    case 'conversation.changed': {
      const current = event.current as Conversation | undefined;
      if (!current) return next;
      if (event.type === 'conversation.changed' || next.conversation?.conversation_id !== current.conversation_id) {
        next.speeches = [];
        next.history = [];
        next.current = undefined;
        next.presented = undefined;
        next.progress = 0;
        next.task = 'idle';
        next.sources = [];
        next.error = undefined;
        next.historyConversationId = undefined;
      }
      next.conversation = current;
      next.conversations = (event.conversations ?? []) as Conversation[];
      next.persistentHistory = Boolean(event.persistent);
      return next;
    }
    case 'conversation.deleted':
      next.conversations = next.conversations.filter(item => item.conversation_id !== event.deleted_id);
      return next;
    case 'sources.ready':
      if (event.sources_conversation_id === next.conversation?.conversation_id) {
        next.sources = (event.sources ?? []) as Record<string, unknown>[];
      }
      return next;
    case 'source.ready': {
      const source = event.source as Record<string, unknown> | undefined;
      if (source) next.sources = [...next.sources, source].slice(-20);
      return next;
    }
    case 'task.state':
      next.task = event.state === 'thinking' ? 'thinking' : event.state === 'failed' ? 'failed' : 'idle';
      return next;
    case 'input.state':
      next.inputState = String(event.state || 'idle');
      return next;
    case 'error':
      if (event.request_id) return next;
      next.error = String(event.message || event.error || '发生了未知错误。');
      if (event.source === 'turn') next.task = 'failed';
      return next;
    default:
      return next;
  }
}
