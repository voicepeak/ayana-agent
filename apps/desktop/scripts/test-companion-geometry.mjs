import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
const compiled = await build({ entryPoints: ['electron/companionGeometry.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports });
const { companionSize, companionDragBounds, inspectorBounds } = module.exports;
for (const work of [{ x: 0, y: 0, width: 1097, height: 666 }, { x: -1920, y: -200, width: 1920, height: 1040 }]) {
  const size = companionSize({ frame_width: 760, frame_height: 720 }, work);
  assert(size.height < work.height - 32, 'Small screens retain vertical movement.');
  const origin = { ...size, x: work.x + 100, y: work.y + 100 }, start = { x: origin.x + 200, y: origin.y + 30 };
  const moved = companionDragBounds(origin, start, { x: start.x - 50, y: start.y - 60 }, work);
  assert.equal(moved.x, origin.x - 50); assert.equal(moved.y, origin.y - 60);
  const reversed = companionDragBounds(origin, start, { x: start.x - 20, y: start.y - 30 }, work);
  assert.equal(reversed.x, origin.x - 20); assert.equal(reversed.y, origin.y - 30);
  const clamped = companionDragBounds(origin, start, { x: work.x - 2000, y: work.y - 2000 }, work);
  assert.equal(clamped.x, work.x); assert.equal(clamped.y, work.y);
  const inspector = inspectorBounds(origin, work);
  assert(inspector.x >= work.x && inspector.y >= work.y && inspector.x + inspector.width <= work.x + work.width && inspector.y + inspector.height <= work.y + work.height);
}
const dock = inspectorBounds({ x: 900, y: 200, width: 784, height: 504 }, { x: 0, y: 0, width: 1920, height: 1040 });
assert.equal(dock.x, 554); assert.equal(dock.y, 212);
const smallWork = { x: 0, y: 0, width: 1097, height: 666 }, smallCard = { x: 289, y: 80, width: 784, height: 504 };
console.log('PASS: absolute native drag, reversal, small screens, negative monitor coordinates and adjacent inspector placement.');
