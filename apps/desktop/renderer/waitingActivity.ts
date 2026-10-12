import type { ModelState } from './state';
import { activeWaitingTool } from './dialogueWaiting';

export interface WaitingActivity { key: string; stage: string; title: string; detail: string; }

const activities: Record<string, Omit<WaitingActivity, 'key'>> = {
  'web.search': { stage: 'searching', title: '再找一找线索。', detail: '在查找相关资料' },
  'web.fetch': { stage: 'reading', title: '让我再看一眼。', detail: '在阅读网页里的内容' },
  'desktop.observe': { stage: 'reading', title: '让我看一眼屏幕。', detail: '在观察屏幕内容' },
  'attention.configure': { stage: 'organizing', title: '调整偷看的开关。', detail: '在更新主动观察设置' },
};

/** Friendly labels are derived from actual events; no guesses about completion. */
export function waitingActivity(state: ModelState): WaitingActivity {
  const tool = activeWaitingTool(state);
  if (tool) {
    const progress = tool.type === 'tool.progress' && ['search_fallback', 'exact_search', 'original_subject'].includes(String(tool.stage));
    return { key: `tool:${String(tool.call_id || tool.tool)}:${String(tool.stage || '')}`,
      ...(activities[String(tool.tool)] || { stage: 'working', title: '这一步，还在继续。', detail: '这一步还在进行中' }),
      ...(progress ? { title: '换个方法，再找一找。', detail: String(tool.message || '正在重新查找相关资料') } : {}) };
  }
  if (state.contextState === 'compacting') return { key: 'context', stage: 'organizing', title: '把刚才的话，理清楚。', detail: '在整理之前的对话，保留重点' };
  const queued = state.speeches.find(item => item.generation === state.generation && item.state === 'generated' && item.id !== state.presented);
  const voice = (state.settings.voice as Record<string, unknown> | undefined)?.voice_mode;
  if (queued && queued.audioEnabled !== false && voice !== 'silent' && state.voice !== 'failed')
    return { key: 'voice', stage: 'voice', title: '把声音准备好。', detail: '回答已写好，在准备语音' };
  const receipt = [...state.tools].reverse().find(event => Number(event.generation_id) === state.generation && ['tool.completed', 'tool.failed'].includes(event.type));
  if (receipt?.type === 'tool.completed') return { key: `organize:${String(receipt.call_id || receipt.tool)}`, stage: 'organizing', title: '把这些线索，连起来。', detail: '这一步有结果了，在整理回答' };
  if (receipt) return { key: `retry:${String(receipt.call_id || receipt.tool)}`, stage: 'thinking', title: '这条路没走通，再想想。', detail: '刚才的尝试没有完成，在整理下一步' };
  return { key: 'thinking', stage: 'thinking', title: '让我想一会儿。', detail: '在整理思路' };
}
