/** Real Electron wardrobe/TTS/transition checks, using isolated local settings. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const moduleRoot = args.includes('--playwright-root') ? args[args.indexOf('--playwright-root') + 1] : root;
const require = createRequire(import.meta.url);
const { _electron } = require(require.resolve('playwright', { paths: [moduleRoot] }));
const output = path.join(root, '.runtime/benchmarks/costume-change');
const data = path.join(output, `data-${Date.now()}`);
let voice = { voice_mode: 'system' };
try { voice = JSON.parse(readFileSync(path.join(root, 'config/local.json'), 'utf8')).voice || voice; } catch { /* Use installed Japanese voice. */ }
mkdirSync(path.join(data, 'config'), { recursive: true });
writeFileSync(path.join(data, 'config/local.json'), JSON.stringify({
  provider: 'local', voice, volume: 0, avatar_costume: '校服', save_history: false,
}));
const catalog = JSON.parse(readFileSync(path.join(root, 'characters/ayana/avatar-map.json'), 'utf8'));
const costumes = [...new Set(Object.values(catalog.assets).map(item => item.costume))];
const alternate = costumes.find(costume => costume !== '校服');
const report = { checks: {}, errors: [], scope: 'Actual Electron, configured TTS and AudioWorklet receipts; output muted; no acoustic judgment.' };
let app;
let chat;
try {
  app = await _electron.launch({
    executablePath: path.join(root, 'apps/desktop/node_modules/electron/dist/electron.exe'),
    args: [path.join(root, 'apps/desktop'), `--user-data-dir=${path.join(data, 'electron')}`],
    env: { ...process.env, AYANA_DATA_DIR: data, AYANA_REPOSITORY_ROOT: root, AYANA_PYTHON: path.join(root, '.venv/Scripts/python.exe') },
  });
  chat = (await app.windows()).find(page => page.url().includes('window=chat')) || await app.firstWindow();
  await chat.waitForSelector('.companion-shell');
  await chat.waitForFunction(() => window.ayana.getState().then(state => state.connected));
  await chat.waitForFunction(() => window.ayana.getState().then(state => state.events.some(event =>
    event.type === 'service.state' && event.service === 'tts' && event.state === 'ready')), null, { timeout: 120000 });
  const settings = (await app.windows()).find(page => page.url().includes('window=settings'));
  assert(settings);
  for (const page of [chat, settings]) page.on('pageerror', error => report.errors.push(error.message));
  await chat.emulateMedia({ reducedMotion: 'no-preference' });
  await chat.waitForFunction(() => {
    const image = document.querySelector('.character');
    return image?.naturalWidth > 0 && image.getAttribute('src') === 'ayana-asset://aya_z1a0000__a0001/';
  });
  await chat.evaluate(() => {
    window.__wardrobeEvents = [];
    window.__wardrobeFrames = [];
    window.ayana.onEvent(event => window.__wardrobeEvents.push({ ...event, pcm_base64: undefined, png_base64: undefined, at: performance.now() }));
    const sample = () => {
      window.__wardrobeFrames.push({ at: performance.now(), src: document.querySelector('.character')?.getAttribute('src'),
        glow: Number(getComputedStyle(document.querySelector('.costume-shimmer')).opacity),
        opacity: Number(getComputedStyle(document.querySelector('.character-figure')).opacity) });
      if (window.__wardrobeFrames.length > 5000) window.__wardrobeFrames.shift();
      requestAnimationFrame(sample);
    };
    sample();
  });
  const oldSrc = await chat.locator('.character').getAttribute('src');
  await chat.evaluate(() => window.ayana.openSettings());
  await settings.getByLabel(/^服装/).selectOption(alternate);
  await settings.getByRole('button', { name: '保存设置', exact: true }).click();
  await chat.waitForFunction(() => window.__wardrobeEvents.some(event => event.type === 'playback.started' && !event.seq && event.output_sample_rate), null, { timeout: 30000 });
  await chat.waitForFunction(() => {
    const speech = window.__wardrobeEvents.find(event => event.type === 'utterance.ready' && event.presentation === 'costume-change');
    return speech && document.querySelector('.character')?.getAttribute('src') === `ayana-asset://${speech.asset_id}/`;
  });
  await chat.waitForFunction(() => window.__wardrobeFrames.at(-1)?.src === document.querySelector('.character')?.getAttribute('src'));
  const frames = await chat.evaluate(() => window.__wardrobeFrames);
  const changed = frames.findIndex(frame => frame.src !== oldSrc);
  assert(changed > 0);
  assert(frames.slice(0, changed).some(frame => frame.glow > .1 && frame.opacity < .95));
  assert(frames[changed].glow > .1);
  const startedAt = await chat.evaluate(() => window.__wardrobeEvents.find(event => event.type === 'playback.started' && !event.seq).at);
  assert(frames[changed].at >= startedAt);
  report.checks.voice_started_before_outfit_swap = true;
  report.checks.old_portrait_faded_under_gold_light = true;
  await chat.waitForFunction(() => window.__wardrobeEvents.some(event => event.type === 'playback.ended' && !event.seq && event.output_sample_rate), null, { timeout: 20000 });
  assert(!(await chat.evaluate(() => window.__wardrobeEvents.some(event => event.type === 'user.message'))));
  report.checks.automatic_voice_consumed_without_user_turn = true;
  await chat.screenshot({ path: path.join(output, 'new-outfit.png') });

  const before = await chat.evaluate(() => window.__wardrobeEvents.filter(event => event.type === 'utterance.ready').length);
  await settings.getByRole('button', { name: '保存设置', exact: true }).click();
  await settings.waitForTimeout(400);
  assert.equal(await chat.evaluate(() => window.__wardrobeEvents.filter(event => event.type === 'utterance.ready').length), before);
  report.checks.unchanged_outfit_does_not_repeat_reply = true;

  await chat.evaluate(() => window.ayana.hide());
  await settings.getByLabel(/^语音引擎/).selectOption('silent');
  await settings.getByLabel(/^服装/).selectOption('校服');
  await settings.getByRole('button', { name: '保存设置', exact: true }).click();
  await chat.waitForFunction(() => document.querySelector('.character')?.getAttribute('src')?.includes('aya_z1a0000__'));
  const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('window=chat')).isVisible());
  assert(visible);
  report.checks.silent_mode_switches_and_shows_hidden_chat = true;

  await chat.emulateMedia({ reducedMotion: 'reduce' });
  await chat.waitForTimeout(1000);
  const beforeReducedSrc = await chat.locator('.character').getAttribute('src');
  const frameStart = await chat.evaluate(() => window.__wardrobeFrames.length);
  await settings.getByLabel(/^服装/).selectOption(alternate);
  await settings.getByRole('button', { name: '保存设置', exact: true }).click();
  await chat.waitForFunction(old => document.querySelector('.character')?.getAttribute('src') !== old, beforeReducedSrc);
  await chat.waitForTimeout(200);
  assert((await chat.evaluate(start => window.__wardrobeFrames.slice(start), frameStart)).every(frame => frame.glow === 0));
  report.checks.reduced_motion_skips_flash = true;
  assert.equal(report.errors.length, 0);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.errors.push(error.stack || String(error));
  if (chat) {
    try { report.diagnostics = await chat.evaluate(() => ({ events: window.__wardrobeEvents, frames: window.__wardrobeFrames })); } catch { /* Closing renderer. */ }
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (app) await app.close();
}

