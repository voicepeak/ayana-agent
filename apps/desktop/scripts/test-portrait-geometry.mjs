import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
const compiled = await build({ entryPoints: ['renderer/portraitGeometry.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports });
const { portraitLayout } = module.exports;
const base = { portrait_size: 320, portrait_side: 'right', portrait_x: 0, portrait_y: 0 };
const area = { width: 760, height: 350 };
const knee = portraitLayout(area, 472 / 1656, base);
assert(Math.abs(area.height / knee.height - .72) < .001, 'Default crop reaches the knees using the full-body source.');
assert(portraitLayout(area, 472 / 1656, { ...base, portrait_size: 230 }).height <= area.height, 'Full-body preset fits head to feet.');
for (const view of [area, { width: 380, height: 220 }, { width: 1400, height: 800 }]) {
  for (const size of [160, 320, 640]) {
    const edge = portraitLayout(view, 592 / 1656, { ...base, portrait_size: size, portrait_x: 4096, portrait_y: -4096 });
    assert(edge.x >= 0 && edge.x + edge.width <= view.width + .01, 'Drawing cannot be dragged out horizontally.');
    assert(edge.y + edge.height >= view.height || edge.y === 0, 'Upward drag keeps the lower end of a large drawing in the frame.');
    const lower = portraitLayout(view, 592 / 1656, { ...base, portrait_size: size, portrait_x: -4096, portrait_y: 4096 });
    assert(lower.y + Math.min(96, lower.height) <= view.height, 'Downward drag always leaves a reachable portion.');
  }
}
console.log('PASS: full-body source, knee crop, full-body preset and drag limits after resize/scale changes.');
