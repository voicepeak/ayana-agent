/** Verify the access switch through Electron, native model calls and real commands. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const require = createRequire(import.meta.url);
const { _electron } = require(require.resolve('playwright', { paths: [option('--playwright-root') || root] }));
const directory = path.join(root, '.runtime/benchmarks/full-access', String(Date.now()));
const profile = path.join(directory, 'profile');
mkdirSync(path.join(profile, 'config'), { recursive: true });
const calls = [];
const errors = [];
const command = "[IO.File]::WriteAllText('real-command.txt', 'done'); Write-Output 'Full access executed'";
const server = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  calls.push(body);
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = delta => response.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
  if (body.tools?.some(tool => tool.function.name === 'shell__run') && !body.messages.some(message => message.role === 'tool')) {
    send({ tool_calls: [{ index: 0, id: 'real-command', type: 'function', function: {
      name: 'shell__run', arguments: JSON.stringify({ command, cwd: directory }),
    } }] });
    response.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + '\n\n');
  } else {
    for (const event of [
      { type: 'speech', key: 's1', speech_ja: 'できたよ。', expression: '正经', pose: 'crossed' },
      { type: 'translation', key: 's1', display_zh: '任务已完成。' },
    ]) send({ content: JSON.stringify(event) + '\n' });
    response.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
  }
  response.end('data: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
writeFileSync(path.join(profile, 'config/local.json'), JSON.stringify({
  provider: 'openai', model: 'access-fixture', base_url: `http://127.0.0.1:${server.address().port}`,
  voice: { voice_mode: 'silent' }, send_screenshot: false, native_tools: true, full_access: false,
}));
let app;
const report = { checks: {}, directory };
try {
  app = await _electron.launch({
    executablePath: option('--packaged') || path.join(root, 'apps/desktop/node_modules/electron/dist/electron.exe'),
    args: [...(option('--packaged') ? [] : [path.join(root, 'apps/desktop')]), `--user-data-dir=${profile}`],
    env: { ...process.env, AYANA_DATA_DIR: profile, AYANA_REPOSITORY_ROOT: option('--packaged') ? '' : root,
      AYANA_PYTHON: option('--packaged') ? '' : path.join(root, '.venv/Scripts/python.exe'), AYANA_API_KEY: 'fixture-key' },
    timeout: 30000,
  });
  await app.firstWindow();
  const pages = await app.windows();
  const chat = pages.find(page => page.url().includes('window=chat'));
  const settings = pages.find(page => page.url().includes('window=settings'));
  assert(chat && settings);
  for (const page of pages) page.on('pageerror', error => errors.push(error.message));
  await chat.waitForSelector('.topic-trigger:not(:disabled)', { timeout: 30000 });
  await chat.evaluate(() => window.ayana.openSettings('tasks'));
  const access = settings.getByRole('switch', { name: /Full access/ });
  await access.waitFor();
  await settings.waitForFunction(() => !document.querySelector('.full-access-switch').disabled);
  assert.equal(await access.getAttribute('aria-checked'), 'false');
  await access.click();
  await settings.waitForFunction(() => document.querySelector('.full-access-switch').getAttribute('aria-checked') === 'true');
  assert.equal(JSON.parse(readFileSync(path.join(profile, 'config/local.json'), 'utf8')).full_access, true);
  await chat.evaluate(() => { window.__accessEvents = []; window.ayana.onEvent(event => window.__accessEvents.push(event)); });
  const sendResult = await chat.evaluate(() => window.ayana.send({ type: 'turn.start', text: '执行命令写入文件', mode: 'teach' }));
  assert(sendResult.ok);
  await chat.waitForFunction(() => window.__accessEvents.some(event => event.type === 'tool.completed' && event.tool === 'shell.run'), null, { timeout: 20000 });
  await settings.locator('.agent-shell-results pre').filter({ hasText: 'Full access executed' }).waitFor();
  assert.equal(readFileSync(path.join(directory, 'real-command.txt'), 'utf8'), 'done');
  assert(calls.some(call => call.messages.some(message => message.role === 'tool' && message.content.includes('Full access executed'))));
  assert(!await chat.evaluate(() => window.__accessEvents.some(event => event.type === 'approval.required')));
  await settings.screenshot({ path: path.join(directory, 'full-access-on.png') });
  await settings.locator('.agent-shell-results').scrollIntoViewIfNeeded();
  await settings.screenshot({ path: path.join(directory, 'command-result.png') });
  await access.scrollIntoViewIfNeeded();
  report.checks.switch_and_real_command_receipt = true;
  await settings.evaluate(() => { window.__restarted = false; window.ayana.onEvent(event => { if (event.type === 'desktop.reset') window.__restarted = true; }); return window.ayana.restart(); });
  await settings.waitForFunction(() => window.__restarted && !document.querySelector('.full-access-switch')?.disabled, null, { timeout: 20000 });
  assert.equal(await access.getAttribute('aria-checked'), 'true');
  report.checks.restart_preserves_access_setting = true;
  await access.click();
  await settings.waitForFunction(() => document.querySelector('.full-access-switch').getAttribute('aria-checked') === 'false');
  const oldCalls = calls.length;
  await chat.evaluate(() => window.ayana.send({ type: 'turn.start', text: '读取信息', mode: 'teach' }));
  await chat.waitForFunction(() => window.__accessEvents.some(event => event.type === 'user.message' && event.text === '读取信息'));
  for (let attempt = 0; attempt < 100 && calls.length === oldCalls; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert(calls.length > oldCalls);
  assert(!calls.at(-1).tools?.some(tool => ['shell__run', 'desktop__step', 'files__create'].includes(tool.function.name)));
  assert.equal(JSON.parse(readFileSync(path.join(profile, 'config/local.json'), 'utf8')).full_access, false);
  await settings.screenshot({ path: path.join(directory, 'full-access-off.png') });
  report.checks.disable_revokes_model_tools = true;
  assert.equal(errors.length, 0, errors.join('\n'));
  report.checks.no_renderer_errors = true;
  writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (app) for (const [index, page] of (await app.windows()).entries()) await page.screenshot({ path: path.join(directory, `failure-${index}.png`) }).catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
