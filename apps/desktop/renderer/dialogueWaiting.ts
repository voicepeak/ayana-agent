import type { ModelState } from './state';
import type { RuntimeEvent } from './types';

/** Match starts and receipts per call, including simultaneous tool calls. */
export function activeWaitingTool(state: ModelState): RuntimeEvent | undefined {
  const running = new Map<string, RuntimeEvent>();
  for (const event of state.tools) {
    if (Number(event.generation_id) !== state.generation) continue;
    const key = String(event.call_id || event.tool);
    if (event.type === 'tool.started') running.set(key, event);
    else if (event.type === 'tool.progress' && running.has(key)) running.set(key, { ...running.get(key)!, ...event });
    else if (event.type === 'tool.completed' || event.type === 'tool.failed') running.delete(key);
  }
  return [...running.values()].at(-1);
}

/** Stay present through generation and audio preparation, until a reply is presented. */
export function dialogueWaiting(state: ModelState): boolean {
  const question = state.questions.at(-1);
  if (!state.connected || state.error || !question || question.generation !== state.generation
    || question.generation <= state.cancelledGeneration || state.approvals.length
    || ['failed', 'waiting_approval', 'paused'].includes(state.task)
    || ['waiting_approval', 'paused', 'cancelled', 'failed', 'blocked', 'needs_input'].includes(String(state.activeTask?.state))) return false;
  const replies = state.speeches.filter(item => item.generation === question.generation);
  // A spoken acknowledgment can precede a slow tool call. Keep that work visible.
  const workStarted = state.activeTask?.state === 'running'
    || state.tools.some(event => Number(event.generation_id) === state.generation);
  if (['thinking', 'acting'].includes(state.task) && (activeWaitingTool(state) || workStarted)) return true;
  const presentedIndex = replies.findIndex(item => item.id === state.presented);
  if (!replies.some(item => item.state === 'playing')
    && replies.slice(presentedIndex + 1).some(item => item.state === 'generated')) return true;
  if (replies.some(item => item.id === state.presented || ['playing', 'played', 'partial'].includes(item.state))) return false;
  return ['thinking', 'acting'].includes(state.task) || replies.some(item => item.state === 'generated');
}
