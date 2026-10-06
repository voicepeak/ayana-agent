import defaults from '../../../config/default.json';
import { bridge } from './state';
import type { AyanaBridge } from './types';

export interface Preferences {
  provider: string; base_url: string; model: string; avatar_costume: string;
  volume: number; subtitles: boolean; sentence_motion: boolean;
  hotkey: string; cancel_hotkey: string; save_history: boolean; send_screenshot: boolean; full_access: boolean;
  native_tools: boolean; search_provider: string; search_proxy: string;
  max_utterances: number; detailed_max_utterances: number; model_max_tokens: number;
  voice: { voice_mode: string }; stt: { language: string };
  task_limits: { rounds: number; calls: number; seconds: number };
}

export function preferences(settings: Record<string, unknown>): Preferences {
  const cfg = { ...defaults, ...settings };
  const voice = cfg.voice as Record<string, unknown>;
  const stt = cfg.stt as Record<string, unknown>;
  return {
    provider: cfg.provider, base_url: cfg.base_url, model: cfg.model, avatar_costume: cfg.avatar_costume,
    volume: cfg.volume, subtitles: cfg.subtitles, sentence_motion: cfg.sentence_motion,
    hotkey: cfg.hotkey, cancel_hotkey: cfg.cancel_hotkey, save_history: cfg.save_history,
    send_screenshot: cfg.send_screenshot, full_access: cfg.full_access === true, native_tools: cfg.native_tools,
    search_provider: cfg.search_provider, search_proxy: cfg.search_proxy,
    max_utterances: cfg.max_utterances, detailed_max_utterances: cfg.detailed_max_utterances,
    model_max_tokens: cfg.model_max_tokens, voice: { voice_mode: String(voice.voice_mode || 'auto') },
    stt: { language: String(stt.language || 'auto') }, task_limits: { ...defaults.task_limits, ...cfg.task_limits },
  };
}

// Only send edited fields, including nested leaves. Resource paths stay on the backend.
export function preferencePatch(saved: Preferences, draft: Preferences): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(draft) as (keyof Preferences)[]) {
    if (typeof draft[key] === 'object') {
      const before = saved[key] as unknown as Record<string, unknown>;
      const after = draft[key] as unknown as Record<string, unknown>;
      const changed = Object.fromEntries(Object.entries(after).filter(([field, value]) => value !== before[field]));
      if (Object.keys(changed).length) result[key] = changed;
    } else if (draft[key] !== saved[key]) result[key] = draft[key];
  }
  return result;
}

export function savePreferences(settings: Record<string, unknown>, transport: AyanaBridge = bridge): Promise<void> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); off();
      if (error) reject(error); else resolve();
    };
    const off = transport.onEvent(event => {
      if (event.type === 'desktop.reset') finish(new Error('服务已重启，草稿已保留，请重新保存。'));
      if (event.request_id !== requestId) return;
      if (event.type === 'settings.ready') finish();
      if (event.type === 'error') finish(new Error(String(event.message || '设置保存失败。')));
    });
    const timer = setTimeout(() => finish(new Error('尚未收到保存回执，请刷新状态核对；草稿已保留。')), 20000);
    transport.send({ type: 'settings.update', settings, request_id: requestId })
      .then(result => { if (!result.ok) finish(new Error(result.error || '本地服务未连接。')); })
      .catch(error => finish(error instanceof Error ? error : new Error(String(error))));
  });
}
