/** Actual Electron integration verification. Run with --playwright-root <node_modules>. */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const moduleRoot = option('--playwright-root');
const packaged = option('--packaged');
const microphoneWav = option('--microphone-wav');
const actionsOnly = args.includes('--actions-only');
const require = createRequire(import.meta.url);
const { _electron } = require(require.resolve('playwright', { paths: [moduleRoot || root] }));
const directory = path.join(root, '.runtime', 'benchmarks', packaged ? 'packaged-desktop' : actionsOnly ? 'desktop-actions' : 'desktop');
mkdirSync(directory, { recursive: true });
const statePath = path.join(directory, 'target.json');
if (existsSync(statePath)) unlinkSync(statePath);
const basePython = spawnSync(path.join(root, '.venv', 'Scripts', 'python.exe'), ['-X', 'utf8', '-c', 'import sys; print(sys._base_executable)'], { cwd: root, windowsHide: true, encoding: 'utf8' }).stdout.trim();
// Start the actual interpreter so closing the test cannot orphan a venv child.
const target = spawn(basePython, ['-X', 'utf8', '-m', 'native.windows.demo_target', '--state', statePath, '--auto-close', '300'], { cwd: root, windowsHide: true, stdio: 'ignore' });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function targetEventually(field, expected) {
  for (let i = 0; i < 30; i++) {
    try { if (JSON.parse(readFileSync(statePath, 'utf8'))[field] === expected) return true; } catch { /* state publication tick */ }
    await wait(100);
  }
  return false;
}
for (let i=0; i<30 && !existsSync(statePath); i++) await wait(200);
let application;
let page;
const report = { errors: [], checks: {}, playback: [], scope: 'Electron app, actual WebAudio sample-consumption receipts; no acoustic judgment' };
try {
  application = await _electron.launch({
    executablePath: packaged || path.join(root, 'apps/desktop/node_modules/electron/dist/electron.exe'),
    args: [...(packaged ? [] : [path.join(root, 'apps/desktop')]), ...(microphoneWav ? ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${microphoneWav}`] : [])],
    env: { ...process.env, AYANA_DATA_DIR: path.join(directory, 'data'), AYANA_REPOSITORY_ROOT: packaged ? '' : root, AYANA_PYTHON: '' },
    timeout: 30000,
  });
  const windows = await application.windows();
  page = windows.find(w => w.url().includes('window=chat')) || await application.firstWindow();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForSelector('.workshop', { timeout: 15000 });
  await page.waitForFunction(() => window.ayana?.getState().then(s => s.connected), null, { timeout: 20000 });
  await page.evaluate(() => {
    window.__qaEvents = [];
    window.ayana.onEvent(event => window.__qaEvents.push({ ...event, received_performance_ms: performance.now(), pcm_base64: undefined, png_base64: undefined }));
  });
  const targetState = JSON.parse(readFileSync(statePath, 'utf8'));
  const summon = spawnSync(path.join(root, '.venv', 'Scripts', 'python.exe'), ['-c', 'from native.windows.win32 import Win32; import sys,time; a=Win32(); assert a.focus(int(sys.argv[1])); time.sleep(.15); a.send([a.key(17),a.key(18),a.key(65),a.key(65,flags=2),a.key(18,flags=2),a.key(17,flags=2)])', String(targetState.hwnd)], { cwd: root, windowsHide: true, encoding: 'utf8' });
  if (summon.status !== 0) throw new Error(`Could not summon from owned target: ${summon.stderr}`);
  await page.waitForFunction(hwnd => window.__qaEvents.some(e => e.type === 'target.bound' && e.target.hwnd === hwnd), targetState.hwnd, { timeout: 10000 });
  report.checks.hotkey_captured_original_target = true;
  await page.waitForFunction(() => document.querySelector('.snapshot')?.naturalWidth > 0, null, { timeout: 10000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.character')].every(img => img.naturalWidth > 0), null, { timeout: 10000 });
  report.checks.avatar_loaded = true;
  await page.locator('#repository-root').fill(root);
  await page.getByRole('button', { name: '读取仓库', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.repository-card strong')?.textContent === 'ayana-agent', null, { timeout: 10000 });
  await page.screenshot({ path: path.join(directory, 'welcome.png') });
  if (!actionsOnly) {
  await page.getByRole('textbox', { name: '输入问题' }).fill('看这个演示窗口，简短告诉我输入框叫什么，只说两句很短的日语并配中文。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(() => window.__qaEvents.some(e => e.type === 'playback.started' && e.output_sample_rate), null, { timeout: 90000 });
  await page.screenshot({ path: path.join(directory, 'speaking.png') });
  await page.waitForFunction(() => window.__qaEvents.some(e => e.type === 'playback.ended' && e.output_sample_rate), null, { timeout: 25000 });
  report.checks.real_audio_consumed = true;
  const priorGeneration = await page.evaluate(() => Math.max(...window.__qaEvents.filter(e => e.type === 'user.message').map(e => e.generation_id)));
  await page.getByRole('textbox', { name: '输入问题' }).fill('请解释README，先说五句短日语，配对应中文。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(prior => window.__qaEvents.some(e => e.type === 'playback.started' && e.output_sample_rate && e.generation_id > prior), priorGeneration, { timeout: 45000 });
  const interruptedGeneration = await page.evaluate(() => Math.max(...window.__qaEvents.filter(e => e.type === 'playback.started').map(e => e.generation_id)));
  const before = Date.now();
  await page.getByRole('button', { name: '打断', exact: true }).click();
  await page.waitForFunction(gen => window.__qaEvents.some(e => e.type === 'playback.cancelled' && e.generation_id === gen && e.output_sample_rate), interruptedGeneration, { timeout: 2000 });
  report.checks.cancel_receipt_ms = Date.now() - before;
  }
  await page.getByRole('button', { name: '单步执行', exact: true }).click();
  async function selectPoint(widgetName) {
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.isFocusable()).focus());
    const baseline = await page.evaluate(() => window.__qaEvents.filter(e => e.type === 'snapshot.ready').length);
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.waitForFunction(n => window.__qaEvents.filter(e => e.type === 'snapshot.ready').length > n, baseline);
    const snap = await page.evaluate(() => window.__qaEvents.filter(e => e.type === 'snapshot.ready').at(-1));
    const actual = JSON.parse(readFileSync(statePath, 'utf8')).widgets[widgetName];
    const x = (actual.x + actual.width / 2 - snap.transform.origin_x) / snap.transform.scale_x;
    const y = (actual.y + actual.height / 2 - snap.transform.origin_y) / snap.transform.scale_y;
    const bounds = await page.locator('.snapshot').boundingBox();
    await page.locator('.snapshot').click({ position: { x: x / snap.image_size_px.width * bounds.width, y: y / snap.image_size_px.height * bounds.height } });
  }
  await selectPoint('entry');
  await page.getByRole('button', { name: '显示高亮', exact: true }).click();
  await page.waitForFunction(() => window.__qaEvents.some(e => e.type === 'highlight.ready'));
  report.checks.highlight = true;
  await page.getByLabel('单步操作类型', { exact: true }).selectOption('type');
  await page.getByPlaceholder('要输入到目标窗口的文字').fill('Ayana verified demo');
  let completed = await page.evaluate(() => window.__qaEvents.filter(e => e.type === 'tool.completed' && e.tool === 'execute_step').length);
  await page.getByRole('button', { name: '确认并执行一步', exact: true }).click();
  await page.waitForFunction(n => window.__qaEvents.filter(e => e.type === 'tool.completed' && e.tool === 'execute_step').length > n, completed, { timeout: 15000 });
  report.checks.single_step_type = await targetEventually('message', 'Ayana verified demo');
  await selectPoint('button');
  await page.getByLabel('单步操作类型', { exact: true }).selectOption('click');
  completed = await page.evaluate(() => window.__qaEvents.filter(e => e.type === 'tool.completed' && e.tool === 'execute_step').length);
  await page.getByRole('button', { name: '确认并执行一步', exact: true }).click();
  await page.waitForFunction(n => window.__qaEvents.filter(e => e.type === 'tool.completed' && e.tool === 'execute_step').length > n, completed, { timeout: 15000 });
  report.checks.single_step_observed = await targetEventually('output', 'Received: Ayana verified demo');
  await page.screenshot({ path: path.join(directory, 'action.png') });
  if (microphoneWav) {
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.isFocusable()).focus());
    await page.getByRole('button', { name: '教我理解', exact: true }).click();
    const mic = page.getByRole('button', { name: '按住说话，松开识别，最长15秒', exact: true });
    const bounds = await mic.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.waitForFunction(() => document.querySelector('.mic-button.recording'), null, { timeout: 5000 });
    await wait(3800);
    await page.mouse.up();
    await page.waitForFunction(() => window.__qaEvents.some(e => e.type === 'input.transcribed'), null, { timeout: 20000 });
    report.checks.microphone_webm_transcribed = true;
    report.microphone = { source: 'Chromium fake microphone fed a real pre-generated Japanese WAV; excludes physical microphone acquisition and user accuracy', transcript: await page.evaluate(() => window.__qaEvents.find(e => e.type === 'input.transcribed').text) };
    await page.evaluate(() => window.ayana.send({ type: 'generation.cancel' }));
    await page.screenshot({ path: path.join(directory, 'microphone.png') });
  }
  await page.getByRole('button', { name: '偏好设置', exact: true }).click();
  await page.waitForSelector('.settings-dialog[open]');
  await page.screenshot({ path: path.join(directory, 'settings.png') });
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.getByRole('button', { name: '仓库文件', exact: false }).first().click();
  await page.waitForSelector('.evidence-cards');
  report.checks.repository_evidence_visible = (await page.locator('.evidence-cards article').count()) > 0;
  await page.screenshot({ path: path.join(directory, 'files.png') });
  report.playback = await page.evaluate(() => window.__qaEvents.filter(e => e.type.startsWith('playback.') || e.type === 'generation.cancelled' || e.type === 'error'));
  report.windows = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ title: w.getTitle(), focusable: w.isFocusable(), always_on_top: w.isAlwaysOnTop(), bounds: w.getBounds() })));
  report.runtime = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, resources: process.resourcesPath, data: app.getPath('userData') }));
  report.passed = report.errors.length === 0 && (actionsOnly || report.checks.real_audio_consumed) && report.checks.repository_evidence_visible && report.checks.single_step_type && report.checks.single_step_observed && (actionsOnly || report.checks.cancel_receipt_ms < 1000) && (!microphoneWav || report.checks.microphone_webm_transcribed);
  report.actions_only = actionsOnly;
} catch (error) {
  report.errors.push(String(error));
  throw error;
} finally {
  if (page && !page.isClosed()) {
    report.events = await page.evaluate(() => window.__qaEvents || []);
    await page.screenshot({ path: path.join(directory, 'final.png') }).catch(() => {});
  }
  if (application) await application.close();
  target.kill();
  writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ ...report, events: undefined, playback: report.playback.filter(e => e.type !== 'playback.progress') }, null, 2));
if (!report.passed) process.exitCode = 1;
