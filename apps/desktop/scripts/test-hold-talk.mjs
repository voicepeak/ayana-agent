import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
const compiled = await build({ entryPoints: ['renderer/holdRecorder.ts', 'renderer/welcomeTour.ts'], bundle: true, platform: 'node', format: 'cjs', outdir: 'unused', write: false });
const modules = compiled.outputFiles.map(file => {
  const module = { exports: {} };
  vm.runInNewContext(file.text, { module, exports: module.exports, Blob, Uint8Array, String, btoa, DOMException, performance });
  return module.exports;
});
const { HoldRecorder } = modules.find(item => item.HoldRecorder);
const { narrationFrame } = modules.find(item => item.narrationFrame);
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture() {
  let now = 0, stopped = 0, grant;
  const states = [], errors = [], submissions = [], recordings = [];
  const stream = { getTracks: () => [{ stop: () => stopped++ }] };
  const capture = new HoldRecorder({
    getStream: () => new Promise(resolve => { grant = resolve; }), now: () => now,
    makeRecorder: () => {
      const recorder = { state: 'inactive', mimeType: 'audio/webm;codecs=opus',
        start() { this.state = 'recording'; },
        stop() { this.state = 'inactive'; this.ondataavailable({ data: new Blob(['recorded speech']) }); this.onstop(); },
      }; recordings.push(recorder); return recorder;
    },
    state: state => states.push(state), error: error => errors.push(error),
    submit: async (...args) => { submissions.push(args); },
  });
  return { capture, states, errors, submissions, recordings, stream,
    grant: () => grant(stream), advance: () => { now += 1200; }, stopped: () => stopped };
}
{
  const f = fixture(); const pending = f.capture.start('a'); f.capture.release('a'); f.grant(); await pending;
  assert.equal(f.recordings.length, 0); assert(f.stopped()); assert.equal(f.submissions.length, 0);
}
{
  const f = fixture(); const pending = f.capture.start('a'); f.grant(); await pending;
  assert.equal(f.states.at(-1), 'recording'); f.capture.release('stale'); assert.equal(f.recordings[0].state, 'recording');
  f.advance(); f.capture.release('a'); await flush();
  assert.equal(f.submissions.length, 1); assert.equal(f.submissions[0][0], 'a');
  assert.equal(atob(f.submissions[0][1]), 'recorded speech'); assert(f.stopped());
  assert.equal(f.states.at(-1), 'transcribing');
}
for (const cancelled of [false, true]) {
  const f = fixture(); const pending = f.capture.start('a'); f.grant(); await pending;
  if (cancelled) f.advance(); f.capture.release('a', cancelled); await flush();
  assert.equal(f.submissions.length, 0); assert.equal(f.states.at(-1), 'idle'); assert(f.stopped());
}
{
  const f = fixture(); const pending = f.capture.start('a'); f.grant(); await pending;
  f.advance(); f.capture.release('a'); f.capture.cancel(); await flush();
  assert.equal(f.submissions.length, 0, 'cancel while encoding discards submission');
}
const timing = { duration: 7, segments: [
  { start: 0, end: 2, until: 3, zh: '第一句', from: 0, to: .4 },
  { start: 3, end: 6, until: 7, zh: '第二句', from: .4, to: 1 },
] };
assert.equal(narrationFrame(timing, 2.999).caption, '第一句');
assert.equal(narrationFrame(timing, 3).caption, '第二句');
assert.equal(narrationFrame(timing, 3).progress, .4);
assert.equal(narrationFrame(timing, 100).progress, 1);
assert.equal(narrationFrame(timing, -1).progress, 0);
console.log('PASS: hold/release audio capture, permission race, short/cancelled/stale recording cleanup; exact sentence timing and seek boundaries.');
