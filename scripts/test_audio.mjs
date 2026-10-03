import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let Processor;
const receipts = [];
class AudioWorkletProcessor { constructor() { this.port = { postMessage: event => receipts.push(event) }; } }
runInNewContext(readFileSync(path.join(root, 'apps/desktop/public/pcm-player.js'), 'utf8'), {
  AudioWorkletProcessor, sampleRate: 48000, registerProcessor: (_name, ctor) => { Processor = ctor; },
});
const worklet = new Processor();
const send = payload => worklet.port.onmessage({ data: payload });
const render = () => {
  const frames = new Float32Array(128);
  worklet.process([], [[frames]]);
  return frames;
};
send({ type: 'enqueue', utterance_id: 'first', generation_id: 1, sample_rate: 32000, samples: new Float32Array(32000).fill(.25) });
for (let i=0; i<375; i++) render();
assert.equal(receipts.filter(e=>e.type==='started').length, 1);
assert.equal(receipts.filter(e=>e.type==='ended').length, 1);
assert.equal(receipts.find(e=>e.type==='ended').played_samples, 32000, '32k source sample counts must remain accurate on a 48k output device');
send({ type: 'enqueue', utterance_id: 'partial', generation_id: 2, sample_rate: 44100, samples: new Float32Array(44100).fill(.1) });
for (let i=0; i<12; i++) render();
send({ type: 'cancel', generation_id: 2 });
const partial = receipts.find(e=>e.type==='cancelled');
assert.ok(partial.played_samples > 0 && partial.played_samples < partial.total_samples);
assert.ok(render().every(s=>s===0), 'cancellation must silence the next output quantum');
send({ type: 'enqueue', utterance_id: 'late', generation_id: 2, sample_rate: 32000, samples: new Float32Array(10).fill(.9) });
assert.ok(render().every(s=>s===0), 'late old generation must not restart playback');
send({ type: 'enqueue', utterance_id: 'new', generation_id: 3, sample_rate: 32000, samples: new Float32Array(320).fill(.3) });
assert.ok(render().some(s=>s>0), 'new generation must recover without rebuilding the device');
console.log('Audio sample-clock/resampling/cancellation/recovery checks passed');
