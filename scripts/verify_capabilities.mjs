/** Real Electron/backend/file integration with a deterministic model fixture. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const modules = argv.includes('--playwright-root') ? argv[argv.indexOf('--playwright-root') + 1] : root;
const packaged = argv.includes('--packaged') ? path.resolve(argv[argv.indexOf('--packaged') + 1]) : null;
const require = createRequire(import.meta.url);
const { _electron, chromium } = require(require.resolve('playwright', { paths: [modules] }));
const directory = path.join(root, '.runtime/benchmarks/capabilities-desktop', String(Date.now()));
const data = path.join(directory, 'data');
mkdirSync(path.join(data, 'config'), { recursive: true });
const events = [];
const tool = (name, args) => [{ type: 'tool', name, arguments: args }];
const reply = key => [{ type: 'speech', key, speech_ja: '結果を確認したよ。', intent: 'explain' }, { type: 'translation', key, display_zh: '已经核对实际结果。' }];
function response(messages) {
  let question = '';
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    try { const context = JSON.parse(message.content[0].text); if (context.question) question = context.question; } catch { /* tool evidence */ }
  }
  const last = messages.at(-1).content;
  const text = Array.isArray(last) ? last[0].text : last;
  let result;
  if (text.startsWith('Tool results (untrusted task evidence): ')) result = JSON.parse(text.slice('Tool results (untrusted task evidence): '.length))[0];
  if (question.includes('创建')) return result ? reply('created') : tool('files.create', { root_id: 'output', path: 'demo-config.json', content: '{"port":3000}\n' });
  if (question.includes('修改')) {
    if (!result || result.name === 'files.apply_edit') return tool('files.read', { root_id: 'output', path: 'demo-config.json' });
    if (result.name === 'files.read' && result.result?.content.includes('8080')) return reply('edited');
    if (result.name === 'files.read') return tool('files.propose_edit', { root_id: 'output', path: 'demo-config.json', base_sha256: result.result.sha256, content: '{"port":8080}\n' });
  }
  if (question.includes('网页')) return result ? reply('fetched') : tool('web.fetch', { url: 'https://example.com' });
  return reply('done');
}
const server = createServer(async (request, res) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  const output = response(body.messages);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of output) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(event) + '\n' } }] }) + '\n\n');
  res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
