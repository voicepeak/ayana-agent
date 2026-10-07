import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['renderer/commandReceipt.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react'] });
const module = { exports: {} };
vm.runInContext(compiled.outputFiles[0].text, vm.createContext({ window: {}, module, exports: module.exports, require: () => ({}), crypto: webcrypto, setTimeout, clearTimeout }));
const { commandReceipt } = module.exports;
let listener;
const sent = [];
const transport = { onEvent: callback => { listener = callback; return () => { listener = undefined; }; },
  send: async command => { sent.push(command); return { ok: true }; } };
let saved = false;
const pending = commandReceipt({ type: 'memory.update', memory_id: 'one', content: 'New fact' }, 'memory.ready', transport).then(() => { saved = true; });
listener({ type: 'memory.ready', request_id: 'background-extraction' });
await Promise.resolve(); assert.equal(saved, false);
listener({ type: 'memory.ready', request_id: sent.at(-1).request_id });
await pending; assert.equal(saved, true); assert.equal(listener, undefined);
const failed = commandReceipt({ type: 'memory.forget', memory_id: 'one' }, 'memory.ready', transport);
listener({ type: 'error', request_id: sent.at(-1).request_id, message: 'disk unavailable' });
await assert.rejects(failed, /disk unavailable/); assert.equal(listener, undefined);
const reset = commandReceipt({ type: 'memory.update' }, 'memory.ready', transport);
listener({ type: 'desktop.reset' }); await assert.rejects(reset, /重启/); assert.equal(listener, undefined);
await assert.rejects(commandReceipt({ type: 'memory.update' }, 'memory.ready', { ...transport, send: async () => ({ ok: false, error: 'offline' }) }), /offline/);
assert.equal(listener, undefined);
console.log('PASS: memory edits/forgetting require correlated persistence receipts; errors, reset and offline dispatch reject and release listeners.');
