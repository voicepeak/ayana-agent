import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['renderer/preferences.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react'] });
const module = { exports: {} };
vm.runInContext(compiled.outputFiles[0].text, vm.createContext({ window: {}, module, exports: module.exports, require: () => ({}), crypto: webcrypto, setTimeout, clearTimeout }));
const { preferences, preferencePatch, savePreferences } = module.exports;
const saved = preferences({ voice: { voice_mode: 'sovits', engine_root: 'private-path' }, stt: { provider: 'openai', model: 'custom' } });
const changed = structuredClone(saved);
changed.stt.language = 'zh';
changed.task_limits.calls = 7;
const patch = JSON.parse(JSON.stringify(preferencePatch(saved, changed)));
assert.deepEqual(patch, { stt: { language: 'zh' }, task_limits: { calls: 7 } });

let listener;
const sent = [];
const transport = {
  onEvent: callback => { listener = callback; return () => { listener = undefined; }; },
  send: async command => { sent.push(command); return { ok: true }; },
};
let completed = false;
const saving = savePreferences(patch, transport).then(() => { completed = true; });
const requestId = sent.at(-1).request_id;
listener({ type: 'settings.ready', request_id: 'other-window' });
await Promise.resolve();
assert.equal(completed, false); // IPC dispatch and unrelated refresh are not persistence receipts.
listener({ type: 'settings.ready', request_id: requestId });
await saving;
assert.equal(completed, true);
assert.equal(listener, undefined);

const rejected = savePreferences({ volume: .5 }, transport);
listener({ type: 'error', request_id: sent.at(-1).request_id, message: 'disk unavailable' });
await assert.rejects(rejected, /disk unavailable/);
assert.equal(listener, undefined);
const reset = savePreferences({ volume: .5 }, transport);
listener({ type: 'desktop.reset' });
await assert.rejects(reset, /草稿已保留/);
await assert.rejects(savePreferences({}, { ...transport, send: async () => ({ ok: false, error: 'offline' }) }), /offline/);
assert.equal(listener, undefined);
console.log('PASS: nested preference patches preserve resource configuration; saves require a matching backend receipt, reject write/offline errors and release listeners on reset.');
