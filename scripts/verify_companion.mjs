/** Verify the actual Electron companion, with an isolated local text-only profile. */
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
const directory = path.join(root, '.runtime/benchmarks/companion');
const profile = option('--profile-dir') || path.join(directory, 'profile');
const realVoice = args.includes('--real-voice');
const voice = realVoice ? JSON.parse(readFileSync(path.join(root, 'config/local.json'), 'utf8')).voice : { voice_mode: 'silent' };
mkdirSync(path.join(profile, 'config'), { recursive: true });
writeFileSync(path.join(profile, 'config/local.json'), JSON.stringify({ provider: 'local', voice, send_screenshot: false }));
const application = await _electron.launch({
  executablePath: option('--packaged') || path.join(root, 'apps/desktop/node_modules/electron/dist/electron.exe'),
  args: [...(option('--packaged') ? [] : [path.join(root, 'apps/desktop')]), `--user-data-dir=${profile}`],
  env: { ...process.env, AYANA_DATA_DIR: profile, AYANA_REPOSITORY_ROOT: option('--packaged') ? '' : root, AYANA_PYTHON: '' },
});
const errors = [];
try {
  await application.firstWindow();
  const pages = await application.windows();
  const chat = pages.find(page => page.url().includes('window=chat'));
  const settings = pages.find(page => page.url().includes('window=settings'));
  assert(chat && settings);
  for (const page of pages) page.on('pageerror', error => errors.push(error.message));
  await chat.waitForSelector('.companion-shell');
  await chat.waitForFunction(() => window.ayana.getState().then(state => state.connected));
  await chat.evaluate(() => {
    window.__companionEvents = [];
    window.ayana.onEvent(event => { if (event.type.startsWith('playback.') || event.type === 'error') window.__companionEvents.push(event); });
  });
  await chat.waitForFunction(() => document.querySelector('.character')?.naturalWidth === 472);
  assert.equal(await chat.locator('.workshop').count(), 0);
  assert.equal(await chat.locator('.character').count(), 1);
  const before = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ url: window.webContents.getURL(), visible: window.isVisible(), background: window.getBackgroundColor() })));
  assert.equal(before.find(window => window.url.includes('window=settings')).visible, false);
  // Electron's getBackgroundColor returns RGB even for a zero-alpha window.
  assert.equal(before.find(window => window.url.includes('window=chat')).background, '#000000');
  const background = await chat.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  assert.equal(background, 'rgba(0, 0, 0, 0)');
  await chat.screenshot({ path: path.join(directory, 'companion.png'), omitBackground: true });
  await chat.getByRole('button', { name: '打开设置', exact: true }).click();
  await settings.waitForSelector('.settings-form');
  await settings.getByRole('checkbox', { name: '每句切换时轻微下沉，再回到原位' }).uncheck();
  await settings.getByRole('button', { name: '保存设置', exact: true }).click();
  await chat.waitForFunction(() => window.ayana.getState().then(state => state.events.some(event => event.type === 'settings.ready' && event.settings.sentence_motion === false)));
  await settings.screenshot({ path: path.join(directory, 'settings.png') });
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  await chat.getByRole('textbox', { name: '输入问题', exact: true }).fill('今天随便聊聊吧');
  await chat.getByRole('button', { name: '发送', exact: true }).click();
  await chat.waitForFunction(() => document.querySelector('.gal-lines [lang=ja]')?.textContent === 'うん、ここにいるよ。');
  await chat.waitForFunction(() => document.querySelector('.gal-translation')?.textContent === '嗯，我在这里。');
  await chat.waitForFunction(() => document.querySelector('.character')?.src.includes('aya_z1a0010__a0009'));
  await chat.waitForFunction(() => document.querySelector('.gal-lines [lang=ja]')?.textContent === '今日は、どんなことを話したい？');
  await chat.screenshot({ path: path.join(directory, 'conversation.png'), omitBackground: true });
  await chat.waitForTimeout(2000);
  if (realVoice) {
    await chat.waitForFunction(() => window.__companionEvents.some(event => event.type === 'playback.ended' && typeof event.seq !== 'number' && event.played_samples > 0));
    assert.equal(await chat.evaluate(() => window.__companionEvents.filter(event => event.type === 'error').length), 0);
  }
  assert.equal(await chat.locator('.gal-lines [lang=ja]').textContent(), '今日は、どんなことを話したい？');
  await chat.getByRole('button', { name: '打开设置', exact: true }).click();
  await settings.getByRole('checkbox', { name: '每句切换时轻微下沉，再回到原位' }).check();
  await settings.getByRole('button', { name: '保存设置', exact: true }).click();
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  // A direct controlled playback receipt checks the live portrait animation without a model or TTS request.
  await chat.waitForFunction(() => window.ayana.getState().then(state => state.events.some(event => event.type === 'settings.ready' && event.settings.sentence_motion === true)));
  await chat.getByRole('textbox', { name: '输入问题', exact: true }).fill('再聊一句');
  await chat.getByRole('button', { name: '发送', exact: true }).click();
  await chat.waitForFunction(() => document.querySelector('.character-frame').getAnimations().some(animation => animation.playState === 'running'));
  await chat.waitForTimeout(450);
  assert.equal(await chat.locator('.character-frame').evaluate(element => getComputedStyle(element).transform), 'none');
  await chat.getByRole('button', { name: '收起 Ayana', exact: true }).click();
  const after = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(window => /window=(chat|settings)/.test(window.webContents.getURL())).map(window => window.isVisible()));
  assert(after.every(visible => !visible));
  assert.deepEqual(errors, []);
  console.log('PASS: transparent half portrait; separate settings; sentence routing, translation and motion; hide lifecycle.');
} finally {
  await application.close();
}
