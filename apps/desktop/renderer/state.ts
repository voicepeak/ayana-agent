import { useEffect, useReducer, useRef } from 'react';
import { AudioPlayer } from './audio';
import type { AyanaBridge, RuntimeEvent } from './types';

export interface Speech {
  id: string; ja: string; zh: string; intent: string; generation: number;
  intensity: number; affect: string;
  assetId: string;
  state: 'generated' | 'playing' | 'played' | 'partial' | 'cancelled';
  played: number; total: number;
}
export interface Evidence { path: string; content: string; start_line?: number; line?: number; }
export interface Target { hwnd?: number; target_id?: string; title?: string; process_id?: number; bounds?: Record<string, number>; }
export interface Repository { root: string; name: string; files: string[]; evidence: Evidence[]; }
export interface Conversation {
  conversation_id: string; title: string; preview: string; created: number; updated: number;
  repository_root?: string;
}
export interface ModelState {
  connected: boolean; service: string; generation: number; cancelledGeneration: number;
  task: string; voice: string; mode: 'teach' | 'execute'; target?: Target;
  snapshot?: RuntimeEvent; speeches: Speech[]; current?: string; expression: string;
  expressionAt: number; inputState: string;
  settingsLoaded: boolean;
  presented?: string; sentenceVersion: number;
  summonVersion: number; workspaceHintAt: number; targetCue?: RuntimeEvent;
  progress: number; repository?: Repository; settings: Record<string, unknown>;
  history: Record<string, unknown>[]; windows: Target[]; evidence: Evidence[];
  actions: RuntimeEvent[]; tools: RuntimeEvent[]; error?: string; shortcuts?: RuntimeEvent;
  questions: { text: string; generation: number; id: string }[];
  modelUsage?: RuntimeEvent;
  activeTask?: Record<string, unknown>; taskHistory: Record<string, unknown>[];
  approvals: Record<string, unknown>[]; artifacts: Record<string, unknown>[];
  sources: Record<string, unknown>[]; directories: Record<string, unknown>[]; searchConfigured: boolean;
  computerUse?: Record<string, unknown>; computerProgress: RuntimeEvent[]; computerResult?: Record<string, unknown>;
  conversation?: Conversation; conversations: Conversation[]; persistentHistory: boolean;
  contextSummary: string; contextState: string; retainedTurns: number;
  historyConversationId?: string; historyHasMore: boolean; historyBefore?: number;
}
export const initialState: ModelState = {
  connected: false, service: 'starting', generation: 0, cancelledGeneration: -1,
  task: 'idle', voice: 'starting', mode: 'teach', speeches: [], expression: 'neutral', expressionAt: 0, inputState: 'idle',
  progress: 0, sentenceVersion: 0, summonVersion: 0, workspaceHintAt: 0, settingsLoaded: false, settings: {}, history: [], windows: [], evidence: [], actions: [], tools: [], questions: [],
  approvals: [], artifacts: [], sources: [], directories: [], taskHistory: [], searchConfigured: false,
  computerProgress: [],
  conversations: [], persistentHistory: true, contextSummary: '', contextState: 'ready', retainedTurns: 0, historyHasMore: false,
};

