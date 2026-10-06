import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { build } from 'esbuild';
import { verifyPortableIsolation } from './verify-portable.mjs';
import './test-lifecycle.mjs';
import './test-preferences.mjs';
import './test-cinematic.mjs';
import './test-companion-geometry.mjs';
import './test-portrait-geometry.mjs';

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
const { reduceEvent, initialState, nextTextSpeech } = stateModule.exports;
assert.equal(initialState.settingsLoaded, false);
assert.equal(reduceEvent({ ...initialState, task: 'thinking' }, { protocol_version: 1, type: 'error', request_id: 'settings-invalid', message: 'invalid settings' }).task, 'thinking');
assert.equal(reduceEvent(initialState, { protocol_version: 1, type: 'error', request_id: 'settings-invalid', message: 'invalid settings' }).error, undefined);
assert.equal(reduceEvent(initialState, { protocol_version: 1, type: 'settings.ready', settings: { voice: { voice_mode: 'sovits' } } }).settingsLoaded, true);
const event = (type, payload = {}) => ({ type, protocol_version: 1, generation_id: 7, ...payload });
let overflow = reduceEvent(initialState, event('utterance.ready', { utterance_id: 'voiced', speech_ja: '一緒に見よう。' }));
overflow = reduceEvent(overflow, event('utterance.ready', { utterance_id: 'text-only', speech_ja: '確認したよ。', audio_enabled: false }));
overflow = reduceEvent(overflow, event('subtitle.ready', { utterance_id: 'text-only', display_zh: '检查过了。' }));
assert.equal(nextTextSpeech(overflow, false), undefined); // wait for queued audio
assert.equal(nextTextSpeech(overflow, true)?.id, 'voiced'); // silent mode still presents every sentence
overflow = reduceEvent(overflow, event('playback.started', { utterance_id: 'voiced', total_samples: 100 }));
assert.equal(nextTextSpeech(overflow, false), undefined); // do not overwrite active speech
overflow = reduceEvent(overflow, event('playback.ended', { utterance_id: 'voiced', played_samples: 100, total_samples: 100 }));
assert.equal(nextTextSpeech(overflow, false)?.id, 'text-only');
assert.equal(nextTextSpeech(overflow, false)?.zh, '检查过了。');
overflow = reduceEvent(overflow, event('desktop.present', { utterance_id: 'text-only' }));
assert.equal(overflow.presented, 'text-only');
assert.equal(nextTextSpeech(overflow, false), undefined);
overflow = reduceEvent(overflow, event('utterance.ready', { utterance_id: 'cancelled-text', speech_ja: '次を見よう。', audio_enabled: false }));
overflow = reduceEvent(overflow, event('generation.cancelled', { cancelled_generation_id: 7, generation_id: 8 }));
assert.equal(nextTextSpeech(overflow, false), undefined);
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

const catalog = JSON.parse(await readFile(new URL('../../../characters/ayana/avatar-map.json', import.meta.url), 'utf8'));
const schoolAsset = Object.entries(catalog.assets).find(([, item]) => item.costume === '校服' && item.source_expression === '休闲' && item.pose === 'crossed')[0];
const [outfitAsset, outfit] = Object.entries(catalog.assets).find(([, item]) => item.costume !== '校服' && item.source_expression === '休闲' && item.pose === 'crossed');
let wardrobe = reduceEvent(initialState, event('settings.ready', { settings: { avatar_costume: '校服' } }));
assert.equal(wardrobe.expression, schoolAsset);
wardrobe = reduceEvent(wardrobe, event('settings.ready', { settings: { avatar_costume: outfit.costume } }));
assert.equal(wardrobe.expression, schoolAsset); // wait for the outfit acknowledgment, independent of audio
wardrobe = reduceEvent(wardrobe, event('utterance.ready', { utterance_id: 'wardrobe', speech_ja: '着替えるね。', asset_id: outfitAsset, presentation: 'costume-change' }));
assert.equal(wardrobe.pendingCostume.assetId, outfitAsset);
assert.equal(wardrobe.expression, outfitAsset); // voice may still be loading
wardrobe = reduceEvent(wardrobe, event('playback.started', { utterance_id: 'wardrobe', total_samples: 100 }));
assert.equal(wardrobe.expression, outfitAsset);
assert.equal(wardrobe.pendingCostume, undefined);
wardrobe = reduceEvent(wardrobe, event('utterance.ready', { utterance_id: 'wardrobe-back', speech_ja: '着替えるね。', asset_id: schoolAsset, presentation: 'costume-change' }));
wardrobe = reduceEvent(wardrobe, event('generation.cancelled', { cancelled_generation_id: 7, generation_id: 8 }));
assert.equal(wardrobe.expression, schoolAsset); // cancelling voice keeps the saved outfit
assert.equal(wardrobe.pendingCostume, undefined);
wardrobe = reduceEvent(wardrobe, event('utterance.ready', { utterance_id: 'stale-outfit', asset_id: outfitAsset, presentation: 'costume-change' }));
assert.equal(wardrobe.pendingCostume, undefined);
const silentOutfit = reduceEvent(reduceEvent(initialState, event('utterance.ready', { utterance_id: 'silent-outfit', speech_ja: '着替えるね。', asset_id: outfitAsset, presentation: 'costume-change' })), event('desktop.present', { utterance_id: 'silent-outfit' }));
assert.equal(silentOutfit.expression, outfitAsset);
assert.equal(silentOutfit.pendingCostume, undefined);
assert.equal(reduceEvent(initialState, event('settings.ready', { settings: { avatar_costume: outfit.costume } })).expression, outfitAsset);
console.log('PASS: wardrobe acknowledgment presents saved outfit on playback/text, restores on startup, and rejects cancelled replies.');

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

let bilingual = { ...initialState, generation: 3, cancelledGeneration: 2, speeches: [{ id: 'caption', ja: 'こんにちは。', zh: '你好。', generation: 1, state: 'played', played: 10, total: 10 }], history: [{ role: 'assistant', utterance_id: 'caption', display_zh: '你好。' }] };
bilingual = reduceEvent(bilingual, event('subtitle.translated', { generation_id: 500, utterance_id: 'caption', display_en: 'Hello.' }));
assert.equal(bilingual.generation, 3, 'Translating an older run must never change the current generation.');
assert.equal(bilingual.speeches[0].zh, '你好。');
assert.equal(bilingual.speeches[0].en, 'Hello.');
assert.equal(bilingual.history[0].display_en, 'Hello.');
console.log('PASS: historical English translations preserve Chinese, update history and never advance or revive a generation.');
