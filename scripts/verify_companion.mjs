/** Verify the actual Electron companion, with an isolated local text-only profile. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
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
let target;
const python = (code, parameters = []) => {
  const result = spawnSync(path.join(root, '.venv/Scripts/python.exe'), ['-X', 'utf8', '-c', code, ...parameters], { cwd: root, windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
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
  assert.equal(await chat.locator('.portrait-stage').evaluate(element => getComputedStyle(element).maskImage), 'none');
  assert.equal(await chat.locator('.portrait-reveal').evaluate(element => getComputedStyle(element).opacity), '1');
  const targetState = path.join(directory, 'appearance-target.json');
  target = spawn(python('import sys; print(sys._base_executable)'), ['-m', 'native.windows.demo_target', '--state', targetState, '--auto-close', '120'], { cwd: root, windowsHide: true, stdio: 'ignore' });
  // Observe a real owned Win32 window, rather than injecting a renderer event.
  let owned;
  for (let i = 0; i < 100; i++) {
    try { owned = JSON.parse(readFileSync(targetState, 'utf8')); if (owned.target?.process_id === target.pid) break; } catch {}
    await chat.waitForTimeout(50);
  }
  assert(owned?.hwnd);
  assert.equal(owned.target.process_id, target.pid);
  const highlight = pages.find(page => page.url().includes('window=highlight'));
  const summon = async () => {
    python('from native.windows.win32 import Win32; import sys; assert Win32().focus(int(sys.argv[1]))', [String(owned.hwnd)]);
    await chat.evaluate(() => window.ayana.summon());
    await chat.waitForFunction(() => document.querySelector('.portrait-reveal').getAnimations().some(animation => animation.playState === 'running'));
    await highlight.waitForSelector('.target-aura');
  };
  await summon();
  const anchor = await application.evaluate(({ BrowserWindow, screen }) => {
    const overlay = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('window=highlight'));
    return { visible: overlay.isVisible(), focusable: overlay.isFocusable(), bounds: overlay.getBounds() };
  });
  const targetBounds = JSON.parse(python('from native.windows.win32 import Win32; import sys,json; print(json.dumps(Win32().identity(int(sys.argv[1]))["bounds"]))', [String(owned.hwnd)]));
  const expected = await application.evaluate(({ BrowserWindow, screen }, rect) => screen.screenToDipRect(BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('window=chat')), { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top }), targetBounds);
  assert(anchor.visible && !anchor.focusable);
  for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(anchor.bounds[key] - expected[key]) <= 1, `Anchor ${key} must match the target at this DPI`);
  await highlight.screenshot({ path: path.join(directory, 'target-aura.png'), omitBackground: true });
  await chat.waitForTimeout(1900);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('window=highlight')).isVisible()), false);
  assert.equal(await chat.locator('.portrait-reveal').evaluate(element => getComputedStyle(element).transform), 'none');
  await chat.evaluate(() => window.ayana.hide());
  await summon();
  await chat.waitForTimeout(550);
  await chat.screenshot({ path: path.join(directory, 'companion.png'), omitBackground: true });
  // Check actual rendered alpha, including the torso just above the dialogue.
  const opaqueProbes = await chat.evaluate(() => {
    const image = document.querySelector('.character');
    const rect = image.getBoundingClientRect();
    const box = document.querySelector('.gal-dialogue').getBoundingClientRect();
    return { scale: devicePixelRatio, points: [
      [rect.left + rect.width / 2, rect.top + rect.height * 160 / image.naturalHeight],
      [rect.left + rect.width / 2, box.top - 14],
      [rect.left + rect.width / 2, box.top + 28],
    ] };
  });
  const paintedAlpha = JSON.parse(python('from PIL import Image; import sys,json; im=Image.open(sys.argv[1]).convert("RGBA"); probes=json.loads(sys.argv[2]); print(json.dumps([im.getpixel((round(x*probes["scale"]),round(y*probes["scale"])))[3] for x,y in probes["points"]]))', [path.join(directory, 'companion.png'), JSON.stringify(opaqueProbes)]));
  assert.deepEqual(paintedAlpha, [255, 255, 255], 'Face, lower torso and dialogue overlap must be opaque in the rendered image');
  await chat.emulateMedia({ reducedMotion: 'reduce' });
  await highlight.emulateMedia({ reducedMotion: 'reduce' });
  python('from native.windows.win32 import Win32; import sys; assert Win32().focus(int(sys.argv[1]))', [String(owned.hwnd)]);
  await chat.evaluate(() => window.ayana.summon());
  await chat.waitForTimeout(100);
  assert.equal(await chat.locator('.portrait-reveal').evaluate(element => element.getAnimations().filter(animation => animation.playState === 'running').length), 0);
  assert.equal(await highlight.locator('.target-aura').evaluate(element => getComputedStyle(element).animationName), 'none');
  await chat.emulateMedia({ reducedMotion: 'no-preference' });
  await highlight.emulateMedia({ reducedMotion: 'no-preference' });
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
  await chat.waitForFunction(() => document.querySelector('.character')?.src.includes('aya_z1a0000__a0009'));
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
  // Rapid repeated restart requests must share one transition and backend.
  await settings.evaluate(() => Promise.all([window.ayana.restart(), window.ayana.restart()]));
  await chat.waitForFunction(() => window.ayana.getState().then(state => state.connected));
  const mainPid = await application.evaluate(() => process.pid);
  const backends = JSON.parse(python('import sys,json; sys.path.append(r"D:/ayana-voice/venv/Lib/site-packages"); import psutil; print(json.dumps([p.pid for p in psutil.Process(int(sys.argv[1])).children() if "-m services.agent" in " ".join(p.cmdline())]))', [String(mainPid)]));
  assert.equal(backends.length, 1, 'Repeated restart must leave exactly one owned agent backend');
  await chat.getByRole('button', { name: '收起 Ayana', exact: true }).click();
  const after = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(window => /window=(chat|settings)/.test(window.webContents.getURL())).map(window => window.isVisible()));
  assert(after.every(visible => !visible));
  assert.deepEqual(errors, []);
  console.log('PASS: opaque portrait and dialogue overlap pixels; repeated summon animation; real foreground window aura and DPI bounds; timed aura dismissal; separate settings; sentence routing, translation and motion; hide lifecycle.');
} finally {
  await application.close();
  if (target && target.exitCode === null) target.kill();
}
