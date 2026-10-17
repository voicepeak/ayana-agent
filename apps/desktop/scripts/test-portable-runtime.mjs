import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: ['electron/portableRuntime.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
});
const module = { exports: {} };
const require = createRequire(import.meta.url);
new Function('module', 'exports', 'require', compiled.outputFiles[0].text)(
  module, module.exports, name => name === 'node:fs' ? fs : require(name));
const { stagePortableRuntime, releasePortableRuntime, removeTree } = module.exports;

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ayana-portable-'));
const resources = path.join(workspace, 'resources');
const persona = path.join(resources, 'backend', 'characters', 'ayana', 'persona.md');
const interpreter = path.join(resources, 'python', 'python.exe');
function installResources() {
  fs.mkdirSync(path.dirname(persona), { recursive: true });
  fs.mkdirSync(path.dirname(interpreter), { recursive: true });
  fs.writeFileSync(persona, 'persona');
  fs.writeFileSync(interpreter, 'interpreter');
}
installResources();

const userData = path.join(workspace, 'user-data');
const staged = stagePortableRuntime(resources, userData, 42);
assert.equal(staged.backend, path.join(staged.root, 'backend'));
assert.equal(staged.python, path.join(staged.root, 'python', 'python.exe'));
assert.equal(fs.readFileSync(path.join(staged.backend, 'characters', 'ayana', 'persona.md'), 'utf8'), 'persona');

// The NSIS launcher and temp cleaners delete the unlocked originals while the
// desktop process keeps running. The staged names must keep the data alive.
removeTree(resources);
assert.equal(fs.existsSync(resources), false);
assert.equal(fs.readFileSync(path.join(staged.backend, 'characters', 'ayana', 'persona.md'), 'utf8'), 'persona');
assert.equal(fs.readFileSync(staged.python, 'utf8'), 'interpreter');
releasePortableRuntime(staged.root);
assert.equal(fs.existsSync(staged.root), false, 'Quitting must not leave an extracted runtime behind.');
console.log('PASS: portable runtime survives deletion of %TEMP% copies and is removed on quit.');

// A failed cleanup from an earlier crashed session must not block startup.
installResources();
const fallback = stagePortableRuntime(resources, userData, 77, () => {
  throw Object.assign(new Error('in use'), { code: 'EBUSY' });
});
assert.equal(path.basename(fallback.root), 'session-77');
assert.equal(fs.readFileSync(path.join(fallback.backend, 'characters', 'ayana', 'persona.md'), 'utf8'), 'persona');
releasePortableRuntime(fallback.root);
console.log('PASS: a locked stale runtime falls back to a fresh session slot.');

removeTree(workspace);
