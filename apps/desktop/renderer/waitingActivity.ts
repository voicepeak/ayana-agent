import type { ModelState } from './state';
import { activeWaitingTool } from './dialogueWaiting';

export interface WaitingActivity { key: string; stage: string; title: string; detail: string; }

const activities: Record<string, Omit<WaitingActivity, 'key'>> = {
  'web.search': { stage: 'searching', title: '再找一找线索。', detail: '在查找相关资料' },
  'web.fetch': { stage: 'reading', title: '让我再看一眼。', detail: '在阅读网页里的内容' },
  'files.read': { stage: 'reading', title: '让我再看一眼。', detail: '在阅读相关文件' },
  'files.list': { stage: 'searching', title: '找找它放在哪里。', detail: '在查看文件和目录' },
  'files.find': { stage: 'searching', title: '找找它放在哪里。', detail: '在查找需要的文件' },
  'files.search': { stage: 'searching', title: '再找一找线索。', detail: '在文件里查找相关内容' },
  'files.create': { stage: 'working', title: '把想法写下来', detail: '在准备新的文件' },
  'files.propose_edit': { stage: 'working', title: '认真改好这几处', detail: '在准备文件的修改' },
  'files.apply_edit': { stage: 'working', title: '认真改好这几处', detail: '在应用你确认的修改' },
  'files.propose_restore': { stage: 'working', title: '把这一页放回原处', detail: '在准备恢复文件' },
  'shell.run': { stage: 'working', title: '这一步，还在继续。', detail: '在处理这一步，等待结果' },
  'process.start': { stage: 'working', title: '让它跑起来', detail: '在启动这项工作' },
  'process.status': { stage: 'reading', title: '看看进展到哪了', detail: '在检查运行状态' },
  'process.stop': { stage: 'working', title: '让这件事停下来。', detail: '在停止这项工作' },
  'browser.open': { stage: 'reading', title: '去页面里看一眼', detail: '在打开网页' },
  'browser.observe': { stage: 'reading', title: '去页面里看一眼', detail: '在查看页面内容' },
  'browser.act': { stage: 'working', title: '认真处理这一步', detail: '在完成页面上的操作' },
  'computer.run': { stage: 'working', title: '认真处理这一步', detail: '在操作你交给我的窗口' },
  'desktop.step': { stage: 'working', title: '认真处理这一步', detail: '在完成窗口里的操作' },
  execute_step: { stage: 'working', title: '认真处理这一步', detail: '在完成你确认的操作' },
  'apps.search': { stage: 'searching', title: '找找它放在哪儿', detail: '在查找需要的应用' },
  'apps.open': { stage: 'working', title: '把它打开。', detail: '在打开需要的应用' },
  'files.open': { stage: 'working', title: '把这份资料打开', detail: '在打开你需要的文件' },
  'web.open': { stage: 'working', title: '去页面里看一眼', detail: '在打开你需要的网页' },
  'windows.list': { stage: 'searching', title: '找找你说的窗口', detail: '在查看已打开的窗口' },
  'windows.select': { stage: 'reading', title: '看看你说的窗口', detail: '在查看目标窗口' },
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
