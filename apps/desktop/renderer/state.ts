import { useEffect, useReducer, useRef } from 'react';
import { AudioPlayer } from './audio';
import type { VoicePackState } from '../electron/voicePack';
import type { AyanaBridge, RuntimeEvent } from './types';
import { outfitAsset } from './avatarOutfit';
import { activeCatalog } from './avatarCatalogs';

export interface Speech {
  id: string; order?: number; ja: string; zh: string; en?: string; enError?: string; intent: string; generation: number;
  intensity: number; affect: string;
  assetId: string;
  audioEnabled?: boolean;
  proactive?: boolean;
  state: 'generated' | 'playing' | 'played' | 'partial' | 'cancelled';
  played: number; total: number;
}
export interface Conversation {
  conversation_id: string; title: string; preview: string; created: number; updated: number;
}
export interface PersonalMemory {
  memory_id: string; content: string; edited?: boolean; updated: number;
  source?: { id: number; quote: string; conversation_id: string; created: number };
}
export interface RecordPage {
  items: Record<string, unknown>[]; has_more: boolean; before?: number; request_id?: string; review_id?: string;
}
export interface ModelState {
  connected: boolean; service: string; generation: number; cancelledGeneration: number;
  task: string; voice: string; voiceInfo?: RuntimeEvent; speeches: Speech[]; current?: string; expression: string;
  expressionAt: number; inputState: string;
  settingsLoaded: boolean;
  apiKeyConfigured?: boolean;
  presented?: string; sentenceVersion: number;
  summonVersion: number; attentionObserving: boolean;
  progress: number; settings: Record<string, unknown>;
  history: Record<string, unknown>[];
  tools: RuntimeEvent[]; error?: string; shortcuts?: RuntimeEvent;
  questions: { text: string; generation: number; id: string; order?: number; startedAt?: number }[];
  modelUsage?: RuntimeEvent;
  sources: Record<string, unknown>[]; searchConfigured: boolean;
  conversation?: Conversation; conversations: Conversation[]; persistentHistory: boolean;
  contextSummary: string; contextState: string; retainedTurns: number;
  historyConversationId?: string; historyHasMore: boolean; historyBefore?: number;
  review?: RecordPage; searchResults?: RecordPage; exportPath?: string; exportRequest?: string;
  memories: PersonalMemory[]; memoryEnabled: boolean; memoryState: string;
  voicePack?: VoicePackState;
}
export const initialState: ModelState = {
  connected: false, service: 'starting', generation: 0, cancelledGeneration: -1,
  task: 'idle', voice: 'starting', speeches: [], expression: 'neutral', expressionAt: 0, inputState: 'idle',
  progress: 0, sentenceVersion: 0, summonVersion: 0, attentionObserving: false, settingsLoaded: false, settings: {}, history: [], tools: [], questions: [],
  sources: [], searchConfigured: false,
  conversations: [], persistentHistory: true, contextSummary: '', contextState: 'ready', retainedTurns: 0, historyHasMore: false,
  memories: [], memoryEnabled: true, memoryState: 'ready',
};

