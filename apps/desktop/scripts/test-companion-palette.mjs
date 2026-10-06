import assert from 'node:assert/strict';
import { build } from 'esbuild';
const compiled = await build({ entryPoints: ['renderer/companionPalette.ts'], bundle: true, format: 'esm', write: false });
const { surfacePalette, contrastRatio } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
// Mid-tone saturated colours expose failures that a simple light/dark brightness threshold misses.
for (const red of [0, 51, 102, 153, 204, 255]) for (const green of [0, 51, 102, 153, 204, 255]) for (const blue of [0, 51, 102, 153, 204, 255]) {
  const color = '#' + [red, green, blue].map(channel => channel.toString(16).padStart(2, '0')).join('');
  const palette = surfacePalette(color);
  for (const key of ['text', 'muted', 'accent']) assert(contrastRatio(color, palette[key]) >= 4.5, `${key} is unreadable against ${color}`);
  assert(contrastRatio(color, palette.border) >= 3, `Edge disappears against ${color}`);
}
console.log('PASS: readable text, controls and surface borders across dark, light and saturated custom colours.');
