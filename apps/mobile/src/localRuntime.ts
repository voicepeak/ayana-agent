import { readLocal, writeLocal } from './storage';
import { characterBootstrap, prompt, resolveExpression, settings, setCharacterSettings } from './character';
import type { Conversation, HistoryRecord, RuntimeEvent } from './types';
import { identifier } from './identifier';
import { sessionOwner } from './api';
import { modelHistoryContent } from './modelHistory';

type RecordItem = HistoryRecord & { asset_id?: string; resolved_expression?: string; resolved_pose?: string; conversation_id?: string };
type Saved = { settings: typeof settings; conversations: Conversation[]; current: string; history: Record<string, RecordItem[]>; memory: string[]; generation: number };
const id = identifier;

export class LocalRuntime {
  private data!: Saved;
  private saving = Promise.resolve();
  private ready?: Promise<void>;
  constructor(private emit: (event: RuntimeEvent) => void) {}
  initialize() {
    return this.ready ||= (async () => {
      const saved = await readLocal<Saved>('runtime:' + sessionOwner());
      const first = { conversation_id: id(), title: '新的对话', updated: Date.now() };
      this.data = saved || { settings, conversations: [first], current: first.conversation_id,
        history: { [first.conversation_id]: [] }, memory: [], generation: 0 };
      setCharacterSettings(this.data.settings);
      this.snapshot();
    })();
  }
  private save() {
    const snapshot = structuredClone(this.data);
    const key = 'runtime:' + sessionOwner();
    this.saving = this.saving.catch(() => {}).then(() => writeLocal(key, snapshot));
    this.saving.catch(() => this.emit({ protocol_version: 1, type: 'error', message: '手机本地保存失败，请检查存储空间' }));
    return this.saving;
  }
  private history() { return this.data.history[this.data.current] ||= []; }
  private output(type: string, data: Record<string, unknown> = {}) {
    this.emit({ protocol_version: 1, type, generation_id: this.data.generation, ...data });
  }
  snapshot(changed = false) {
    const boot = characterBootstrap();
    this.output('settings.ready', { settings, default_asset_id: boot.default_asset_id, avatar_character: boot.avatar_character, avatar_costume: boot.avatar_costume });
    this.output(changed ? 'conversation.changed' : 'conversations.ready', { current: this.data.conversations.find(c => c.conversation_id === this.data.current),
      conversations: this.data.conversations, persistent: true });
    this.output('history.ready', { history_conversation_id: this.data.current, history: this.history() });
    this.output('memory.ready', { memories: this.data.memory });
  }
  async start(text: string) {
    await this.initialize();
    const history = this.history();
    this.data.generation++;
    const generation = this.data.generation;
    const turn = id();
    const recent = history.filter(h => h.displayed && h.resolved_expression).slice(-3)
      .map(h => ({ expression: h.resolved_expression, pose: h.resolved_pose }));
    const messages: { role: string; content: string }[] = [{ role: 'system', content: prompt(this.data.memory, recent) }];
    let budget = 0;
    const context: { role: string; content: string }[] = [];
    for (const item of [...history].reverse()) {
      const content = modelHistoryContent(item);
      if (budget + content.length > 60000 || context.length >= 85) break;
      budget += content.length;
      context.unshift({ role: item.role === 'user' ? 'user' : 'assistant', content });
    }
    messages.push(...context, { role: 'user', content: text });
    history.push({ id: Date.now(), role: 'user', text, turn_id: turn });
    const explicitMemory = text.match(/^(?:请)?记住[：:，,\s]*(.{1,300})$/u)?.[1];
    if (explicitMemory && !this.data.memory.includes(explicitMemory)) this.data.memory = [...this.data.memory, explicitMemory].slice(-50);
    const conversation = this.data.conversations.find(c => c.conversation_id === this.data.current)!;
    if (conversation.title === '新的对话') conversation.title = text.slice(0, 20);
    conversation.preview = text.slice(0, 60);
    conversation.updated = Date.now();
    this.output('user.message', { text, turn_id: turn, conversation_id: this.data.current });
    await this.save();
    return { type: 'turn.start', text, messages, turn_id: turn, conversation_id: this.data.current, generation_id: generation };
  }
  receive(event: RuntimeEvent): RuntimeEvent | undefined {
    if (event.conversation_id && event.conversation_id !== this.data.current) return;
    if (typeof event.generation_id === 'number' && event.generation_id !== this.data.generation) return;
    if (event.type === 'utterance.ready') {
      event = resolveExpression(event);
      this.history().push({ id: Date.now(), role: 'assistant', utterance_id: String(event.utterance_id),
        speech_ja: String(event.speech_ja), displayed: false, status: 'generated', turn_id: String(event.turn_id),
        asset_id: String(event.asset_id), resolved_expression: String(event.resolved_expression), resolved_pose: String(event.resolved_pose) });
    }
    const item = this.history().find(h => h.utterance_id === event.utterance_id);
    if (item && (event.type === 'subtitle.ready' || event.type === 'subtitle.translated')) {
      if (typeof event.display_zh === 'string') item.display_zh = event.display_zh;
      if (typeof event.display_en === 'string') item.display_en = event.display_en;
    }
    if (event.type === 'utterance.ready' || event.type.startsWith('subtitle.')) void this.save();
    return event;
  }
  playback(event: RuntimeEvent) {
    const item = this.history().find(h => h.utterance_id === event.utterance_id);
    if (!item) return;
    if (event.type === 'utterance.displayed' || event.type === 'playback.started') item.displayed = true;
    if (event.type.startsWith('playback.')) {
      item.played_samples = Number(event.played_samples || 0);
      item.total_samples = Number(event.total_samples || 0);
      item.status = event.type === 'playback.ended' ? 'played' : event.type === 'playback.cancelled' ? 'partial' : 'playing';
    }
    if (event.type !== 'playback.progress') void this.save();
  }
  async command(command: Record<string, unknown>) {
    await this.initialize();
    const type = command.type;
    if (type === 'conversation.create') {
      const conversation = { conversation_id: id(), title: '新的对话', updated: Date.now() };
      this.data.conversations.push(conversation);
      this.data.current = conversation.conversation_id;
      this.snapshot(true);
    } else if (type === 'conversation.select') {
      if (!this.data.conversations.some(c => c.conversation_id === command.conversation_id)) throw new Error('话题不存在');
      this.data.current = String(command.conversation_id);
      this.snapshot(true);
    } else if (type === 'settings.update') {
      setCharacterSettings(command.settings as typeof settings);
      this.data.settings = settings;
      this.snapshot();
    } else if (type === 'memory.set') {
      this.data.memory = String(command.text || '').split('\n').map(v => v.trim()).filter(Boolean).slice(0, 50).map(v => v.slice(0, 300));
    } else if (type === 'utterance.displayed' || String(type).startsWith('playback.')) this.playback(command as RuntimeEvent);
    else if (['settings.get', 'history.get', 'conversations.get', 'capabilities.get'].includes(String(type))) this.snapshot();
    else throw new Error('此能力尚未配置');
    await this.save();
  }
}
