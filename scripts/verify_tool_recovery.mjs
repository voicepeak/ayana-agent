/** Isolated Electron/backend verification; no personal model or conversation data. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), option = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
const require = createRequire(import.meta.url);
const { _electron } = require(require.resolve('playwright', { paths: [option('--playwright-root') || root] }));
const directory = path.join(root, '.runtime/benchmarks', `tool-recovery-${Date.now()}`);
const profile = path.join(directory, 'profile');
mkdirSync(path.join(profile, 'config'), { recursive: true });
let pendingResponse;
const bodies = [], errors = [], report = { directory, checks: [] };
const server = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw); bodies.push(body);
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const event = value => response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(value) + '\n' } }] }) + '\n\n');
  const finish = () => response.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  if (bodies.length === 1) {
    event({ type: 'speech', key: 'once', speech_ja: '一緒に見よう。', intent: 'explain' });
    event({ type: 'translation', key: 'once', display_zh: '一起看看吧。' });
    event({ type: 'task', kind: 'answer', status: 'complete', extra_field: 'invalid metadata' });
    finish();
  } else if (bodies.length === 2) {
    assert(!body.tools, 'Report repair cannot offer tools.');
    event({ type: 'task', kind: 'answer', status: 'complete' }); finish();
  } else {
    pendingResponse = response;
    response.write('data: {"choices":[{"delta":{},"finish_reason":null}]}\n\n');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
writeFileSync(path.join(profile, 'config/local.json'), JSON.stringify({ provider: 'openai', model: 'tool-recovery-fixture',
  base_url: `http://127.0.0.1:${server.address().port}`, voice: { voice_mode: 'silent' }, stt: { provider: 'disabled' },
  remember_user: false, send_screenshot: false, hotkey: 'Control+Alt+F6', cancel_hotkey: 'Control+Alt+F7',
  watch_hotkey: 'Control+Alt+F8', companion_ui: { frame_width: 760, frame_height: 620 } }));
let app, page;
async function waitUntil(predicate, description) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + description);
}
try {
  app = await _electron.launch({ executablePath: option('--packaged') || path.join(root, 'apps/desktop/node_modules/electron/dist/electron.exe'),
    args: [...(option('--packaged') ? [] : [path.join(root, 'apps/desktop')]), `--user-data-dir=${profile}`],
    env: { ...process.env, AYANA_DATA_DIR: profile, AYANA_REPOSITORY_ROOT: option('--packaged') ? '' : root,
      AYANA_PYTHON: option('--packaged') ? '' : path.join(root, '.venv/Scripts/python.exe'), AYANA_API_KEY: 'isolated-fixture-key' }, timeout: 45000 });
  page = (await app.windows()).find(p => p.url().includes('window=chat'));
  assert(page);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.hide()));
  page.on('pageerror', error => errors.push(error.message));
  await waitUntil(() => page.evaluate(async () => Boolean((await window.ayana?.getState())?.connected)), 'runtime connection');
  await page.evaluate(() => { window.__recoveryEvents = []; window.ayana.onEvent(e => window.__recoveryEvents.push(e)); });
  await page.evaluate(() => window.ayana.send({ type: 'turn.start', text: '检查任务报告恢复。' }));
  await waitUntil(() => page.evaluate(() => window.__recoveryEvents.some(e => e.type === 'task.updated' && e.task.state === 'succeeded')), 'report repair');
  const events = await page.evaluate(() => window.__recoveryEvents);
  assert.equal(events.filter(e => e.type === 'utterance.ready').length, 1);
  assert(!events.some(e => e.type === 'error'));
  report.checks.push('Malformed task metadata is repaired once; committed speech survives and is emitted once.');

  await page.evaluate(() => window.ayana.send({ type: 'turn.start', text: '等待中的搜索，可以停止。' }));
  await waitUntil(() => page.evaluate(() => window.__recoveryEvents.filter(e => e.type === 'user.message').length === 2), 'second question');
  const generation = await page.evaluate(async () => (await window.ayana.getState()).events.findLast(e => e.type === 'user.message').generation_id);
  const emit = values => app.evaluate(({ BrowserWindow }, values) => {
    const chat = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=chat'));
    values.forEach(e => chat.webContents.send('ayana:event', { protocol_version: 1, ...e }));
  }, values);
  await emit([{ type: 'tool.started', tool: 'web.search', call_id: 'search', generation_id: generation },
    { type: 'tool.progress', tool: 'web.search', call_id: 'search', generation_id: generation,
      stage: 'search_fallback', message: '搜索服务返回异常，正在换一种方式查找' }]);
  await page.locator('.waiting-detail').filter({ hasText: '换一种方式查找' }).waitFor();
  assert(await page.getByRole('button', { name: '停止', exact: true }).isVisible());
  await page.waitForTimeout(450); // Wait for the panel's arrival animation before visual inspection.
  await page.screenshot({ path: path.join(directory, 'search-progress.png'), omitBackground: true });
  report.checks.push('Rendered search fallback matches the call progress event and exposes a stop control.');
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await waitUntil(() => page.evaluate(() => window.__recoveryEvents.some(e => e.type === 'generation.cancelled' && e.reason === 'user')), 'runtime cancellation');
  await waitUntil(() => page.evaluate(() => !document.querySelector('.companion-waiting')), 'waiting cleared');
  report.checks.push('Stop reaches the real runtime, cancels the held model request and clears waiting.');
  assert.equal(errors.length, 0);
  report.errors = errors;
  writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.error = String(error);
  report.model_requests = bodies.length;
  if (page && !page.isClosed()) report.snapshot = await page.evaluate(() => window.ayana.getState()).catch(() => null);
  writeFileSync(path.join(directory, 'failure.json'), JSON.stringify(report, null, 2));
  throw error;
} finally {
  pendingResponse?.destroy();
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