export function reduceEvent(state: ModelState, event: RuntimeEvent): ModelState {
  const generation = Number(event.generation_id ?? state.generation);
  if (event.protocol_version !== 1) return state;
  // Late receipts belong to the original topic. They may update its stored record,
  // but must never replace the active topic's visible reply or task.
  if (event.conversation_id && state.conversation && event.conversation_id !== state.conversation.conversation_id
      && !['conversation.changed', 'conversations.ready', 'history.ready'].includes(event.type)) return state;
  // Runtime acknowledgments are persistence confirmations. They can arrive after
  // the next segment starts, so only immediate player receipts drive presentation.
  if (event.type.startsWith('playback.') && typeof event.seq === 'number') return state;
  if (event.type === 'desktop.reset') return { ...initialState, connected: state.connected, settings: state.settings };
  if (event.type === 'desktop.cancelled' || event.type === 'generation.cancelled') {
    const cancelled = Number(event.cancelled_generation_id ?? generation);
    return {
      ...state, generation: Math.max(state.generation, generation),
      cancelledGeneration: Math.max(state.cancelledGeneration, cancelled),
      current: undefined, presented: undefined, inputState: 'idle', progress: 0, task: 'idle', actions: [], approvals: [],
      computerProgress: [], computerResult: undefined,
      speeches: state.speeches.map(s => s.generation <= cancelled && s.state !== 'played'
        ? { ...s, state: s.state === 'playing' ? 'partial' : 'cancelled' } : s),
    };
  }
  const output = ['utterance.ready', 'utterance.displayed', 'desktop.present', 'subtitle.ready', 'audio.ready', 'action.proposed', 'evidence.ready', 'playback.started', 'playback.progress', 'approval.required', 'artifact.ready', 'source.ready'];
  if (output.includes(event.type) && generation <= state.cancelledGeneration) return state;
  let next = { ...state, generation: Math.max(state.generation, generation) };
  switch (event.type) {
    case 'conversation.changed':
    case 'conversations.ready': {
      const current = event.current as Conversation;
      if (event.type === 'conversation.changed' || state.conversation?.conversation_id !== current.conversation_id) {
        next = { ...next, speeches: [], questions: [], current: undefined, presented: undefined, task: 'idle',
          activeTask: undefined, tools: [], actions: [], approvals: [], sources: [], history: [],
          historyConversationId: undefined, historyHasMore: false, historyBefore: undefined,
          computerProgress: [], computerResult: undefined, error: undefined, contextState: 'ready' };
        next.repository = event.repository ? event.repository as unknown as Repository : undefined;
        next.evidence = next.repository?.evidence || [];
        next.target = event.target ? event.target as Target : undefined;
        next.snapshot = undefined;
      }
      next.conversation = current;
      next.conversations = event.conversations as Conversation[];
      next.persistentHistory = Boolean(event.persistent);
      next.contextSummary = String(event.summary || '');
      next.retainedTurns = Number(event.retained_turns || 0);
      break;
    }
    case 'context.state': next.contextState = String(event.state); break;
    case 'repository.cleared': next.repository = undefined; next.evidence = []; break;
    case 'capabilities.ready':
      next.directories = (event.directories ?? []) as Record<string, unknown>[];
      next.artifacts = (event.artifacts ?? []) as Record<string, unknown>[];
      next.taskHistory = (event.tasks ?? []) as Record<string, unknown>[];
      next.computerUse = event.computer_use as Record<string, unknown>;
      next.searchConfigured = Boolean(event.search_configured); break;
    case 'computer.progress':
      if (generation <= state.cancelledGeneration || generation < state.generation) break;
      next.computerProgress = [...state.computerProgress, event.progress as RuntimeEvent].slice(-30); break;
    case 'computer.completed':
      if (generation <= state.cancelledGeneration || generation < state.generation) break;
      next.computerResult = event.result as Record<string, unknown>; break;
    case 'task.updated': {
      const task = event.task as Record<string, unknown>;
      if (generation < state.generation) break;
      next.activeTask = task;
      next.taskHistory = [task, ...state.taskHistory.filter(t => t.task_id !== task.task_id)].slice(0, 30);
      break;
    }
    case 'approval.required': {
      const approval = event.approval as Record<string, unknown>;
      next.approvals = [...state.approvals.filter(a => a.approval_id !== approval.approval_id), approval]; break;
    }
    case 'approval.resolved':
      next.approvals = state.approvals.filter(a => a.approval_id !== event.approval_id);
      next.actions = state.actions.filter(a => (a.action as Record<string, unknown>)?.action_id !== event.approval_id); break;
    case 'artifact.ready': {
      const artifact = event.artifact as Record<string, unknown>;
      next.artifacts = [artifact, ...state.artifacts.filter(a => a.artifact_id !== artifact.artifact_id)].slice(0, 60); break;
    }
    case 'source.ready': {
      const source = event.source as Record<string, unknown>;
      next.sources = [source, ...state.sources.filter(s => s.source_id !== source.source_id)].slice(0, 100); break;
    }
    case 'desktop.summoned': next.summonVersion = state.summonVersion + 1; break;
    case 'desktop.workspace-hint': next.workspaceHintAt = Date.now(); break;
    case 'desktop.target-cue': next.targetCue = event; break;
    case 'desktop.dismiss-error': next.error = undefined; break;
    case 'desktop.service':
      next.connected = Boolean(event.connected); next.service = String(event.state); break;
    case 'desktop.shortcuts': next.shortcuts = event; break;
    case 'service.state': {
      const name = String(event.service || event.name || '');
      if (/tts|voice/i.test(name)) next.voice = String(event.state || 'unavailable');
      break;
    }
    case 'session.started':
      next.target = event.target ? event.target as Target : undefined;
      next.snapshot = undefined;
      next.task = next.target ? 'observing' : 'idle'; next.error = undefined; break;
    case 'task.state': next.task = String(event.state || 'idle'); break;
    case 'input.state': next.inputState = String(event.state || 'idle'); break;
    case 'mode.ready': next.mode = event.mode === 'execute' ? 'execute' : 'teach'; break;
    case 'target.bound': next.target = (event.target ?? event.window ?? event) as Target; next.snapshot = undefined; break;
    case 'snapshot.ready': next.snapshot = event; next.target = (event.target ?? next.target) as Target; if (next.task === 'observing') next.task = 'idle'; break;
    case 'snapshot.invalidated': next.snapshot = undefined; next.actions = []; break;
    case 'windows.list': next.windows = (event.windows ?? []) as Target[]; break;
    case 'repository.inspected': {
      const repo = (event.repository ?? event.result ?? event) as unknown as Repository;
      next.repository = { root: repo.root || '', name: repo.name || '', files: repo.files || [], evidence: repo.evidence || [] };
      next.evidence = repo.evidence || []; break;
    }
    case 'repository.file':
    case 'evidence.ready': {
      const evidence = (event.evidence ?? event.result ?? event) as unknown as Evidence;
      if (evidence.path) next.evidence = [...state.evidence.filter(e => e.path !== evidence.path), evidence];
      break;
    }
    case 'settings.ready': next.settings = (event.settings ?? {}) as Record<string, unknown>; next.settingsLoaded = true; break;
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
      next.questions = [...state.questions, { text: String(event.text), generation, id: String(event.id) }];
      next.error = undefined; next.task = 'thinking'; break;
    case 'utterance.ready':
      if (!state.speeches.some(s => s.id === event.utterance_id)) {
        next.speeches = [...state.speeches, { id: String(event.utterance_id), ja: String(event.speech_ja), zh: '', intent: String(event.intent || 'explain'), assetId: String(event.asset_id || ''), generation, intensity: Number(event.intensity || 0), affect: String(event.affect || 'neutral'), state: 'generated' as const, played: 0, total: 0 }].slice(-80);
      }
      break;
    case 'subtitle.ready':
      next.speeches = state.speeches.map(s => s.id === event.utterance_id ? { ...s, zh: String(event.display_zh) } : s); break;
    case 'desktop.present':
    case 'playback.started': {
      const id = String(event.utterance_id);
      if (event.type === 'playback.started') { next.current = id; next.progress = 0; }
      const speech = state.speeches.find(s => s.id === id);
      if (!speech) break;
      if (state.presented !== id) { next.presented = id; next.sentenceVersion = state.sentenceVersion + 1; }
      const expression = ['explain', 'encourage', 'caution', 'playful'].includes(speech?.intent || '') ? speech!.intent : 'neutral';
      if (speech.assetId || speech.intensity >= .35) {
        next.expression = speech.assetId || expression;
        next.expressionAt = Date.now();
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
    case 'action.proposed': next.actions = [...state.actions, event]; break;
    case 'tool.started':
    case 'tool.completed':
    case 'tool.failed':
      next.tools = [...state.tools, event].slice(-30); break;
    case 'error': next.error = String(event.message || event.error || '发生了未知错误。'); next.task = 'failed'; break;
  }
  return next;
}

// A static browser preview never pretends to be a connected runtime.
const previewBridge: AyanaBridge = {
  send: async () => ({ ok: false, error: '此页面仅用于界面预览。请通过桌面应用启动本地服务。' }),
  onEvent: () => () => {}, playback: () => {}, summon: async () => {}, hide: async () => {}, openSettings: async () => {}, hideSettings: async () => {},
  chooseRepository: async () => null, chooseDirectory: async () => null, restart: async () => {},
  getState: async () => ({ connected: false, service: 'preview', version: '0.3.2', repositoryRoot: '', events: [] }),
};
export const bridge = window.ayana ?? previewBridge;

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
      snapshot.events.forEach(dispatch);
    });
    return () => { off(); player.current?.dispose(); player.current = null; };
  }, [isChat]);
  return { state, dispatch, player };
}
