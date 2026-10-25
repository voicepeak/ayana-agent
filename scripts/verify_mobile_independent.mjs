/** Live phone UI + local state/offline checks. Does not print activation/session secrets. */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
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
const stress = process.argv.includes('--stress');
const recovery = process.argv.includes('--recovery');
const stored = readFileSync(option('--activation-file') || path.join(root, '.runtime/mobile-services/activation-code.txt'), 'utf8').trim();
const activation = JSON.parse(Buffer.from(stored.split('.')[1], 'base64url'));
const code = 'ayana1.' + Buffer.from(JSON.stringify({ ...activation, url: new URL(address).origin })).toString('base64url');
const screenshot = path.join(root, '.runtime/benchmarks/mobile-independent.png');
mkdirSync(path.dirname(screenshot), { recursive: true });
const browser = await chromium.launch({ headless: true, ...(option('--browser') ? { executablePath: option('--browser') } : { channel: 'chrome' }), args: [
  '--autoplay-policy=no-user-gesture-required',
  ...(process.argv.includes('--direct') ? ['--no-proxy-server'] : []),
] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const page = await context.newPage();
await page.addInitScript(() => {
  const NativeSocket = window.WebSocket;
  window.__testSockets = [];
  window.WebSocket = class extends NativeSocket {
    constructor(...args) { super(...args); window.__testSockets.push(this); }
  };
});
const errors = [], requests = [], commands = [], audio = [], timings = [], turns = [];
let expectedSpeeches = 0;
const completedTurns = new Set();
const cancelledTurns = new Set(), speechIds = new Map(), captions = new Set(), received = new Set(), receipts = new Set();
async function waitForPlayback(turnCount) {
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    assert.deepEqual(errors, []);
    if (turns.length >= turnCount && turns.slice(0, turnCount).every(turn => cancelledTurns.has(turn.turn_id)
      || (completedTurns.has(turn.turn_id) && speechIds.get(turn.turn_id)?.size > 0
        && [...speechIds.get(turn.turn_id)].every(id => captions.has(id) && received.has(id) && receipts.has(id))))) return;
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
      if (event.type === 'audio.consumed') receipts.add(event.utterance_id);
    } catch {}
  });
  socket.on('framereceived', ({ payload }) => {
    if (typeof payload !== 'string') {
      audio.push(payload.length); timings.push(Date.now() - started);
      const data = Buffer.from(payload);
      received.add(JSON.parse(data.subarray(4, 4 + data.readUInt32LE()).toString()).utterance_id);
    }
    else {
      const event = JSON.parse(payload);
      if (event.type === 'utterance.ready') {
        expectedSpeeches++;
        if (!speechIds.has(event.turn_id)) speechIds.set(event.turn_id, new Set());
        speechIds.get(event.turn_id).add(event.utterance_id);
      }
      if (event.type === 'subtitle.ready') captions.add(event.utterance_id);
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
  if (option('--character') && option('--character') !== 'ayana') throw new Error('Mobile currently enables black-uniform Ayana only');
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
  if (stress) {
    const prompts = ['今天有点累，陪我聊聊。', '记住：我喜欢安静的咖啡店。', '我刚才说我喜欢什么？',
      '讲一个很短的小故事。', '这个故事里的角色为什么这样选择？', '用四句说说你对幸福的看法。',
      '你能看见我手机屏幕吗？', '给我一句带引号的日语鼓励。', '哈哈，你刚刚很可爱。',
      '如果我只说一个省略号呢……', '比较一下独处和孤独。', '晚安，明天再聊。'];
    for (const text of prompts) {
      const expectedTurns = completedTurns.size + 1;
      await page.fill('.composer textarea', text);
      await page.click('.send-button');
      await waitForPlayback(expectedTurns);
      assert.ok(await page.locator('.portrait').evaluate(image => image.naturalWidth > 0));
      console.log(JSON.stringify({ progress: 'live_turn', completed: completedTurns.size, audio: audio.length }));
    }
  }
  assert.equal(turns.length, stress ? 14 : 2);
  if (recovery) {
    const before = turns.length;
    await page.fill('.composer textarea', '讲一个八句的小故事。');
    await page.click('.send-button');
    const cancelDeadline = Date.now() + 90000;
    while (turns.length === before || !speechIds.get(turns.at(-1).turn_id)?.size) {
      assert.deepEqual(errors, []);
      assert.ok(Date.now() < cancelDeadline, 'No sentence available for cancellation test');
      await page.waitForTimeout(50);
    }
    cancelledTurns.add(turns.at(-1).turn_id);
    await page.getByLabel('打断', { exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.stop-button'));
    assert.ok(commands.includes('generation.cancel'));
    const sockets = await page.evaluate(() => { const count = window.__testSockets.length; window.__testSockets.at(-1).close(); return count; });
    await page.waitForFunction(count => window.__testSockets.length > count && window.__testSockets.at(-1).readyState === 1, sockets);
    await page.waitForFunction(() => document.querySelector('.topbar-title')?.textContent.includes('已连接'));
    const target = turns.length + 1;
    await page.fill('.composer textarea', '刚才打断了，现在请重新说一句晚安。');
    await page.click('.send-button');
    await waitForPlayback(target);
    await page.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('ayana-independent-mobile', 1);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('state', 'readwrite'), store = tx.objectStore('state');
        const get = store.get('web-session');
        get.onsuccess = () => { const session = JSON.parse(get.result); session.expires_at = 1; store.put(JSON.stringify(session), 'web-session'); };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    }));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('.topbar-title')?.textContent.includes('已连接'));
    assert.ok(requests.includes('/v1/refresh'), 'Expired access was not refreshed');
    await page.getByLabel('打开菜单').click();
    await page.locator('.new-conversation').click();
    const fresh = turns.length + 1;
    await page.fill('.composer textarea', '你好，这是一个新话题。');
    await page.click('.send-button');
    await waitForPlayback(fresh);
    assert.ok(!turns.at(-1).messages.some(message => message.role === 'assistant'), 'Old topic leaked into new topic context');
  }
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
  assert.equal(await page.getByLabel('角色', { exact: true }).textContent(), '彩名 · 黑制服');
  await page.getByLabel('称呼', { exact: true }).fill('联调用户');
  await page.getByLabel('本机记忆（每行一条）').fill('喜欢安静的咖啡店');
  await page.getByLabel('称呼', { exact: true }).click();
  await page.locator('.drawer').getByLabel('关闭', { exact: true }).click();
  await page.waitForFunction(() => [...document.images].some(image => image.className.includes('portrait') && image.naturalWidth > 0));
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByLabel('打开菜单').click();
  assert.equal(await page.getByLabel('角色', { exact: true }).textContent(), '彩名 · 黑制服');
  assert.equal(await page.getByLabel('称呼', { exact: true }).inputValue(), '联调用户');
  assert.equal(await page.getByLabel('本机记忆（每行一条）').inputValue(), '喜欢安静的咖啡店');
  await page.locator('.drawer').getByLabel('关闭', { exact: true }).click();
  const secure = await page.evaluate(() => window.isSecureContext);
  if (secure && checkOffline) {
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    const asset = requests.filter(url => url.startsWith('/characters/')).at(-1);
    assert.ok(asset);
    await page.waitForFunction(async url => Boolean(await caches.match(url)), asset);
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
  if (option('--report')) writeFileSync(option('--report'), JSON.stringify({ passed: true, character: option('--character') || 'ayana', turns: turns.map(t => t.turn_id), audio: audio.length, captions: captions.size, recovery, arrival_ms: timings }));
  console.log(JSON.stringify({ passed: true, live_turns: turns.length, live_audio_sentences: audio.length, captions: captions.size, recovery, arrival_ms: timings, remote_commands: [...new Set(commands)], offline_local_state: secure && checkOffline, screenshot }));
} catch (error) {
  console.error(JSON.stringify({ failed: true, live_turns: turns.length, received_audio: audio.length,
    completed_turns: completedTurns.size, playback_receipts: commands.filter(type => type === 'audio.consumed').length,
    images: await page.evaluate(() => [...document.images].map(image => ({ source: image.currentSrc || image.src,
      loaded: image.naturalWidth > 0 }))) }));
  writeFileSync(path.join(root, '.runtime/benchmarks/mobile-failed-context.json'), JSON.stringify(turns.at(-1)?.messages || []));
  throw error;
} finally { await browser.close(); }