export function reduceEvent(state: ModelState, event: RuntimeEvent): ModelState {
  const generation = ['subtitle.translated', 'subtitle.translation-failed'].includes(event.type) ? state.generation : Number(event.generation_id ?? state.generation);
  if (event.protocol_version !== 1) return state;
  // Late receipts belong to the original topic. They may update its stored record,
  // but must never replace the active topic's visible reply or state.
  if (event.conversation_id && state.conversation && event.conversation_id !== state.conversation.conversation_id
      && !['conversation.changed', 'conversations.ready', 'history.ready', 'conversation.review',
        'conversation.search-results', 'conversation.exported', 'conversation.deleted', 'memory.ready'].includes(event.type)) return state;
  // Runtime acknowledgments are persistence confirmations. They can arrive after
  // the next segment starts, so only immediate player receipts drive presentation.
  if (event.type.startsWith('playback.') && typeof event.seq === 'number') return state;
  if (event.type === 'desktop.reset') return { ...initialState, connected: state.connected, settings: state.settings, voiceInfo: state.voiceInfo, voicePack: state.voicePack };
  if (event.type === 'desktop.cancelled' || event.type === 'generation.cancelled') {
    const cancelled = Number(event.cancelled_generation_id ?? generation);
    return {
      ...state, generation: Math.max(state.generation, generation),
      cancelledGeneration: Math.max(state.cancelledGeneration, cancelled),
      current: undefined, presented: undefined, inputState: 'idle', progress: 0, task: 'idle',
      speeches: state.speeches.map(s => s.generation <= cancelled && s.state !== 'played'
        ? { ...s, state: s.state === 'playing' ? 'partial' : 'cancelled' } : s),
    };
  }
  const output = ['utterance.ready', 'utterance.displayed', 'desktop.present', 'subtitle.ready', 'audio.ready', 'playback.started', 'playback.progress', 'source.ready'];
  if (output.includes(event.type) && generation <= state.cancelledGeneration) return state;
  let next = { ...state, generation: Math.max(state.generation, generation) };
  switch (event.type) {
    case 'conversation.review': {
      const page = event as unknown as RecordPage;
      const previous = state.review;
      next.review = { ...page, items: event.prepend && previous && previous.review_id === page.review_id
        ? [...page.items, ...previous.items.filter(old => !page.items.some(item => item.id === old.id))] : page.items };
      break;
    }
    case 'conversation.search-results': {
      const page = event as unknown as RecordPage;
      const previous = state.searchResults;
      next.searchResults = { ...page, items: event.prepend && previous && previous.request_id === page.request_id
        ? [...previous.items, ...page.items.filter(item => !previous.items.some(old => old.id === item.id))] : page.items };
      break;
    }
    case 'conversation.exported': next.exportPath = String(event.path); next.exportRequest = String(event.request_id || ''); break;
    case 'conversation.deleted':
      if (state.review?.review_id === event.deleted_id) next.review = undefined;
      next.searchResults = undefined; break;
    case 'memory.ready':
      next.memories = (event.memories ?? []) as PersonalMemory[];
      next.memoryEnabled = Boolean(event.enabled); next.memoryState = String(event.state || 'ready'); break;
    case 'conversation.changed':
    case 'conversations.ready': {
      const current = event.current as Conversation;
      if (event.type === 'conversation.changed' || state.conversation?.conversation_id !== current.conversation_id) {
        next = { ...next, speeches: [], questions: [], current: undefined, presented: undefined, task: 'idle',
          tools: [], sources: [], history: [],
          historyConversationId: undefined, historyHasMore: false, historyBefore: undefined,
          error: undefined, contextState: 'ready' };
      }
      next.conversation = current;
      next.conversations = event.conversations as Conversation[];
      next.persistentHistory = Boolean(event.persistent);
      next.contextSummary = String(event.summary || '');
      next.retainedTurns = Number(event.retained_turns || 0);
      break;
    }
    case 'context.state': next.contextState = String(event.state); break;
    case 'capabilities.ready':
      next.searchConfigured = Boolean(event.search_configured); break;
    case 'sources.ready':
      if (event.sources_conversation_id === state.conversation?.conversation_id) next.sources = (event.sources || []) as Record<string, unknown>[];
      break;
    case 'source.ready': {
      const source = event.source as Record<string, unknown>;
      next.sources = [source, ...state.sources.filter(s => s.source_id !== source.source_id
        && (!source.url || s.url !== source.url))].slice(0, 100); break;
    }
    case 'desktop.summoned': next.summonVersion = state.summonVersion + 1; break;
    case 'attention.state': next.attentionObserving = event.observing === true; break;
    case 'desktop.dismiss-error': next.error = undefined; break;
    case 'desktop.service':
      next.connected = Boolean(event.connected); next.service = String(event.state); break;
    case 'desktop.shortcuts': next.shortcuts = event; break;
    case 'service.state': {
      const name = String(event.service || event.name || '');
      if (/tts|voice/i.test(name)) {
        next.voice = String(event.state || 'unavailable');
        next.voiceInfo = event;
      }
      break;
    }
    case 'voice.pack.state':
      next.voicePack = { ...(state.voicePack || {}), ...event } as unknown as VoicePackState;
      break;
    case 'session.started':
      next.error = undefined; break;
    case 'task.state': next.task = String(event.state || 'idle'); break;
    case 'input.state': next.inputState = String(event.state || 'idle'); break;
    case 'settings.ready': {
      next.settings = (event.settings ?? {}) as Record<string, unknown>;
      next.apiKeyConfigured = typeof event.api_key_configured === 'boolean' ? event.api_key_configured : state.apiKeyConfigured;
      if (!state.settingsLoaded || next.settings.avatar_costume !== state.settings.avatar_costume
        || next.settings.character !== state.settings.character) {
        const costume = String(next.settings.avatar_costume || '校服');
        next.expression = outfitAsset(state.expression, costume, activeCatalog(next.settings));
      }
      next.settingsLoaded = true;
      break;
    }
    case 'model.usage': next.modelUsage = event; break;
    case 'history.ready': {
      const cid = String(event.history_conversation_id || '');
      if (state.conversation && cid !== state.conversation.conversation_id) break;
      const items = (event.history ?? []) as Record<string, unknown>[];
      next.history = event.prepend && state.historyConversationId === cid
        ? [...items, ...state.history.filter(old => !items.some(item => item.id === old.id))]
        : items;
      next.historyConversationId = cid;
      next.historyHasMore = Boolean(event.has_more);
      next.historyBefore = event.before == null ? undefined : Number(event.before);
      break;
    }
    case 'user.message':
    case 'desktop.question':
      next.questions = [...state.questions, { text: String(event.text), generation, id: String(event.turn_id || event.id || generation), startedAt: Date.now(), order: Number(event.seq || generation * 1000 + state.questions.length + state.speeches.length) }];
      next.error = undefined; next.task = 'thinking'; break;
    case 'utterance.ready':
      if (!state.speeches.some(s => s.id === event.utterance_id)) {
        next.speeches = [...state.speeches, { id: String(event.utterance_id), order: Number(event.seq || generation * 1000 + state.questions.length + state.speeches.length), ja: String(event.speech_ja), zh: '', intent: String(event.intent || 'explain'), assetId: String(event.asset_id || ''), audioEnabled: event.audio_enabled !== false, proactive: String(event.turn_id || '').startsWith('peek-'), generation, intensity: Number(event.intensity || 0), affect: String(event.affect || 'neutral'), state: 'generated' as const, played: 0, total: 0 }].slice(-80);
      }
      break;
    case 'subtitle.ready':
    case 'subtitle.translated': {
      const patch = { ...(typeof event.display_zh === 'string' ? { zh: event.display_zh } : {}), ...(typeof event.display_en === 'string' ? { en: event.display_en, enError: undefined } : {}) };
      next.speeches = state.speeches.map(s => s.id === event.utterance_id ? { ...s, ...patch } : s);
      next.history = state.history.map(item => item.utterance_id === event.utterance_id ? { ...item,
        ...(typeof event.display_zh === 'string' ? { display_zh: event.display_zh } : {}), ...(typeof event.display_en === 'string' ? { display_en: event.display_en } : {}) } : item);
      break;
    }
    case 'subtitle.translation-failed':
      next.speeches = state.speeches.map(s => (event.utterance_ids as string[] || []).includes(s.id) ? { ...s, enError: String(event.message) } : s);
      next.history = state.history.map(item => (event.utterance_ids as string[] || []).includes(String(item.utterance_id)) ? { ...item, en_error: String(event.message) } : item);
      break;
    case 'desktop.present':
    case 'playback.started': {
      const id = String(event.utterance_id);
      const speech = state.speeches.find(s => s.id === id);
      if (!speech) break;
      const presentedAt = state.speeches.findIndex(s => s.id === state.presented);
      const eventAt = state.speeches.findIndex(s => s.id === id);
      const canPresent = presentedAt < 0 || eventAt < 0 || eventAt >= presentedAt;
      if (canPresent) {
        if (event.type === 'playback.started') { next.current = id; next.progress = 0; }
        if (state.presented !== id) { next.presented = id; next.sentenceVersion = state.sentenceVersion + 1; }
        const expression = ['explain', 'encourage', 'caution', 'playful'].includes(speech.intent) ? speech.intent : 'neutral';
        if (speech.assetId || speech.intensity >= .35) {
          next.expression = outfitAsset(speech.assetId || expression, String(state.settings.avatar_costume || '校服'), activeCatalog(state.settings));
          next.expressionAt = Date.now();
        }
      }
      if (event.type === 'playback.started') next.speeches = state.speeches.map(s => s.id === id ? { ...s, state: 'playing', total: Number(event.total_samples) } : s);
      break;
    }
    case 'playback.progress':
    case 'playback.cancelled':
    case 'playback.ended': {
      const played = Number(event.played_samples); const total = Number(event.total_samples);
      next.speeches = state.speeches.map(s => s.id === event.utterance_id ? {
        ...s, played, total,
        state: event.type === 'playback.cancelled' ? 'partial' : event.type === 'playback.ended' ? 'played' : 'playing',
      } : s);
      if (next.current === event.utterance_id) {
        next.progress = total ? played / total : 0;
        if (event.type === 'playback.ended' || event.type === 'playback.cancelled') { next.current = undefined; next.progress = 0; }
      }
      break;
    }
    case 'tool.started':
    case 'tool.progress':
    case 'tool.completed':
    case 'tool.failed':
      next.tools = [...state.tools, event].slice(-150); break;
    case 'error':
      // Correlated command errors are shown by the initiating form. They must
      // neither duplicate its feedback nor mark an unrelated live reply failed.
      if (event.request_id) break;
      next.error = String(event.message || event.error || '发生了未知错误。'); next.task = 'failed'; break;
  }
  return next;
}

