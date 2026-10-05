import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { build } from 'esbuild';
import { verifyPortableIsolation } from './verify-portable.mjs';
import './test-lifecycle.mjs';

await verifyPortableIsolation();

const source = await readFile(new URL('../public/pcm-player.js', import.meta.url), 'utf8');
let Processor;
const receipts = [];
const context = vm.createContext({
  sampleRate: 48000,
  AudioWorkletProcessor: class {
    port = { onmessage: null, postMessage: value => receipts.push(value) };
  },
  registerProcessor: (_name, implementation) => { Processor = implementation; },
});
vm.runInContext(source, context);
const worklet = new Processor();
const send = data => worklet.port.onmessage({ data });
const frame = () => { const buffer = new Float32Array(128); worklet.process([], [[buffer]]); return buffer; };
send({ type: 'enqueue', generation_id: 1, utterance_id: 'first', sample_rate: 32000, samples: new Float32Array(3200).fill(.5) });
for (let i = 0; i < 38; i++) frame();
assert.equal(receipts.filter(r => r.type === 'started').length, 1);
assert.equal(receipts.at(-1).type, 'ended');
assert.equal(receipts.at(-1).played_samples, 3200);
send({ type: 'enqueue', generation_id: 2, utterance_id: 'cancel-me', sample_rate: 32000, samples: new Float32Array(32000).fill(.5) });
frame();
send({ type: 'cancel', generation_id: 2 });
assert.equal(receipts.at(-1).type, 'cancelled');
assert(receipts.at(-1).played_samples > 0 && receipts.at(-1).played_samples < 32000);
send({ type: 'enqueue', generation_id: 2, utterance_id: 'stale', sample_rate: 32000, samples: new Float32Array(1000).fill(1) });
assert(frame().every(sample => sample === 0));
assert(!receipts.some(r => r.utterance_id === 'stale'));
send({ type: 'enqueue', generation_id: 3, utterance_id: 'new', sample_rate: 48000, samples: new Float32Array(128).fill(.25) });
assert(frame().every(sample => sample === .25));
assert.equal(receipts.at(-1).utterance_id, 'new');
assert.equal(receipts.at(-1).type, 'ended');

const compiled = await build({ entryPoints: ['renderer/state.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react'] });
const stateModule = { exports: {} };
const stateContext = vm.createContext({ window: {}, module: stateModule, exports: stateModule.exports, require: () => ({}), Date, setTimeout });
vm.runInContext(compiled.outputFiles[0].text, stateContext);
const { reduceEvent, initialState } = stateModule.exports;
assert.equal(initialState.settingsLoaded, false);
assert.equal(reduceEvent(initialState, { protocol_version: 1, type: 'settings.ready', settings: { voice: { voice_mode: 'sovits' } } }).settingsLoaded, true);
const event = (type, payload = {}) => ({ type, protocol_version: 1, generation_id: 7, ...payload });
let state = reduceEvent(initialState, event('utterance.ready', { utterance_id: 'speech', speech_ja: '一緒に見よう。', intent: 'encourage', intensity: .7 }));
assert.equal(state.expression, 'neutral');
state = reduceEvent(state, event('audio.ready', { utterance_id: 'speech' }));
assert.equal(state.expression, 'neutral');
state = reduceEvent(state, event('playback.started', { utterance_id: 'speech', total_samples: 3000 }));
assert.equal(state.expression, 'encourage');
state = reduceEvent(state, event('generation.cancelled', { cancelled_generation_id: 7, generation_id: 8 }));
assert.equal(state.current, undefined);
assert.equal(state.expression, 'encourage'); // cancellation keeps the last face on screen
state = reduceEvent(state, event('subtitle.ready', { utterance_id: 'speech', display_zh: '旧字幕' }));
assert.equal(state.speeches[0].zh, '');
state = reduceEvent(state, event('utterance.ready', { generation_id: 9, utterance_id: 'new-speech', speech_ja: '次に進もう。', intent: 'explain', intensity: .25 }));
state = reduceEvent(state, event('playback.started', { generation_id: 9, utterance_id: 'new-speech', total_samples: 100 }));
assert.equal(state.expression, 'encourage'); // a low-intensity sentence holds the previous face
state = reduceEvent(state, event('playback.started', { seq: 91, utterance_id: 'speech', total_samples: 3000 }));
assert.equal(state.current, 'new-speech');
assert.equal(state.expression, 'encourage');
state = reduceEvent(state, event('input.state', { generation_id: 9, state: 'transcribing' }));
assert.equal(state.inputState, 'transcribing');
state = reduceEvent(state, event('desktop.cancelled', { generation_id: 9, cancelled_generation_id: 9 }));
assert.equal(state.inputState, 'idle');
state = reduceEvent(state, event('snapshot.ready', { target: { title: 'old target' }, snapshot_id: 'old' }));
state = reduceEvent(state, event('snapshot.invalidated'));
assert.equal(state.snapshot, undefined);
assert.equal(state.actions.length, 0);
state = reduceEvent(state, event('snapshot.ready', { target: { title: 'old target' }, snapshot_id: 'old' }));
state = reduceEvent(state, event('session.started', { target: null }));
assert.equal(state.target, undefined);
assert.equal(state.snapshot, undefined);
assert.equal(state.task, 'idle');
console.log('PASS: Worklet resampling, exact end/cancel sample counts, stale audio rejection; playback-only expressions, cancellation and low-intensity sentences hold the previous face.');

