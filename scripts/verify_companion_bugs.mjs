/** Companion regression: rapid portraits, draft merging, bounded layout and native stacking. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const require = createRequire(import.meta.url);
const { _electron } = require(require.resolve('playwright', { paths: [option('--playwright-root') || root] }));
const directory = path.join(root, '.runtime/benchmarks', `companion-bugs-${Date.now()}`);
const data = path.join(directory, 'profile');
mkdirSync(path.join(data, 'config'), { recursive: true });
writeFileSync(path.join(data, 'config/local.json'), JSON.stringify({ provider: 'local', voice: { voice_mode: 'silent' },
  stt: { provider: 'disabled' }, hotkey: 'Control+Alt+F6', cancel_hotkey: 'Control+Alt+F7' }));
const defaults = JSON.parse(readFileSync(path.join(root, 'config/default.json'), 'utf8'));
const catalog = JSON.parse(readFileSync(path.join(root, 'characters/ayana/avatar-map.json'), 'utf8')).assets;
const school = Object.keys(catalog).find(id => catalog[id].costume === '校服' && catalog[id].source_expression === '休闲' && catalog[id].pose === 'crossed');
const alternate = Object.keys(catalog).find(id => catalog[id].costume !== '校服');
const report = { checks: [], errors: [] };
let application, page, design;
const emit = events => application.evaluate(({ BrowserWindow }, events) => {
  const chat = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=chat'));
  for (const event of events) chat.webContents.send('ayana:event', { protocol_version: 1, ...event });
}, events);
const adjust = (label, value) => design.getByLabel(label, { exact: true }).evaluate((node, value) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, String(value));
  node.dispatchEvent(new Event('input', { bubbles: true }));
  node.dispatchEvent(new Event('change', { bubbles: true }));
}, value);
const boundsReport = () => page.evaluate(() => {
  const note = document.querySelector('.companion-note').getBoundingClientRect();
  const selectors = ['.portrait-canvas', '.cinematic-memory', '.floating-input', '.companion-frame-heading'];
  return selectors.map(selector => {
    const node = document.querySelector(selector); if (!node) return { selector, valid: true };
    const b = node.getBoundingClientRect();
    return { selector, valid: b.left >= note.left - 1 && b.right <= note.right + 1 && b.top >= note.top - 1
      && b.bottom <= note.bottom + 1 && node.scrollWidth <= node.clientWidth + 1, bounds: b.toJSON(), scroll: [node.scrollWidth, node.clientWidth] };
  });
});
try {
  application = await _electron.launch({ executablePath: option('--packaged') || path.join(root, 'apps/desktop/node_modules/electron/dist/electron.exe'),
    args: [...(option('--packaged') ? [] : [path.join(root, 'apps/desktop')]), `--user-data-dir=${data}`],
    env: { ...process.env, AYANA_DATA_DIR: data, AYANA_REPOSITORY_ROOT: option('--packaged') ? '' : root,
      AYANA_PYTHON: option('--packaged') ? '' : path.join(root, '.venv/Scripts/python.exe') }, timeout: 30000 });
  page = (await application.windows()).find(w => w.url().includes('window=chat'));
  design = (await application.windows()).find(w => w.url().includes('window=design'));
  for (const window of await application.windows()) window.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => window.ayana.getState().then(state => state.connected), null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('img.character')?.naturalWidth > 0);
  await page.getByRole('button', { name: '打开设计控件', exact: true }).click();
  await design.getByRole('tab', { name: '对白', exact: true }).click(); await adjust('字幕字号', 26);
  // A real external settings update must preserve the pending font preview.
  await page.evaluate(() => window.ayana.send({ type: 'settings.update', settings: { companion_ui: { frame_width: 900 } }, request_id: 'external-width' }));
  await page.waitForFunction(() => document.querySelector('.companion-shell').style.getPropertyValue('--frame-width') === '900px');
  assert.equal(await design.getByLabel('字幕字号', { exact: true }).inputValue(), '26');
  const before = await page.locator('.portrait-stage').boundingBox();
  await design.getByRole('button', { name: '保存设计', exact: true }).click();
  await design.getByText('设计已保存', { exact: true }).waitFor();
  assert.equal(await design.getByRole('button', { name: '保存设计', exact: true }).isEnabled(), false);
  const stored = JSON.parse(readFileSync(path.join(data, 'config/local.json'), 'utf8'));
  assert.equal(stored.companion_ui.font_size, 26);
  assert.equal(stored.companion_ui.frame_width, 900, 'Saving font preserves the external width.');
  assert.deepEqual(await page.locator('.portrait-stage').boundingBox(), before);
  await adjust('字幕字号', defaults.companion_ui.font_size);
  assert.equal(await design.getByRole('button', { name: '保存设计', exact: true }).isEnabled(), true);
  await adjust('字幕字号', 26);
  assert.equal(await design.getByRole('button', { name: '保存设计', exact: true }).isEnabled(), false, 'Reverting a preview clears dirty status.');
  await design.getByRole('tab', { name: '立绘', exact: true }).click(); await adjust('立绘大小',230);
  await adjust('立绘大小', 220);
  await page.waitForTimeout(100);
  const smallPortrait = await page.locator('img.character').boundingBox();
  await adjust('立绘大小', 380);
  await page.waitForTimeout(100);
  const largePortrait = await page.locator('img.character').boundingBox();
  assert(largePortrait.height > smallPortrait.height * 1.5, 'Portrait size must change the full-body image, including when height limits its width.');
  await design.getByRole('button', { name: '重置设计', exact: true }).click();
  await design.getByRole('button', { name: '收起设计控件', exact: true }).click();
  report.checks.push('design editor does not overlap wide notes; external updates merge by field; saving sends only edits; reverting clears dirty status');

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const portrait = async (id, generation) => emit([{ type: 'utterance.ready', generation_id: generation,
    utterance_id: `portrait-${generation}`, asset_id: id, speech_ja: '着替えるね。', presentation: 'costume-change', audio_enabled: true }]);
  await portrait(alternate, 100);
  await page.waitForFunction(id => document.querySelector('img.character')?.getAttribute('src') === `ayana-asset://${id}/`, alternate);
  // Voice never starts: outfit must already be committed visually.
  await portrait(school, 101);
  await page.waitForTimeout(120);
  await portrait(alternate, 102);
  await page.waitForTimeout(90);
  await portrait(school, 103);
  await page.waitForFunction(id => document.querySelector('img.character')?.getAttribute('src') === `ayana-asset://${id}/`, school);
  await page.waitForTimeout(1100);
  assert.equal(await page.locator('.character-figure').evaluate(node => getComputedStyle(node).opacity), '1');
  await portrait('missing_portrait_fixture', 104);
  await page.getByRole('status').filter({ hasText: '新立绘加载失败' }).waitFor();
  assert.equal(await page.locator('img.character').getAttribute('src'), `ayana-asset://${school}/`);
  await portrait(alternate, 105);
  await page.waitForFunction(id => document.querySelector('img.character')?.getAttribute('src') === `ayana-asset://${id}/`, alternate);
  await page.waitForTimeout(1100);
  assert.equal(await page.locator('.asset-missing').count(), 0);
  report.checks.push('outfit is visible before voice starts; rapid switches settle on the latest decoded image; failed images preserve the portrait and recover');

  const ja = 'ゆっくり、一緒に考えよう。全部を一度に決める必要はないよ。まず目の前のことから確認して、それから次のことに進もう。'.repeat(5);
  const zh = '慢慢来，我们先把整件事情想清楚，再一步一步去做。所有内容都应该能读到。'.repeat(5);
  await emit([{ type: 'settings.ready', settings: { ...defaults, voice: { voice_mode: 'sovits' }, companion_ui: { ...defaults.companion_ui, show_japanese: true, translation_language: 'ja', font_size: 26 } } },
    { type: 'utterance.ready', generation_id: 200, utterance_id: 'long-caption', speech_ja: ja, audio_enabled: true },
    { type: 'subtitle.ready', generation_id: 200, utterance_id: 'long-caption', display_zh: zh },
    { type: 'playback.started', generation_id: 200, utterance_id: 'long-caption', total_samples: 1000 },
    { type: 'playback.progress', generation_id: 200, utterance_id: 'long-caption', played_samples: 800, total_samples: 1000 }]);
  await page.getByLabel('输入问题', { exact: true }).fill('第一行\n第二行\n第三行\n第四行');
  for (const [width, height, frameWidth, portraitSize] of [[1040,720,900,380], [820,600,760,380], [540,480,380,380], [360,460,380,220]]) {
    await application.evaluate(({ BrowserWindow }, size) => { const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=chat')); w.setResizable(true); w.setMinimumSize(240,200); w.setSize(...size); }, [width,height]);
    await page.waitForFunction(width => Math.abs(innerWidth - width) <= 2, width);
    await page.evaluate(({ frameWidth, portraitSize }) => {
      const style = document.querySelector('.companion-shell').style;
      style.setProperty('--frame-width', `${frameWidth}px`); style.setProperty('--portrait-size', `${portraitSize}px`);
    }, { frameWidth, portraitSize });
    for (const size of [160, 640]) {
      await page.evaluate(size => window.ayana.previewDesign({portrait_size:size}), size);
      await page.waitForTimeout(160);
      const bounds = await boundsReport();
      assert(bounds.every(result => result.valid), JSON.stringify({ width, height, size, bounds }));
    }
    await page.screenshot({ path: path.join(directory, `layout-${width}.png`), omitBackground: true });
  }
  report.checks.push('four window sizes, both portrait scale extremes, maximum font, long bilingual captions and multiline input remain bounded');

  await page.evaluate(() => window.ayana.openSettings('tasks'));
  const settings = (await application.windows()).find(w => w.url().includes('window=settings'));
  await settings.getByRole('heading', { name: '任务与结果', exact: true }).waitFor();
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=chat')).isAlwaysOnTop()), false);
  await page.evaluate(() => window.ayana.openSettings());
  await settings.getByRole('heading', { name: '外观与声音', exact: true }).waitFor();
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=chat')).isAlwaysOnTop()), true);
  report.checks.push('management appears above the companion; Settings opens the right page; closing restores companion stacking');
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = String(error); report.passed = false; process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(directory, 'failure.png'), omitBackground: true }).catch(() => {});
} finally {
  if (application) await application.close();
  writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, directory }, null, 2));
}