// A static browser preview never pretends to be a connected runtime.
const previewBridge: AyanaBridge = {
  send: async () => ({ ok: false, error: '此页面仅用于界面预览。请通过桌面应用启动本地服务。' }),
  onEvent: () => () => {}, playback: () => {}, summon: async () => {}, hide: async () => {}, openSettings: async () => {}, hideSettings: async () => {},
  setCompanionInteractive: () => {}, moveCompanion: () => {}, openCompanionMenu: async () => {},
  beginCompanionDrag: () => {}, endCompanionDrag: () => {}, openDesign: async () => {}, closeDesign: async () => {}, previewDesign: () => {},
  revertDesignPreview: async () => {},
  chooseNoteBackground: async () => ({ ok: false, error: '请在桌面应用中选择图片。' }),
  restart: async () => {},
  restartApp: async () => {},
  beginTalk: async () => ({ ok: false }), endTalk: async () => {},
  openWelcome: async () => {}, welcomeTarget: async () => null,
  finishWelcome: async () => ({ ok: false, error: '请在桌面应用中打开初次见面。' }), closeWelcome: async () => {},
  welcomeShortcutCapture: async () => ({ ok: false }),
  welcomeShortcutCheck: async () => ({ ok: false, error: '请在桌面应用中设置快捷键。' }),
  voicePack: {
    get: async () => null,
    start: async () => null,
    cancel: async () => null,
    importLocal: async () => null,
  },
  getState: async () => ({ connected: false, service: 'preview', version: '0.3.3', events: [] }),
};
export const bridge = window.ayana ?? previewBridge;