let routed = reduceEvent(initialState, event('utterance.ready', { utterance_id: 'catalog-one', speech_ja: '大丈夫かな。', asset_id: 'aya_z1a0010__a0018', intensity: .1 }));
assert.equal(routed.sentenceVersion, 0);
routed = reduceEvent(routed, event('utterance.displayed', { utterance_id: 'catalog-one', seq: 10 }));
assert.equal(routed.expression, 'neutral'); // persistence acknowledgments cannot advance the face
routed = reduceEvent(routed, event('playback.started', { utterance_id: 'catalog-one', total_samples: 100 }));
assert.equal(routed.expression, 'aya_z1a0010__a0018');
assert.equal(routed.presented, 'catalog-one');
assert.equal(routed.sentenceVersion, 1);
routed = reduceEvent(routed, event('playback.started', { utterance_id: 'catalog-one', total_samples: 100 }));
assert.equal(routed.sentenceVersion, 1);
routed = reduceEvent(routed, event('playback.ended', { utterance_id: 'catalog-one', total_samples: 100, played_samples: 100 }));
assert.equal(routed.presented, 'catalog-one'); // finished subtitles stay readable
routed = reduceEvent(routed, event('utterance.ready', { utterance_id: 'catalog-two', speech_ja: 'そうだね。', asset_id: 'aya_z1a0000__a0017' }));
routed = reduceEvent(routed, event('desktop.present', { utterance_id: 'catalog-two' }));
assert.equal(routed.sentenceVersion, 2);
assert.equal(routed.expression, 'aya_z1a0000__a0017');
routed = reduceEvent(routed, event('desktop.cancelled', { cancelled_generation_id: 7 }));
routed = reduceEvent(routed, event('desktop.present', { utterance_id: 'catalog-two' }));
assert.equal(routed.presented, undefined);
console.log('PASS: full catalog IDs, per-sentence presentation tracking, persistent subtitles, and text-only presentation.');

let taskState = reduceEvent(initialState, event('task.updated', { task: { task_id: 'task-a', state: 'waiting_approval', goal: 'Edit' } }));
taskState = reduceEvent(taskState, event('approval.required', { approval: { approval_id: 'approve-a', task_id: 'task-a', diff: '-old\n+new' } }));
taskState = reduceEvent(taskState, event('approval.required', { approval: { approval_id: 'approve-a', task_id: 'task-a', diff: '-old\n+new' } }));
assert.equal(taskState.approvals.length, 1);
taskState = reduceEvent(taskState, event('generation.cancelled', { cancelled_generation_id: 7, generation_id: 8 }));
assert.equal(taskState.approvals.length, 0);
taskState = reduceEvent(taskState, event('approval.required', { approval: { approval_id: 'stale' } }));
assert.equal(taskState.approvals.length, 0);
taskState = reduceEvent(taskState, event('task.updated', { generation_id: 8, task: { task_id: 'task-a', state: 'cancelled' } }));
taskState = reduceEvent(taskState, event('task.updated', { task: { task_id: 'old', state: 'succeeded' } }));
assert.equal(taskState.activeTask.state, 'cancelled');
taskState = reduceEvent(taskState, event('capabilities.ready', { generation_id: 8, artifacts: [{ artifact_id: 'saved' }], directories: [{ root_id: 'output', write: true }], tasks: [{ task_id: 'task-a', state: 'cancelled' }], search_configured: true }));
assert.equal(taskState.artifacts[0].artifact_id, 'saved');
assert.equal(taskState.directories[0].root_id, 'output');
assert.equal(taskState.searchConfigured, true);
taskState = reduceEvent(taskState, event('artifact.ready', { generation_id: 8, artifact: { artifact_id: 'saved', sha256: 'verified' } }));
assert.equal(taskState.artifacts.length, 1);
assert.equal(taskState.artifacts[0].sha256, 'verified');
console.log('PASS: approval deduplication, cancellation and stale task rejection; reconnect restores files, grants and search state.');

let topics = reduceEvent(initialState, event('conversation.changed', { generation_id: 10, current: { conversation_id: 'a', title: '甲' }, conversations: [], persistent: true }));
topics = reduceEvent(topics, event('utterance.ready', { generation_id: 11, conversation_id: 'a', utterance_id: 'old-topic', speech_ja: '覚えているよ。' }));
topics = reduceEvent(topics, event('conversation.changed', { generation_id: 12, current: { conversation_id: 'b', title: '乙' }, conversations: [], persistent: false, summary: '' }));
assert.equal(topics.speeches.length, 0);
assert.equal(topics.activeTask, undefined);
assert.equal(topics.persistentHistory, false);
topics = reduceEvent(topics, event('subtitle.ready', { generation_id: 13, conversation_id: 'a', utterance_id: 'old-topic', display_zh: '旧话题' }));
topics = reduceEvent(topics, event('task.updated', { generation_id: 13, conversation_id: 'a', task: { state: 'succeeded' } }));
assert.equal(topics.speeches.length, 0);
assert.equal(topics.activeTask, undefined);
topics = reduceEvent(topics, event('history.ready', { history_conversation_id: 'b', history: [{ id: 3, role: 'user', text: '最新' }], has_more: true, before: 3 }));
topics = reduceEvent(topics, event('history.ready', { history_conversation_id: 'a', history: [{ id: 9, role: 'user', text: '错误话题' }] }));
assert.equal(topics.history[0].text, '最新');
topics = reduceEvent(topics, event('history.ready', { history_conversation_id: 'b', prepend: true, history: [{ id: 1, text: '更早' }, { id: 3, text: '最新' }], has_more: false, before: 1 }));
assert.equal(topics.history.length, 2);
assert.equal(topics.history[0].text, '更早');
assert.equal(topics.historyHasMore, false);
console.log('PASS: topic switching clears old output and tasks; late events and history cannot cross topics; transcript pagination deduplicates.');