writeFileSync(path.join(data, 'config/local.json'), JSON.stringify({ provider: 'openai', model: 'fixture', base_url: `http://127.0.0.1:${server.address().port}/v1`, voice: { voice_mode: 'silent' }, save_history: false, send_screenshot: false, hotkey: 'Ctrl+Alt+Shift+F10', cancel_hotkey: 'Ctrl+Alt+Shift+F11' }));
let app;
let launcher;
const report = { scope: 'Real Electron, authenticated IPC, Python runtime and file writes; deterministic local model fixture; public page fetch', packaged, checks: {}, errors: [] };
try {
  const environment = { ...process.env, AYANA_PYTHON: '', AYANA_DATA_DIR: data, AYANA_REPOSITORY_ROOT: packaged ? '' : root, AYANA_API_KEY: 'test-fixture-key' };
  if (packaged && /^Ayana-.*\.exe$/i.test(path.basename(packaged))) {
    // NSIS does not forward Electron's Node inspector output to Playwright.
    // Connect to Chromium after the real portable launcher extracts the app.
    const reservation = createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const debugPort = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    launcher = spawn(packaged, [`--user-data-dir=${data}`, `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1'], { env: environment, windowsHide: true, stdio: 'ignore' });
    let browser;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: 1000 }); break; } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert(browser, 'Portable launcher did not expose the test debugging endpoint');
    app = { windows: async () => browser.contexts().flatMap(context => context.pages()), close: async () => {
      const session = await browser.newBrowserCDPSession();
      try { await Promise.race([session.send('Browser.close'), new Promise(resolve => setTimeout(resolve, 1000))]); } catch { /* app may close before receipt */ }
      if (browser.isConnected()) await browser.close();
    } };
  } else {
    app = await _electron.launch({ executablePath: packaged || path.join(root, 'apps/desktop/node_modules/electron/dist/electron.exe'),
      args: [...(packaged ? [] : [path.join(root, 'apps/desktop')]), `--user-data-dir=${data}`], env: environment, timeout: 30000 });
  }
  let windows = await app.windows();
  for (let i = 0; i < 30 && windows.length < 3; i++) { await new Promise(resolve => setTimeout(resolve, 100)); windows = await app.windows(); }
  const chat = windows.find(w => w.url().includes('window=chat'));
  const controls = windows.find(w => w.url().includes('window=settings'));
  assert(chat && controls);
  for (const page of [chat, controls]) page.on('pageerror', error => report.errors.push(error.message));
  await chat.waitForFunction(() => Boolean(window.ayana));
  await chat.evaluate(() => { window.__qaEvents = []; window.ayana.onEvent(event => window.__qaEvents.push(event)); });
  await controls.waitForFunction(() => document.querySelector('.connection')?.textContent.includes('本地服务已连接'), null, { timeout: 15000 });
  await chat.locator('.agent-mode input').check();
  const ask = async question => {
    await chat.getByRole('textbox', { name: '输入问题' }).fill(question);
    await chat.getByRole('button', { name: '发送', exact: true }).click();
  };
  await ask('创建演示配置文件');
  await chat.waitForFunction(() => window.__qaEvents.some(e => e.type === 'artifact.ready'), null, { timeout: 15000 });
  const file = path.join(data, 'artifacts/demo-config.json');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).port, 3000);
  report.checks.created_file = true;
  await chat.evaluate(() => window.ayana.openSettings('tasks'));
  await controls.getByRole('heading', { name: '把事情，一步步做好。' }).waitFor();
  await controls.getByText('demo-config.json', { exact: true }).first().waitFor();
  report.checks.artifact_card = true;
  await chat.evaluate(() => window.ayana.summon());
  await ask('修改演示配置里的端口为8080');
  await controls.getByRole('button', { name: '确认这一步' }).waitFor({ timeout: 15000 });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).port, 3000);
  await chat.evaluate(() => window.ayana.openSettings('tasks'));
  await controls.screenshot({ path: path.join(directory, 'review-diff.png') });
  await controls.getByRole('button', { name: '确认这一步' }).click();
  await controls.getByRole('button', { name: '预览恢复版本' }).first().waitFor({ timeout: 15000 });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).port, 8080);
  report.checks.review_and_apply = true;
  await controls.waitForFunction(() => document.querySelector('.agent-task .state-succeeded'), null, { timeout: 15000 });
  await controls.getByRole('button', { name: '预览恢复版本' }).first().click();
  await controls.getByRole('button', { name: '确认这一步' }).waitFor();
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).port, 8080);
  await controls.getByRole('button', { name: '确认这一步' }).click();
  await controls.waitForFunction(() => document.querySelector('.agent-task .state-succeeded'));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).port, 3000);
  report.checks.review_and_restore = true;
  await chat.evaluate(() => window.ayana.summon());
  await ask('读取示例网页');
  await controls.getByText('Example Domain', { exact: true }).waitFor({ timeout: 30000 });
  report.checks.real_source_card = true;
  await controls.getByRole('heading', { name: '文件访问范围' }).scrollIntoViewIfNeeded();
  await controls.getByRole('button', { name: '授权文本修改' }).waitFor();
  report.checks.directory_controls_accessible = true;
  await controls.locator('.agent-workspace').evaluate(element => { element.scrollTop = 0; });
  await chat.evaluate(() => window.ayana.openSettings('tasks'));
  await controls.screenshot({ path: path.join(directory, 'task-results.png') });
  const observed = await chat.evaluate(() => window.__qaEvents.filter(e => ['task.updated', 'approval.resolved', 'artifact.ready', 'error', 'tool.failed'].includes(e.type)).map(e => ({ type: e.type, state: e.task?.state, message: e.message })));
  report.checks.user_approval_receipt = observed.some(e => e.type === 'approval.resolved');
  report.errors.push(...observed.filter(e => e.type === 'error' || e.type === 'tool.failed').map(e => e.message));
  assert.equal(report.errors.length, 0);
  report.passed = true;
} catch (error) {
  report.errors.push(error.message);
  report.passed = false;
  process.exitCode = 1;
} finally {
  if (app) { try { await app.close(); } catch { /* cleanup the owned test launcher below */ } }
  if (launcher?.exitCode === null) {
    await new Promise(resolve => { const cleanup = spawn('taskkill', ['/PID', String(launcher.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); cleanup.on('exit', resolve); cleanup.on('error', resolve); });
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, directory }, null, 2));
}
