import assert from 'node:assert/strict';
import { build } from 'esbuild';
const compiled = await build({ entryPoints: ['renderer/captionStack.ts'], bundle: true, format: 'esm', write: false });
const { captionLayer, captionStep } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
for (let selected = 0; selected < 9; selected++) {
  const layers = Array.from({ length: 9 }, (_, index) => captionLayer(index, selected));
  assert.equal(layers.filter(layer => layer.visible && layer.focused).length, 1);
  const front = layers[selected];
  assert.equal(front.x, 0); assert.equal(front.y, 0); assert.equal(front.scale, 1);
  for (const behind of layers.filter(layer => layer.visible && !layer.focused)) {
    assert(behind.z < front.z && behind.scale < front.scale);
    assert.equal(behind.opacity, 1, 'Stacked surfaces cannot leak text through transparency.');
    assert.equal(behind.blur, 0, 'Depth uses card edges instead of ghosted text.');
    assert(Math.abs(behind.y) <= 44, 'Nearby sentences overlap on one stage rather than occupy separate rows.');
  }
}
assert.equal(captionStep(0, -1, 9), 0);
assert.equal(captionStep(8, 1, 9), 8);
assert.equal(captionStep(4, -200, 9), 3, 'A wheel gesture turns one sentence at a time.');
assert.equal(captionStep(0, 1, 0), 0);
console.log('PASS: one front sentence, true overlapping depth layers, bounded history navigation.');
