/** Isolated Electron QA for the interactive MG first-run guide. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const require = createRequire(import.meta.url);
const { _electron } = require(require.resolve('playwright', { paths: [option('--playwright-root') || root] }));
const directory = path.join(root, '.runtime/benchmarks', `welcome-mg-${Date.now()}`);
const report = { checks: [], errors: [], directory };

function createProfile(name) {
  const data = path.join(directory, name);
  mkdirSync(path.join(data, 'config'), { recursive: true });
  writeFileSync(path.join(data, 'config/local.json'), JSON.stringify({
    user_name: '', onboarding_version: 0, provider: 'local', voice: { voice_mode: 'silent' }, volume: 0,
    send_screenshot: false, ambient_attention: false, hotkey: 'Control+Alt+F8', cancel_hotkey: 'Control+Alt+F9',
    talk_hotkey: 'Control+Shift+F12', companion_ui: { theme: 'ink', background_mode: 'minimal' },
  }));
  return data;
}

const disk = data => JSON.parse(readFileSync(path.join(data, 'config/local.json'), 'utf8'));

async function launch(data) {
  const app = await _electron.launch({
    executablePath: path.join(root, 'apps/desktop/node_modules/electron/dist/electron.exe'),
    args: [path.join(root, 'apps/desktop'), `--user-data-dir=${data}`],
    env: { ...process.env, AYANA_DATA_DIR: data, AYANA_REPOSITORY_ROOT: root, AYANA_PYTHON: path.join(root, '.venv/Scripts/python.exe') },
    timeout: 30000,
  });
  let page;
  for (let i = 0; i < 300; i++) {
    page = (await app.windows()).find(item => item.url().includes('window=welcome'));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!page) throw new Error('welcome window did not open');
  page.on('pageerror', error => report.errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=welcome')).setBounds({ x: -3000, y: 0, width: 1600, height: 900 }));
  await page.waitForTimeout(300);
  return { app, page };
}

const shot = (page, name) => page.screenshot({ path: path.join(directory, `${name}.png`) });
async function ready(page) {
  // The outgoing scene is replaced after 180ms; wait for the new loader before observing inert.
  await page.waitForTimeout(320);
  await page.waitForFunction(() => {
    const scene = document.querySelector('.mg-scene');
    return scene && !scene.hasAttribute('inert');
  }, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(180);
}

try {
  const data = createProfile('main');
  const { app, page } = await launch(data);
  try {
    await page.locator('#mg-name').waitFor({ timeout: 60000 });
    await ready(page);
    assert.equal(await page.locator('.mg-round').isDisabled(), true);
    await shot(page, '01-meet');
    await page.locator('#mg-name').fill('星野');
    await page.waitForFunction(() => { const button = document.querySelector('.mg-round'); return button && !button.disabled; }, null, { timeout: 60000 });
    await page.locator('#mg-name').press('Enter');
    await page.locator('.mg-next').waitFor();
    assert.equal(disk(data).user_name, '星野');
    await shot(page, '02-greeting');
    report.checks.push('name is entered inline, saved by the backend and answered with a greeting');
    await page.locator('.mg-next').click();
    await ready(page);
    await page.locator('.mg-send').click();
    await page.locator('.mg-bubble-ai[data-visible=true]').waitFor();
    assert.equal(await page.locator('.mg-note').getAttribute('data-sent'), 'true');
    await shot(page, '03-chat');
    report.checks.push('sending the first message is a real click; the reply arrives on the same playhead');
    await page.locator('.mg-next').click();
    await ready(page);
    const hold = await page.locator('.mg-record').boundingBox();
    await page.mouse.move(hold.x + hold.width / 2, hold.y + hold.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.mg-voice').getAttribute('data-phase'), 'holding');
    await page.mouse.up();
    await page.locator('.mg-voice-result').waitFor();
    assert.match(await page.getByLabel('识别结果').inputValue(), /散步/);
    await shot(page, '04-voice');
    report.checks.push('holding the on-screen shortcut drives the waveform; release produces editable text');
    await page.locator('.mg-next').click();
    await ready(page);
    await page.locator('.mg-query').click();
    await page.locator('.mg-result').first().waitFor();
    await shot(page, '05-search-results');
    await page.locator('.mg-result').first().click();
    await page.locator('.mg-source-note').waitFor();
    assert.equal(await page.locator('.mg-result').first().getAttribute('data-selected'), 'true');
    await shot(page, '06-search-source');
    report.checks.push('query, result fan and source selection are separate interactive beats');
    await page.locator('.mg-next').click();
    await ready(page);
    await page.locator('.mg-switch').click();
    assert.equal(await page.getByRole('switch').isChecked(), true);
    await shot(page, '07-observe');
    await page.locator('.mg-next').click();
    await ready(page);
    await page.getByRole('button', { name: '暮海 · 雾蓝' }).click();
    await page.waitForTimeout(800);
    await shot(page, '08-style');
    report.checks.push('the permission switch and the theme swatch are the settings themselves');
    await page.locator('.mg-next').click();
    await ready(page);
    await page.locator('.mg-ready').waitFor();
    await shot(page, '09-ready');
    await page.locator('.mg-next').click();
    await page.waitForTimeout(320);
    const opacity = await app.evaluate(({ BrowserWindow }) => Object.fromEntries(BrowserWindow.getAllWindows()
      .filter(w => /window=(welcome|chat)/.test(w.webContents.getURL()))
      .map(w => [new URL(w.webContents.getURL()).searchParams.get('window'), w.getOpacity()])));
    assert(opacity.welcome > 0 && opacity.welcome < 1 && opacity.chat > 0 && opacity.chat < 1, JSON.stringify(opacity));
    await page.waitForTimeout(900);
    const saved = disk(data);
    assert.equal(saved.onboarding_version, 1);
    assert.equal(saved.user_name, '星野');
    assert.equal(saved.ambient_attention, true);
    assert.equal(saved.companion_ui.theme, 'sea');
    assert.equal(saved.companion_ui.background_color, '#1c3042');
    assert.equal(saved.companion_ui.bubble_color, '#dce6ed');
    report.checks.push('finish persists name, permission and theme; native windows crossfade with intermediate opacity');
  } finally { await app.close(); }

  const skipped = createProfile('skip');
  const second = await launch(skipped);
  try {
    await second.page.locator('#mg-name').waitFor({ timeout: 60000 });
    await ready(second.page);
    await second.page.getByRole('button', { name: '跳过介绍' }).click();
    await second.page.locator('#mg-name').fill('悠');
    await second.page.waitForFunction(() => { const button = document.querySelector('.mg-round'); return button && !button.disabled; }, null, { timeout: 60000 });
    await second.page.locator('#mg-name').press('Enter');
    await second.page.waitForTimeout(1500);
    const saved = disk(skipped);
    assert.equal(saved.user_name, '悠');
    assert.equal(saved.onboarding_version, 1);
    report.checks.push('skip still requires a name and then completes the onboarding');
  } finally { await second.app.close(); }

  assert.equal(report.errors.length, 0, report.errors.join('\n'));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.errors.push(error.stack);
  console.error(error);
  process.exitCode = 1;
} finally {
  writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
}
