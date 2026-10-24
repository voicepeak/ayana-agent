/** Live phone UI + local state/offline checks. Does not print activation/session secrets. */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const option = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const library = option('--playwright-root') || root;
const { chromium } = require(require.resolve('playwright-core', { paths: [library] }));
const address = option('--url') || 'http://127.0.0.1:17330/';
const checkOffline = !process.argv.includes('--online-only');
const stored = readFileSync(path.join(root, '.runtime/mobile-services/activation-code.txt'), 'utf8').trim();
const activation = JSON.parse(Buffer.from(stored.split('.')[1], 'base64url'));
const code = 'ayana1.' + Buffer.from(JSON.stringify({ ...activation, url: new URL(address).origin })).toString('base64url');
const screenshot = path.join(root, '.runtime/benchmarks/mobile-independent.png');
mkdirSync(path.dirname(screenshot), { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: [
  '--autoplay-policy=no-user-gesture-required',
  ...(process.argv.includes('--direct') ? ['--no-proxy-server'] : []),
] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const page = await context.newPage();
const errors = [], requests = [], commands = [], audio = [], timings = [], turns = [];
let expectedSpeeches = 0;
const completedTurns = new Set();
async function waitForPlayback(turnCount) {
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    assert.deepEqual(errors, []);
    if (completedTurns.size >= turnCount && expectedSpeeches > 0
      && audio.length >= expectedSpeeches
      && commands.filter(type => type === 'audio.consumed').length >= expectedSpeeches) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for all committed speech to arrive and finish playback');
}
let started = 0;
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => requests.push(new URL(request.url()).pathname));
page.on('websocket', socket => {
  socket.on('framesent', ({ payload }) => {
    try {
      const event = JSON.parse(String(payload));
      if (event.type) commands.push(event.type);
      if (event.type === 'turn.start') { started = Date.now(); turns.push(event); }
    } catch {}
  });
  socket.on('framereceived', ({ payload }) => {
    if (typeof payload !== 'string') { audio.push(payload.length); timings.push(Date.now() - started); }
    else {
      const event = JSON.parse(payload);
      if (event.type === 'utterance.ready') expectedSpeeches++;
      if (event.type === 'task.state' && event.state === 'idle' && event.turn_id) completedTurns.add(event.turn_id);
      if (event.type === 'error') errors.push(event.code || event.message);
    }
  });
});
try {
  // The web edition precaches bundled portraits; don't block interaction on all downloads.
  await page.goto(address, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('ayana-independent-mobile', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('state', 'readwrite');
      transaction.objectStore('state').put('mobile_ui_smoke', 'device-id');
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
    };
  }));
  await page.fill('#mobile-token', code);
  await page.click('button[type=submit]');
  await page.waitForFunction(() => document.querySelector('.topbar-title')?.textContent.includes('已连接'));
  await page.waitForFunction(() => [...document.images].some(image => image.className.includes('portrait') && image.naturalWidth > 0));
  assert.equal(await page.getByLabel('语音识别尚未配置').isDisabled(), true);
  await page.fill('.composer textarea', '你好呀，请用两句短短的日语向我问好。');
  await page.click('.send-button');
  await page.waitForFunction(() => (document.querySelector('.speech-line')?.textContent || '').length > 1, null, { timeout: 90000 });
  await page.waitForFunction(() => !document.querySelector('.stop-button'), null, { timeout: 90000 });
  await waitForPlayback(1);
  assert.ok(audio.length >= 1, 'No live SoVITS audio received');
  assert.ok(commands.includes('audio.consumed'), 'No completed playback receipt');
  const firstAudioCount = audio.length;
  await page.fill('.composer textarea', '嗯，我们继续聊一句吧。');
  await page.click('.send-button');
  await page.waitForSelector('.stop-button');
  await waitForPlayback(2);
  await page.waitForFunction(() => !document.querySelector('.stop-button'), null, { timeout: 90000 });
  assert.ok(audio.length > firstAudioCount, 'Multi-turn reply did not produce speech');
  assert.equal(turns.length, 2);
  const history = turns[1].messages.filter(message => message.role === 'assistant');
  assert.ok(history.length > 0, 'No previous reply supplied as context');
  for (const message of history) {
    for (const event of message.content.split('\n').map(line => JSON.parse(line))) {
      assert.ok(['speech', 'translation'].includes(event.type), 'History must retain the model event protocol');
      assert.ok(!('played_samples' in event) && !('status' in event), 'Playback records leaked into model examples');
    }
  }
  await page.screenshot({ path: screenshot });
  // Local character/settings/memory edits must not send desktop commands.
  await page.getByLabel('打开菜单').click();
  await page.locator('.drawer select').nth(0).selectOption('ayana-su');
  await page.getByLabel('称呼', { exact: true }).fill('联调用户');
  await page.getByLabel('本机记忆（每行一条）').fill('喜欢安静的咖啡店');
  await page.getByLabel('称呼', { exact: true }).click();
  await page.locator('.drawer').getByLabel('关闭', { exact: true }).click();
  await page.waitForFunction(() => [...document.images].some(image => image.className.includes('portrait') && image.naturalWidth > 0));
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByLabel('打开菜单').click();
  assert.equal(await page.locator('.drawer select').nth(0).inputValue(), 'ayana-su');
  assert.equal(await page.getByLabel('称呼', { exact: true }).inputValue(), '联调用户');
  assert.equal(await page.getByLabel('本机记忆（每行一条）').inputValue(), '喜欢安静的咖啡店');
  await page.locator('.drawer').getByLabel('关闭', { exact: true }).click();
  const secure = await page.evaluate(() => window.isSecureContext);
  if (secure && checkOffline) {
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await page.waitForFunction(async () => {
      const portrait = [...document.images].find(image => image.className.includes('portrait') && image.naturalWidth > 0);
      return portrait && Boolean(await caches.match(portrait.currentSrc || portrait.src));
    });
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.app');
    await page.waitForFunction(() => [...document.images].some(image => image.className.includes('portrait') && image.naturalWidth > 0));
    await page.getByLabel('打开菜单').click();
    assert.equal(await page.getByLabel('称呼', { exact: true }).inputValue(), '联调用户');
  }
  assert.ok(!commands.some(type => /^(settings|playback|history|utterance|conversation|memory)\./.test(type)), 'Local state leaked into remote commands');
  assert.ok(!requests.some(url => /^\/(mobile|assets\/ayana|ws)/.test(url)), 'Uses old desktop transport/assets');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, live_turns: turns.length, live_audio_sentences: audio.length, arrival_ms: timings, remote_commands: [...new Set(commands)], offline_local_state: secure && checkOffline, screenshot }));
} catch (error) {
  console.error(JSON.stringify({ failed: true, live_turns: turns.length, received_audio: audio.length,
    completed_turns: completedTurns.size, playback_receipts: commands.filter(type => type === 'audio.consumed').length,
    images: await page.evaluate(() => [...document.images].map(image => ({ source: image.currentSrc || image.src,
      loaded: image.naturalWidth > 0 }))) }));
  throw error;
} finally { await browser.close(); }
