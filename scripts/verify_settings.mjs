/** Isolated Electron settings regression. No model requests or desktop input. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const require = createRequire(import.meta.url);
const { _electron } = require(require.resolve('playwright', { paths: [option('--playwright-root') || root] }));
const directory = path.join(root, '.runtime', 'benchmarks', `settings-${Date.now()}`);
const data = path.join(directory, 'profile');
mkdirSync(path.join(data, 'config'), { recursive: true });
const config = { provider: 'local', voice: { voice_mode: 'silent', engine_root: 'preserved-engine-path' },
  stt: { provider: 'disabled', model: 'tiny', model_path: 'preserved-model-path' },
  hotkey: 'Control+Alt+F8', cancel_hotkey: 'Control+Alt+F9', save_history: true };
writeFileSync(path.join(data, 'config', 'local.json'), JSON.stringify(config));
const report = { scope: 'Real Electron + local backend; isolated profile, silent voice; no network model calls or desktop actions', checks: [], errors: [] };
let app;
let page;
try {
  app = await _electron.launch({ executablePath: path.join(root, 'apps/desktop/node_modules/electron/dist/electron.exe'),
    args: [path.join(root, 'apps/desktop'), `--user-data-dir=${data}`],
    env: { ...process.env, AYANA_DATA_DIR: data, AYANA_REPOSITORY_ROOT: root, AYANA_PYTHON: path.join(root, '.venv/Scripts/python.exe') }, timeout: 30000 });
  const pages = await app.windows();
  page = pages.find(item => item.url().includes('window=settings'));
  assert(page, 'settings window exists');
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => window.ayana.getState().then(state => state.connected), null, { timeout: 30000 });
  await page.evaluate(() => window.ayana.openSettings());
  const go = name => page.getByRole('button', { name, exact: true }).click();
  const save = async () => {
    await go('保存设置');
    await page.getByRole('status').filter({ hasText: /^已保存$/ }).waitFor();
    assert.equal(await page.getByRole('button', { name: '保存设置', exact: true }).isEnabled(), false);
  };
  const disk = () => JSON.parse(readFileSync(path.join(data, 'config', 'local.json'), 'utf8'));
  await page.getByRole('checkbox', { name: '表情切换动效', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.settings-fields').disabled);
  assert.equal(await page.locator('.settings-navigation').count(), 0);
  assert.equal(await page.getByRole('button', { name: '仓库文件', exact: true }).count(), 0);
  assert.equal(await page.locator('#repository-root').count(), 0);
  assert.equal(await page.getByRole('button', { name: '高级设置', exact: true }).count(), 1);
  report.checks.push('single navigation; repository and redundant settings navigation removed');
  await page.getByRole('checkbox', { name: '表情切换动效', exact: true }).uncheck();
  await go('高级设置');
  assert.equal(await page.locator('.preference-advanced[open]').count(), 0);
  await page.getByText('回复限制', { exact: true }).click();
  await page.getByLabel('最多工具轮数', { exact: true }).fill('7');
  await go('外观与声音');
  assert.equal(await page.getByRole('checkbox', { name: '表情切换动效', exact: true }).isChecked(), false);
  await save();
  assert.equal(disk().voice.engine_root, 'preserved-engine-path');
  assert.equal(disk().stt.model_path, 'preserved-model-path');
  assert.equal(disk().stt.provider, 'disabled');
  assert.equal(disk().max_tool_rounds, 7);
  assert.equal(disk().sentence_motion, false);
  await page.screenshot({ path: path.join(directory, 'appearance.png') });
  report.checks.push('draft survives navigation; backend receipt confirms partial updates preserve resource paths');
  await go('高级设置');
  await page.getByText('接口兼容与代理', { exact: true }).click();
  await page.getByLabel('Brave 本机 HTTP 代理', { exact: true }).fill('http://127.0.0.1');
  await go('保存设置');
  await page.getByRole('status').filter({ hasText: '代理需使用' }).waitFor();
  assert.equal(await page.locator('.error-banner').count(), 0);
  assert.equal(await page.getByLabel('Brave 本机 HTTP 代理', { exact: true }).inputValue(), 'http://127.0.0.1');
  assert.equal(disk().search_proxy, '');
  await go('撤销修改');
  report.checks.push('invalid proxy retains draft and leaves persisted settings intact');
  await go('外观与声音');
  await page.getByRole('checkbox', { name: '表情切换动效', exact: true }).check();
  await page.evaluate(() => window.ayana.send({ type: 'settings.update', settings: { volume: .65 }, request_id: 'other-window' }));
  await page.waitForFunction(() => document.querySelector('.settings-form')?.textContent.includes('65%'));
  assert.equal(await page.getByRole('checkbox', { name: '表情切换动效', exact: true }).isChecked(), true);
  await save();
  assert.equal(disk().volume, .65);
  report.checks.push('external settings refresh merges untouched fields and preserves edited fields');
  await go('模型与连接');
  await page.getByLabel('模型模式', { exact: true }).selectOption('openai');
  await page.getByLabel('模型名称', { exact: true }).fill('settings-test-model');
  await save();
  await page.screenshot({ path: path.join(directory, 'model.png') });
  await go('高级设置');
  await page.getByText('回复限制', { exact: true }).click();
  await page.getByLabel('单次请求输出上限（tokens）', { exact: true }).fill('4000');
  await save();
  assert.equal(disk().model_max_tokens, 4000);
  await page.evaluate(() => window.ayana.send({ type: 'settings.get' }));
  await page.waitForFunction(() => window.ayana.getState().then(state => state.events.some(event => event.type === 'settings.ready' && event.settings.model_max_tokens === 4000)));
  assert.equal(await page.getByLabel('单次请求输出上限（tokens）', { exact: true }).inputValue(), '4000');
  report.checks.push('advanced output limit persists and survives settings refresh without a model request');
  await go('观察与隐私');
  await page.getByRole('checkbox', { name: /^允许彩名偶尔偷看/ }).waitFor();
  await page.screenshot({ path: path.join(directory, 'privacy.png') });
  report.checks.push('privacy observation toggles use the common save flow');
  await go('对话与记忆');
  await page.screenshot({ path: path.join(directory, 'history.png') });
  await go('高级设置');
  await page.screenshot({ path: path.join(directory, 'advanced.png') });
  await page.getByText('服务与诊断', { exact: true }).click();
  await go('刷新状态');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('window=settings')).setSize(820, 600));
  await go('外观与声音');
  await page.mouse.move(10, 10);
  assert(await page.evaluate(() => document.querySelector('.workshop').scrollWidth <= innerWidth));
  assert(await page.evaluate(() => { const button = document.querySelector('button[type=submit]').getBoundingClientRect(); return button.bottom <= innerHeight && button.top >= 0; }));
  await page.screenshot({ path: path.join(directory, 'compact.png') });
  report.checks.push('820px window has no horizontal overflow and keeps save controls visible');
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = String(error); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
}
finally {
  if (app) await app.close();
  writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, directory }, null, 2));
}