export function nextTextSpeech(state: ModelState, textOnly: boolean): Speech | undefined {
  const candidates = state.speeches.filter(speech => speech.generation === state.generation
    && speech.state !== 'cancelled' && speech.state !== 'partial');
  const index = candidates.findIndex(speech => speech.id === state.presented);
  const next = candidates[index + 1];
  if (!textOnly && (state.current || next?.audioEnabled !== false
    || candidates.slice(0, index + 1).some(speech => speech.audioEnabled !== false && speech.state !== 'played'))) return;
  return next;
}

export function useRuntime(isChat: boolean) {
  const [state, dispatch] = useReducer(reduceEvent, initialState);
  const player = useRef<AudioPlayer | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (isChat) player.current = new AudioPlayer(bridge, dispatch);
    const consume = (event: RuntimeEvent) => {
      if (event.type === 'desktop.cancelled' || event.type === 'generation.cancelled') {
        player.current?.cancel(Number(event.cancelled_generation_id ?? event.generation_id ?? stateRef.current.generation));
      }
      if (event.type === 'desktop.reset') {
        player.current?.dispose();
        if (isChat) player.current = new AudioPlayer(bridge, dispatch);
      }
      if (event.type === 'audio.ready') player.current?.enqueue(event);
      if (isChat && event.type === 'utterance.ready' && /^[a-z0-9_-]{1,80}$/i.test(String(event.asset_id || ''))) {
        // Decode ahead without changing the displayed face before playback.
        const image = new Image();
        image.src = `ayana-asset://${event.asset_id}/`;
      }
      dispatch(event);
      if (isChat && event.type === 'playback.started' && typeof event.seq !== 'number' && Number(event.generation_id) > stateRef.current.cancelledGeneration) {
        void bridge.send({ type: 'utterance.displayed', utterance_id: event.utterance_id, generation_id: event.generation_id });
      }
    };
    const off = bridge.onEvent(consume);
    void bridge.getState().then(snapshot => {
      dispatch({ protocol_version: 1, type: 'desktop.service', connected: snapshot.connected, state: snapshot.service });
      if (snapshot.voicePack) dispatch({ protocol_version: 1, type: 'voice.pack.state', ...snapshot.voicePack });
      snapshot.events.forEach(dispatch);
    });
    return () => { off(); player.current?.dispose(); player.current = null; };
  }, [isChat]);
  return { state, dispatch, player };
}
