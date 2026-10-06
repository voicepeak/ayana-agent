/** Isolated Windows hit testing, portrait pointer gestures and restart persistence. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), option = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
const require = createRequire(import.meta.url);
const { _electron } = require(require.resolve('playwright', { paths: [option('--playwright-root') || root] }));
const directory = path.join(root, '.runtime/benchmarks', `companion-appearance-${Date.now()}`), data = path.join(directory, 'profile');
mkdirSync(path.join(data, 'config'), { recursive: true });
writeFileSync(path.join(data, 'config/local.json'), JSON.stringify({ provider: 'local', voice: { voice_mode: 'silent' }, stt: { provider: 'disabled' }, hotkey: 'Control+Alt+F6', cancel_hotkey: 'Control+Alt+F7' }));
const launch = () => _electron.launch({ executablePath: option('--packaged') || path.join(root, 'apps/desktop/node_modules/electron/dist/electron.exe'),
  args: [...(option('--packaged') ? [] : [path.join(root, 'apps/desktop')]), `--user-data-dir=${data}`],
  env: { ...process.env, AYANA_DATA_DIR: data, AYANA_REPOSITORY_ROOT: option('--packaged') ? '' : root, AYANA_PYTHON: option('--packaged') ? '' : path.join(root, '.venv/Scripts/python.exe') }, timeout: 30000 });
const report = { checks: [], errors: [] };
let app, page, design;
async function setup() {
  app = await launch();
  const windows = await app.windows();
  page = windows.find(w => w.url().includes('window=chat')); design = windows.find(w => w.url().includes('window=design'));
  windows.forEach(w => w.on('pageerror', error => report.errors.push(error.message)));
  await page.waitForFunction(() => window.ayana.getState().then(s => s.connected), null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('img.character')?.naturalWidth > 0);
}
const bounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=chat')).getBounds());
const closeEnough = (actual, expected) => { for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(actual[key] - expected[key]) <= 2, `${key}: ${actual[key]} != ${expected[key]}`); };
const adjust = (label, value) => design.getByLabel(label, { exact: true }).evaluate((node, value) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, String(value));
  node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }));
}, value);
const drag = async (dx, dy, release = 'up') => {
  const box = await page.locator('.portrait-stage').boundingBox();
  const canvas = await page.locator('.portrait-canvas').boundingBox();
  const x = Math.min(canvas.x + canvas.width - 16, Math.max(canvas.x + 16, box.x + box.width / 2));
  const y = canvas.y + Math.min(70, canvas.height / 2);
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  if (release === 'cancel') await page.locator('.portrait-stage').evaluate(node => node.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 })));
  if (release === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up();
};
try {
  await setup();
  const original = await bounds();
  const header = await page.locator('.companion-title-drag-area').boundingBox();
  const native = await app.evaluate(({ BrowserWindow, screen }, header) => {
    const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=chat')), b = w.getBounds();
    return { hwnd: w.getNativeWindowHandle().readUInt32LE(), resizable: w.isResizable(),
      points: [[1, b.height / 2], [b.width - 1, b.height / 2], [b.width / 2, 1], [b.width / 2, b.height - 1], [1, 1], [b.width - 1, 1], [1, b.height - 1], [b.width - 1, b.height - 1], [header.x + header.width / 2, header.y + header.height / 2]]
        .map(([x, y]) => screen.dipToScreenPoint({ x: Math.round(b.x + x), y: Math.round(b.y + y) })) };
  }, header);
  const hits = native.points.map(p => Number(execFileSync(path.join(root, '.venv/Scripts/python.exe'), ['-c',
    'from native.windows.win32 import Win32,ULONG_PTR; import ctypes as C,sys; a=Win32(); r=ULONG_PTR(); a.user.SendMessageTimeoutW(int(sys.argv[1]),0x84,0,(int(sys.argv[2])&65535)|((int(sys.argv[3])&65535)<<16),2,1000,C.byref(r)); print(r.value)',
    String(native.hwnd), String(p.x), String(p.y)], { cwd: root, windowsHide: true }).toString().trim()));
  assert(native.resizable); assert.deepEqual(hits, [10, 11, 12, 15, 13, 14, 16, 17, 2]);
  report.nativeHits = hits;
  report.checks.push('Windows recognizes all four edges and all four corners as native resize targets, and the header as its native caption');
  await page.evaluate(() => window.ayana.summon());
  await page.getByLabel('输入问题', { exact: true }).press('Escape');
  const baseline = await page.locator('.portrait-stage').boundingBox();
  const canvas = await page.locator('.portrait-canvas').boundingBox();
  assert(Math.abs(canvas.height / baseline.height - .72) < .015);
  const initialX = await page.evaluate(() => window.ayana.getState().then(s => s.designPreview.portrait_x));
  await drag(-110, 30);
  await page.waitForFunction(x => window.ayana.getState().then(s => s.designPreview.portrait_x < x - 80), initialX);
  await page.waitForFunction(() => document.querySelector('.portrait-stage').dataset.dragging === 'false');
  closeEnough(await bounds(), original);
  assert.equal(await page.evaluate(() => getSelection().toString()), '');
  assert.notEqual(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '输入问题');
  await page.waitForTimeout(250);
  const savedPosition = JSON.parse(readFileSync(path.join(data, 'config/local.json'), 'utf8')).companion_ui;
  assert(savedPosition.portrait_x < -80); assert(savedPosition.portrait_y > 0);
  await page.evaluate(() => window.ayana.send({ type: 'turn.start', text: '拖动彩名时不要选中这段文字' }));
  await page.getByLabel('你上一句说的话', { exact: true }).getByText('拖动彩名时不要选中这段文字', { exact: true }).waitFor();
  await drag(-350, 0);
  assert.equal(await page.evaluate(() => getSelection().toString()), '', 'Dragging across real question text must not select it.');
  closeEnough(await bounds(), original);
  await page.mouse.move(20, 65);
  await page.screenshot({ path: path.join(directory, 'dragged.png'), omitBackground: true });
  await drag(35, -15, 'cancel'); await drag(-20, 10, 'blur');
  assert.equal(await page.locator('.portrait-stage').getAttribute('data-dragging'), 'false');
  report.checks.push('portrait moves inside its clipped frame without moving the window, selecting text or opening input; release/cancel/blur finish the gesture and save position');

  await page.getByLabel('打开设计控件', { exact: true }).click();
  assert.equal(await design.getByLabel('水平位置', { exact: true }).count(), 0);
  assert.equal(await design.getByRole('button', { name: '看全身', exact: true }).count(),0); await adjust('立绘大小',230);
  await page.waitForFunction(() => {
    const portrait = document.querySelector('.portrait-stage').getBoundingClientRect(), area = document.querySelector('.portrait-canvas').getBoundingClientRect();
    return portrait.height <= area.height;
  });
  assert.equal(await design.getByRole('button', { name: '到膝盖', exact: true }).count(),0); await adjust('立绘大小',320);
  const costume = await design.getByLabel('服装', { exact: true }).evaluate(select => [...select.options].find(option => option.value !== select.value).value);
  await design.getByLabel('服装', { exact: true }).selectOption(costume);
  await design.getByText('服装已更换', { exact: true }).waitFor();
  const catalogue = JSON.parse(readFileSync(path.join(root, 'characters/ayana/avatar-map.json'), 'utf8')).assets;
  const costumeIds = Object.keys(catalogue).filter(id => catalogue[id].costume === costume);
  await page.waitForFunction(ids => ids.some(id => document.querySelector('img.character')?.getAttribute('src') === `ayana-asset://${id}/`), costumeIds);
  await adjust('立绘大小', 640);
  await page.waitForFunction(() => window.ayana.getState().then(s => s.designPreview.portrait_size === 640));
  const big = await page.locator('.portrait-stage').boundingBox(); assert(big.height > baseline.height * 1.9);
  assert.equal(await design.getByRole('button', { name: '到膝盖', exact: true }).count(),0); await adjust('立绘大小',320);
  if(await design.getByRole('button', { name: '保存设计', exact: true }).isEnabled()){await design.getByRole('button', { name: '保存设计', exact: true }).click(); await design.getByText('设计已保存', { exact: true }).waitFor();}
  await design.getByRole('tab', { name: '便签', exact: true }).click();
  assert.equal(await design.getByLabel('便签宽度', { exact: true }).count(), 0);
  assert.equal(await design.getByLabel('便签高度', { exact: true }).count(), 0);
  await design.screenshot({ path: path.join(directory, 'window-controls.png'), omitBackground: true });
  await design.getByLabel('收起设计控件', { exact: true }).click();
  report.checks.push('size slider scales the full-body source independently of the frame; preset buttons and frame/position sliders are removed');

  const resized = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=chat'));
    w.setBounds({ ...w.getBounds(), width: 610, height: 410 }); return w.getBounds();
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.ayana.previewDesign({ opacity: 65, background_mode: 'transparent' }));
  await page.waitForTimeout(100); closeEnough(await bounds(), resized);
  await page.screenshot({ path: path.join(directory, 'transparent-resized.png'), omitBackground: true });
  await page.evaluate(() => window.ayana.send({ type: 'settings.update', settings: { companion_ui: { opacity: 100, background_mode: 'minimal' } } }));
  await page.waitForTimeout(300); closeEnough(await bounds(), resized);
  await app.evaluate(({ screen }) => screen.emit('display-metrics-changed', {}, ['workArea']));
  await page.waitForTimeout(150); closeEnough(await bounds(), resized);
  const persisted = JSON.parse(readFileSync(path.join(data, 'companion-position.json'), 'utf8'));
  assert.equal(persisted.version, 3); closeEnough(persisted, resized);
  await app.close(); app = undefined; await setup();
  await page.waitForTimeout(250); closeEnough(await bounds(), resized);
  assert.equal(await page.evaluate(() => window.ayana.getState().then(s => s.designPreview.portrait_size)), 320);
  const finalPortrait = await page.locator('.portrait-stage').boundingBox(), finalArea = await page.locator('.portrait-canvas').boundingBox();
  assert(finalPortrait.x >= finalArea.x - 1 && finalPortrait.x + finalPortrait.width <= finalArea.x + finalArea.width + 1);
  await page.screenshot({ path: path.join(directory, 'restored.png'), omitBackground: true });
  report.checks.push('native size and position survive appearance preview, settings snapshots, display refresh and restart; portrait adapts inside the smaller scene');
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) {
  report.passed = false; report.failure = String(error); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(directory, 'failure.png'), omitBackground: true }).catch(() => {});
} finally {
  if (app) await app.close();
  writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, directory }, null, 2));
}
