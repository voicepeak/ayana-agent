/** Real Electron/backend checks in an isolated profile; no personal API calls.
 * --packaged points to release/win-unpacked/Ayana.exe. Test the NSIS wrapper
 * separately with verify_portable_demo.mjs --cleanup-only --isolated-companion.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
if (option('--packaged') && path.basename(option('--packaged')) !== 'Ayana.exe')
  throw new Error('--packaged 需指向 win-unpacked/Ayana.exe；NSIS 便携启动器使用 verify_portable_demo.mjs 验证。');
const require = createRequire(import.meta.url);
const { _electron } = require(require.resolve('playwright', { paths: [option('--playwright-root') || root] }));
const directory = path.join(root, '.runtime/benchmarks', `conversation-manager-${Date.now()}`);
const profile = path.join(directory, 'profile');
mkdirSync(path.join(profile, 'config'), { recursive: true });
const calls = [];
const server = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw); calls.push(body);
  if (!body.stream) {
    const isMemory = body.messages[0].content.startsWith('Extract only');
    const source = isMemory && JSON.parse(body.messages.at(-1).content).messages.find(item => item.text === '我喜欢红茶，平常不喝咖啡。');
    const result = isMemory ? JSON.stringify({ memories: source ? [{ key: 'beverage', content: '用户喜欢红茶，平常不喝咖啡', source_id: source.id, quote: source.text }] : [] }) : '已经讨论界面布局，继续保留原始记录。';
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: result } }] })); return;
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of [{ type: 'speech', key: 's1', speech_ja: '覚えているよ。', intent: 'acknowledge' },
    { type: 'translation', key: 's1', display_zh: '记得，我们继续聊。' }])
    response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(event) + '\n' } }] }) + '\n\n');
  response.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
writeFileSync(path.join(profile, 'config/local.json'), JSON.stringify({ provider: 'openai', model: 'memory-fixture',
  base_url: `http://127.0.0.1:${server.address().port}`, voice: { voice_mode: 'silent' }, stt: { provider: 'disabled' },
  save_history: true, remember_user: true, send_screenshot: false, native_tools: false,
  hotkey: 'Control+Alt+F6', cancel_hotkey: 'Control+Alt+F7', watch_hotkey: 'Control+Alt+F8' }));
let app, chat, settings;
const errors = [], report = { directory, checks: [] };
try {
  app = await _electron.launch({ executablePath: option('--packaged') || path.join(root, 'apps/desktop/node_modules/electron/dist/electron.exe'),
    args: [...(option('--packaged') ? [] : [path.join(root, 'apps/desktop')]), `--user-data-dir=${profile}`],
    env: { ...process.env, AYANA_DATA_DIR: profile, AYANA_REPOSITORY_ROOT: option('--packaged') ? '' : root,
      AYANA_PYTHON: option('--packaged') ? '' : path.join(root, '.venv/Scripts/python.exe'), AYANA_API_KEY: 'manager-test-key' }, timeout: option('--packaged') ? 90000 : 30000 });
  await app.firstWindow();
  const pages = await app.windows();
  chat = pages.find(page => page.url().includes('window=chat'));
  settings = pages.find(page => page.url().includes('window=settings'));
  assert(chat && settings);
  pages.forEach(page => page.on('pageerror', error => errors.push(error.message)));
  await settings.waitForSelector('.connection.online', { timeout: 30000 });
  await chat.waitForFunction(async () => {
    const state = await window.ayana.getState();
    return state.connected && state.events.some(e => e.type === 'memory.ready');
  }, null, { timeout: 30000 });
  await chat.evaluate(() => { window.__managerEvents = []; window.ayana.onEvent(event => window.__managerEvents.push(event)); });
  // Keep the OS file browser out of automated tests; the normal UI command still writes a real export.
  await app.evaluate(({ shell }) => { shell.showItemInFolder = file => { globalThis.__exported = file; }; });
  const current = () => chat.evaluate(async () => (await window.ayana.getState()).events.findLast(e => ['conversation.changed', 'conversations.ready'].includes(e.type)).current.conversation_id);
  async function ask(text) {
    const result = await chat.evaluate(text => window.ayana.send({ type: 'turn.start', text }), text);
    assert(result.ok, result.error);
    await chat.waitForFunction(text => {
      const user = window.__managerEvents.findLast(e => e.type === 'user.message' && e.text === text);
      return user && window.__managerEvents.some(e => e.type === 'task.state' && e.generation_id === user.generation_id && e.state === 'idle');
    }, text, { timeout: 15000 });
  }
  for (const text of ['我喜欢红茶，平常不喝咖啡。', '今天去公园走了走', '回来后有点累', '明天再去看看']) await ask(text);
  const old = await current();
  await chat.waitForFunction(() => window.__managerEvents.some(e => e.type === 'memory.ready' && e.memories.length === 1));
  await chat.evaluate(() => window.ayana.openSettings('history'));
  await settings.waitForSelector('.conversation-manager');
  await settings.waitForSelector('.manager-message.from-user');
  await settings.screenshot({ path: path.join(directory, 'records.png') });
  report.checks.push('A normal conversation automatically learns a quoted personal memory; detailed management remains available.');
  execFileSync(path.join(root, '.venv/Scripts/python.exe'), ['-c', `from pathlib import Path
from services.agent.storage import ConversationStore
import sys
s=ConversationStore(Path(sys.argv[1]))
for i in range(135):
 s.commit(dict(type='user.message',conversation_id=sys.argv[2],text='早期定位针叶林' if i==0 else '历史内容 '+str(i)))
s.close()`, path.join(profile, '.runtime/history.sqlite3'), old], { cwd: root, windowsHide: true });
  await settings.getByRole('button', { name: '开始新的对话' }).click();
  await settings.waitForFunction(() => document.querySelector('.manager-reader-heading h3')?.textContent === '新话题');
  const newer = await current(); assert.notEqual(newer, old);
  await ask('这是另一段对话，今天想看电影。');
  assert(JSON.stringify(calls.at(-1).messages).includes('用户喜欢红茶'));
  assert(!JSON.stringify(calls.at(-1).messages).includes('今天去公园走了走'));
  await settings.getByRole('textbox', { name: '搜索对话内容' }).fill('早期定位针叶林');
  await settings.getByRole('button', { name: '搜索', exact: true }).click();
  await settings.locator('.manager-search-hit').click();
  await settings.waitForFunction(() => document.querySelector('.manager-message.is-found')?.textContent.includes('早期定位针叶林'));
  assert.equal(await current(), newer);
  report.checks.push('Search locates an old message across conversations without changing the live conversation.');
  await settings.getByRole('button', { name: '清除', exact: true }).click();
  await settings.getByRole('button', { name: '回到最近记录' }).click();
  await settings.waitForFunction(() => document.querySelectorAll('.manager-message').length === 100);
  await settings.getByRole('button', { name: '更早的记录' }).click();
  await settings.waitForFunction(() => document.querySelectorAll('.manager-message').length === 143);
  await settings.locator('.manager-record-actions > details > summary').click();
  await settings.getByRole('textbox', { name: '对话名称' }).fill('茶与散步');
  await settings.getByRole('button', { name: '改名', exact: true }).click();
  await settings.waitForFunction(() => document.querySelector('.manager-reader-heading h3')?.textContent === '茶与散步');
  assert.equal(await current(), newer);
  await settings.getByRole('button', { name: '导出 JSON' }).click();
  await settings.waitForSelector('.manager-export');
  const exported = await app.evaluate(() => globalThis.__exported);
  const content = JSON.parse(readFileSync(exported, 'utf8'));
  assert.equal(content.messages.length, 143); assert.equal(content.title, '茶与散步');
  report.checks.push('Pagination, renaming inactive records and complete UTF-8 JSON exports work through the native UI.');
  await settings.getByRole('tab', { name: /彩名记住的事/ }).click();
  await settings.waitForSelector('.memory-entry');
  await settings.locator('.memory-entry details summary').click();
  assert((await settings.locator('.memory-entry blockquote').textContent()).includes('我喜欢红茶'));
  await settings.getByRole('button', { name: '修改', exact: true }).click();
  await settings.getByRole('textbox', { name: '修改记忆' }).fill('用户喜欢红茶，现在偶尔也喝咖啡');
  await settings.getByRole('button', { name: '保存记忆' }).click();
  await settings.waitForFunction(() => document.querySelector('.memory-entry > p')?.textContent === '用户喜欢红茶，现在偶尔也喝咖啡');
  await settings.screenshot({ path: path.join(directory, 'memories.png') });
  await settings.evaluate(() => window.ayana.restart());
  await settings.waitForFunction(() => document.querySelector('.connection')?.textContent.includes('本地服务已连接'), null, { timeout: 30000 });
  await settings.waitForFunction(() => document.querySelector('.memory-entry > p')?.textContent === '用户喜欢红茶，现在偶尔也喝咖啡');
  await settings.locator('.memory-entry details summary').click();
  await settings.getByRole('button', { name: '查看这句话' }).click();
  await settings.waitForFunction(() => document.querySelector('.manager-message.is-found')?.textContent.includes('我喜欢红茶'));
  report.checks.push('User edits and original citations survive backend restart and link back to the source message.');
  await settings.getByRole('tab', { name: /彩名记住的事/ }).click();
  await settings.getByRole('button', { name: '忘记', exact: true }).click();
  await settings.getByRole('button', { name: '确认忘记', exact: true }).click();
  await settings.waitForSelector('.memory-empty');
  await settings.getByRole('tab', { name: /对话记录/ }).click();
  assert((await settings.locator('.manager-transcript').textContent()).includes('我喜欢红茶'));
  report.checks.push('Forgetting a memory removes it after the backend receipt and preserves its original conversation.');
  await settings.getByRole('button', { name: /接着聊/ }).click();
  await chat.waitForFunction(cid => window.__managerEvents.some(e => e.type === 'conversation.changed' && e.current.conversation_id === cid), old);
  assert.equal(await current(), old);
  await settings.getByRole('button', { name: '删除', exact: true }).click();
  await settings.getByRole('button', { name: '确认删除', exact: true }).click();
  await settings.waitForFunction(() => document.querySelector('.manager-reader-heading h3')?.textContent === '这是另一段对话，今天想看电影。');
  assert.equal(await current(), newer);
  await settings.getByRole('tab', { name: /彩名记住的事/ }).click();
  await settings.waitForSelector('.memory-empty');
  assert.equal(JSON.parse(readFileSync(exported, 'utf8')).messages.length, 143);
  report.checks.push('Resume restores the intended chat; deleting it preserves the other conversation and exported files.');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=settings')).setSize(880, 680));
  await settings.getByRole('tab', { name: /对话记录/ }).click();
  assert(await settings.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await settings.screenshot({ path: path.join(directory, 'compact-manager.png') });
  assert.equal(errors.length, 0, errors.join('\n'));
  report.checks.push('Compact layout fits the native window; no renderer errors.');
  writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (settings) await settings.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
  writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ error: String(error), errors, checks: report.checks }, null, 2));
  throw error;
} finally {
  if (app) await app.close();
  await new Promise(resolve => server.close(resolve));
}
