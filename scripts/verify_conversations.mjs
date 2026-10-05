/** Real Electron/backend topic switching, compression, restart and layout checks. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const require = createRequire(import.meta.url);
const { _electron } = require(require.resolve('playwright', { paths: [option('--playwright-root') || root] }));
const directory = path.join(root, '.runtime/benchmarks/conversations', String(Date.now()));
const profile = path.join(directory, 'profile');
mkdirSync(path.join(profile, 'config'), { recursive: true });
const calls = [];
const server = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  calls.push(body);
  if (!body.stream) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: '目标：为 Ayana 制作话题管理。已确定小窗口用于切换话题，大窗口展示记录；材料可独立解除绑定。还需检查窗口布局。' } }] }));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const events = [{ type: 'speech', key: 's1', speech_ja: '覚えているよ。', intent: 'acknowledge' },
                  { type: 'translation', key: 's1', display_zh: '记得，我们继续聊。' }];
  for (const event of events) response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(event) + '\n' } }] }) + '\n\n');
  response.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
writeFileSync(path.join(profile, 'config/local.json'), JSON.stringify({
  provider: 'openai', model: 'conversation-fixture', base_url: `http://127.0.0.1:${server.address().port}`,
  voice: { voice_mode: 'silent' }, save_history: true, send_screenshot: false, native_tools: false,
}));
let app;
const errors = [];
const report = { checks: {}, directory };
try {
  app = await _electron.launch({
    executablePath: option('--packaged') || path.join(root, 'apps/desktop/node_modules/electron/dist/electron.exe'),
    args: [...(option('--packaged') ? [] : [path.join(root, 'apps/desktop')]), `--user-data-dir=${profile}`],
    env: { ...process.env, AYANA_DATA_DIR: profile, AYANA_REPOSITORY_ROOT: option('--packaged') ? '' : root,
      AYANA_PYTHON: option('--packaged') ? '' : path.join(root, '.venv/Scripts/python.exe'), AYANA_API_KEY: 'conversation-test-key' },
    timeout: 30000,
  });
  await app.firstWindow();
  const pages = await app.windows();
  const chat = pages.find(page => page.url().includes('window=chat'));
  const settings = pages.find(page => page.url().includes('window=settings'));
  assert(chat && settings);
  for (const page of pages) page.on('pageerror', error => errors.push(error.message));
  await chat.waitForSelector('.topic-trigger:not(:disabled)', { timeout: 30000 });
  await chat.evaluate(() => { window.__topicEvents = []; window.ayana.onEvent(event => window.__topicEvents.push(event)); });
  await chat.evaluate(() => window.ayana.send({ type: 'conversation.materials.clear' }));
  async function ask(text, useComposer = false) {
    if (useComposer) { await chat.getByRole('textbox', { name: '输入问题' }).fill(text); await chat.getByRole('button', { name: '发送', exact: true }).click(); }
    else {
      const result = await chat.evaluate(text => window.ayana.send({ type: 'turn.start', text }), text);
      assert(result.ok, result.error);
    }
    await chat.waitForFunction(text => {
      const user = window.__topicEvents.findLast(event => event.type === 'user.message' && event.text === text);
      return user && window.__topicEvents.some(event => event.type === 'task.state' && event.generation_id === user.generation_id && event.state === 'idle');
    }, text, { timeout: 15000 });
  }
  await ask('讨论小窗口的上下文管理', true);
  await chat.locator('.topic-trigger').click();
  await chat.waitForSelector('.topic-picker');
  await chat.screenshot({ path: path.join(directory, 'topic-picker.png') });
  await chat.getByRole('button', { name: '新建话题', exact: true }).click();
  await chat.waitForFunction(() => document.querySelector('.topic-trigger strong')?.textContent === '新话题');
  await ask('今天晚饭吃什么', true);
  assert(!JSON.stringify(calls.at(-1).messages).includes('讨论小窗口的上下文管理'));
  await chat.locator('.topic-trigger').click();
  await chat.locator('.topic-recent button').filter({ hasText: '讨论小窗口的上下文管理' }).click();
  await chat.waitForFunction(() => document.querySelector('.topic-trigger strong')?.textContent === '讨论小窗口的上下文管理');
  await chat.locator('.topic-trigger').click();
  await chat.getByRole('button', { name: '全部话题与记录' }).click();
  await settings.waitForSelector('.conversation-workspace');
  await settings.waitForFunction(() => document.querySelector('.conversation-transcript')?.textContent.includes('讨论小窗口的上下文管理'));
  assert(!(await settings.locator('.conversation-transcript').textContent()).includes('今天晚饭吃什么'));
  assert(await settings.locator('.conversation-message.from-user').count() > 0);
  assert(await settings.locator('.conversation-message.from-ayana').count() > 0);
  await settings.getByRole('textbox', { name: '当前话题名称' }).fill('Ayana 话题管理');
  await settings.getByRole('button', { name: '保存名称' }).click();
  await chat.waitForFunction(() => document.querySelector('.topic-trigger strong')?.textContent === 'Ayana 话题管理');
  report.checks.switch_isolates_context_and_records = true;
  report.checks.rename_syncs_both_windows = true;
  for (let i = 0; i < 14; i++) await ask(`第${i}轮布局需求：` + '保留立绘和中文翻译，支持最近话题切换，详细记录放在管理窗口。'.repeat(115));
  assert(calls.some(call => !call.stream));
  await settings.waitForFunction(() => document.querySelector('.conversation-summary')?.textContent.includes('目标：为 Ayana'));
  await settings.screenshot({ path: path.join(directory, 'history.png') });
  report.checks.automatic_summary_visible = true;
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=chat')); window.setSize(420, 700); });
  await chat.locator('.topic-trigger').click();
  await chat.waitForSelector('.topic-picker');
  assert(await chat.evaluate(() => { const r = document.querySelector('.gal-dialogue').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && r.top >= 0; }));
  await chat.screenshot({ path: path.join(directory, 'small-window.png') });
  report.checks.minimum_width_fits = true;
  const state = await chat.evaluate(() => window.ayana.getState());
  const current = state.events.findLast(event => event.type === 'conversations.ready' || event.type === 'conversation.changed').current.conversation_id;
  await settings.evaluate(() => { window.__restart = false; window.ayana.onEvent(event => { if (event.type === 'desktop.reset') window.__restart = true; }); return window.ayana.restart(); });
  await settings.waitForFunction(() => window.__restart, null, { timeout: 20000 });
  await chat.waitForFunction(cid => {
    const reset = window.__topicEvents.findLastIndex(event => event.type === 'desktop.reset');
    return reset >= 0 && window.__topicEvents.slice(reset).some(event => event.type === 'conversations.ready'
      && event.current.conversation_id === cid && event.summary.includes('目标：为 Ayana'));
  }, current, { timeout: 20000 });
  assert((await chat.evaluate(() => window.ayana.getState())).connected);
  report.checks.restart_restores_topic_summary_and_records = true;
  await ask('重启后继续这个话题');
  assert(JSON.stringify(calls.at(-1).messages).includes('目标：为 Ayana'));
  assert.equal(errors.length, 0, errors.join('\n'));
  report.checks.no_renderer_errors = true;
  writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (app) {
    for (const [i, page] of (await app.windows()).entries()) {
      const events = await page.evaluate(() => window.__topicEvents?.slice(-25).map(({ type, state, reason, message, generation_id }) => ({ type, state, reason, message, generation_id }))).catch(() => null);
      writeFileSync(path.join(directory, `failure-${i}.json`), JSON.stringify({ error: String(error), events }, null, 2));
    }
  }
  throw error;
} finally {
  if (app) await app.close();
  await new Promise(resolve => server.close(resolve));
}
