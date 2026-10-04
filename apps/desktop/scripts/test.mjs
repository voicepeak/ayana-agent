import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { build } from 'esbuild';
import { verifyPortableIsolation } from './verify-portable.mjs';

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
const event = (type, payload = {}) => ({ type, protocol_version: 1, generation_id: 7, ...payload });
let state = reduceEvent(initialState, event('utterance.ready', { utterance_id: 'speech', speech_ja: '一緒に見よう。', intent: 'encourage', intensity: .7 }));
assert.equal(state.expression, 'neutral');
state = reduceEvent(state, event('audio.ready', { utterance_id: 'speech' }));
assert.equal(state.expression, 'neutral');
state = reduceEvent(state, event('playback.started', { utterance_id: 'speech', total_samples: 3000 }));
assert.equal(state.expression, 'encourage');
state = reduceEvent(state, event('generation.cancelled', { cancelled_generation_id: 7, generation_id: 8 }));
assert.equal(state.current, undefined);
assert.equal(state.expression, 'neutral');
state = reduceEvent(state, event('subtitle.ready', { utterance_id: 'speech', display_zh: '旧字幕' }));
assert.equal(state.speeches[0].zh, '');
state = reduceEvent(state, event('utterance.ready', { generation_id: 9, utterance_id: 'new-speech', speech_ja: '次に進もう。', intent: 'explain', intensity: .25 }));
state = reduceEvent(state, event('playback.started', { generation_id: 9, utterance_id: 'new-speech', total_samples: 100 }));
assert.equal(state.expression, 'neutral');
state = reduceEvent(state, event('playback.started', { seq: 91, utterance_id: 'speech', total_samples: 3000 }));
assert.equal(state.current, 'new-speech');
assert.equal(state.expression, 'neutral');
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
console.log('PASS: Worklet resampling, exact end/cancel sample counts, stale audio rejection; playback-only expressions, cancellation and low-intensity hold.');

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
console.log('PASS: full catalog IDs, sentence motion triggers once per sentence, persistent subtitles, and text-only presentation.');
