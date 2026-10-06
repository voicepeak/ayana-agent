import assert from 'node:assert/strict';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['renderer/dialogueWaiting.ts'], bundle: true, format: 'esm', write: false });
const { dialogueWaiting } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const state = { connected: true, generation: 7, cancelledGeneration: 6, task: 'thinking',
  questions: [{ id: 'question', generation: 7 }], speeches: [], approvals: [] };
assert(dialogueWaiting(state), 'An unanswered question displays the waiting effect.');
const queued = { id: 'reply', generation: 7, state: 'generated' };
assert(dialogueWaiting({ ...state, task: 'idle', speeches: [queued] }), 'Audio preparation still needs a waiting effect after generation ends.');
assert(dialogueWaiting({ ...state, speeches: [{ ...queued, generation: 6, state: 'played' }], presented: 'reply' }), 'An old answer does not clear the new question.');
assert(!dialogueWaiting({ ...state, speeches: [queued], presented: 'reply' }), 'Text presentation clears the waiting effect.');
assert(!dialogueWaiting({ ...state, speeches: [{ ...queued, state: 'playing' }] }));
assert(!dialogueWaiting({ ...state, speeches: [{ ...queued, state: 'played' }] }));
assert(!dialogueWaiting({ ...state, cancelledGeneration: 7 }));
assert(!dialogueWaiting({ ...state, error: 'Network failed' }));
assert(!dialogueWaiting({ ...state, connected: false }));
assert(!dialogueWaiting({ ...state, approvals: [{}] }));
assert(!dialogueWaiting({ ...state, activeTask: { state: 'waiting_approval' } }));
assert(!dialogueWaiting({ ...state, activeTask: { state: 'needs_input' } }));
assert(!dialogueWaiting({ ...state, task: 'failed' }));
assert(!dialogueWaiting({ ...state, task: 'idle' }));
assert(!dialogueWaiting({ ...state, questions: [] }));
assert(!dialogueWaiting({ ...state, generation: 8 }));
console.log('PASS: waiting follows unanswered turns and audio preparation; presentation, cancellation, errors and approvals clear it.');
