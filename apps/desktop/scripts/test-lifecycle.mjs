import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const main = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
const compiled = await build({
  stdin: { contents: main + '\nexport const lifecycleProbe = { restart: restartRuntime };', loader: 'ts',
    resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws'],
});
let connections = 0;
class FakeSocket extends EventEmitter {
  static OPEN = 1;
  constructor() { super(); connections++; }
  terminate() {}
}
const electron = {
  app: { setName() {}, requestSingleInstanceLock: () => false, quit() {}, on() {},
    getPath: () => '/test-only', isPackaged: false },
  protocol: { registerSchemesAsPrivileged() {} },
};
const fakeFs = { existsSync: () => false, mkdirSync() {}, appendFileSync() {} };
const fakeNet = { createServer: () => ({ once() {},
  listen(_port, _host, callback) { callback(); }, address: () => ({ port: 17321 }),
  close(callback) { callback(); },
}) };
const fakeProcess = { env: {}, platform: process.platform, resourcesPath: '/test-resources' };
const mod = { exports: {} };
const context = vm.createContext({ module: mod, exports: mod.exports, process: fakeProcess,
  __dirname: path.resolve('dist-electron'), Buffer, URL, Response, setTimeout, clearTimeout,
  require: name => {
    if (name === 'electron') return electron;
    if (name === 'ws') return FakeSocket;
    if (name === 'node:fs') return fakeFs;
    if (name === 'node:net') return fakeNet;
    if (name === 'node:child_process') return { spawn: () => Object.assign(new EventEmitter(), { exitCode: 0 }) };
    return require(name);
  },
});
vm.runInContext(compiled.outputFiles[0].text, context);
await mod.exports.lifecycleProbe.restart();
assert.equal(connections, 1, 'Restart must initiate a connection to the new backend.');
await mod.exports.lifecycleProbe.restart();
assert.equal(connections, 2, 'A second restart must also connect.');
console.log('PASS: Backend restart creates a new authenticated connection on every restart.');
