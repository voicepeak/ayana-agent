import assert from 'node:assert/strict';
import { build } from 'esbuild';
const compiled = await build({ entryPoints: ['renderer/captionStack.ts'], bundle: true, format: 'esm', write: false });
const { captionAnchor, captionSpring, captionStep } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
assert.equal(captionAnchor(300, 100, 400), 150, 'The chosen sentence is centered in the reel.');
assert.equal(captionAnchor(0, 100, 400), 0, 'The first sentence stays inside the scroll bounds.');
assert.equal(captionAnchor(3900, 100, 400), 3750, 'The last sentence can still reach the reading line.');
assert.equal(captionStep(0, -1, 9), 0);
assert.equal(captionStep(8, 1, 9), 8);
assert.equal(captionStep(4, -200, 9), 3, 'Keyboard and button navigation move one sentence.');
assert.equal(captionStep(0, 1, 0), 0);
let current = 0, velocity = 0, frames = 0;
while (frames < 180) {
  const step = captionSpring(current, 320, velocity, 1 / 60);
  current = step.value; velocity = step.velocity; frames++;
  if (step.settled) break;
}
assert(current > 319 && current < 322, 'Wheel motion settles on the requested offset.');
assert(frames > 10, 'Wheel motion is damped over time instead of jumping in one frame.');
const first = captionSpring(0, 320, 0, 1 / 60);
assert(first.value > 0 && first.value < 80, 'A wheel gesture starts gently, not with an instant jump.');
console.log('PASS: free scrolling, centered anchors, one-step navigation and damped wheel motion.');
