import assert from 'node:assert/strict';
import { build } from 'esbuild';
const compiled = await build({ entryPoints: ['renderer/captionFocus.ts'], bundle: true, format: 'esm', write: false });
const { captionFocus } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const rows = [{ id: 'first', center: 100 }, { id: 'second', center: 200 }, { id: 'third', center: 300 }];
assert.equal(captionFocus([], 0), undefined);
assert.equal(captionFocus(rows, 150), 'first');
let focused = 'first';
for (const center of [149, 151, 148, 152, 150, 154]) {
  focused = captionFocus(rows, center, focused);
  assert.equal(focused, 'first', 'Small wheel changes cannot flicker emphasis between two equal neighbours.');
}
assert.equal(captionFocus(rows, 160, focused), 'second');
assert.equal(captionFocus(rows, 299, 'first'), 'third');
assert.equal(captionFocus(rows.slice(1), 190, 'removed'), 'second');
console.log('PASS: one focused caption, stable boundary hysteresis, fast scroll and removed entries.');
