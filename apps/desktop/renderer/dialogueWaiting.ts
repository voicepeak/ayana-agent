import type { ModelState } from './state';

/** Stay present through generation and audio preparation, until a reply is presented. */
export function dialogueWaiting(state: ModelState): boolean {
  const question = state.questions.at(-1);
  if (!state.connected || state.error || !question || question.generation !== state.generation
    || question.generation <= state.cancelledGeneration || state.approvals.length
    || ['failed', 'waiting_approval', 'paused'].includes(state.task)
    || ['waiting_approval', 'paused', 'cancelled', 'failed', 'blocked', 'needs_input'].includes(String(state.activeTask?.state))) return false;
  const replies = state.speeches.filter(item => item.generation === question.generation);
  if (replies.some(item => item.id === state.presented || ['playing', 'played', 'partial'].includes(item.state))) return false;
  return ['thinking', 'acting'].includes(state.task) || replies.some(item => item.state === 'generated');
}
