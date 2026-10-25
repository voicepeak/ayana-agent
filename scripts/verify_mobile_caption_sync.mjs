/** Synthetic transport exercises out-of-order readiness, sequential playback and portrait motion. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const option = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright-core', { paths: [option('--playwright-root', process.cwd())] }));
const browser = await chromium.launch({ headless: true, executablePath: option('--browser', 'C:/Program Files/Google/Chrome/Application/chrome.exe'), args: ['--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] });
const output = path.resolve(option('--output', '.runtime/benchmarks/mobile-caption-sync'));
mkdirSync(output, { recursive: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
const page = await context.newPage();
const errors = [], receipts = [], checks = [];
let socket, command;
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  const animate = Element.prototype.animate;
  window.portraitAnimations = [];
  Element.prototype.animate = function(frames, options) {
    if (this.classList.contains('portrait')) window.portraitAnimations.push({ frames, options });
    return animate.call(this, frames, options);
  };
});
await page.route('**/v1/activate', route => route.fulfill({ json: { user_id: 'caption-sync-test', access_token: 'synthetic', refresh_token: 'synthetic', expires_at: Date.now() / 1000 + 900, config: {} } }));
await page.routeWebSocket('**/v1/mobile', connection => {
  socket = connection;
  connection.onMessage(raw => {
    const value = JSON.parse(String(raw));
    if (value.access_token) {
      connection.send(JSON.stringify({ protocol_version: 1, type: 'gateway.ready' }));
      connection.send(JSON.stringify({ protocol_version: 1, type: 'service.state', service: 'tts', state: 'ready' }));
    }
    if (value.type === 'turn.start') command = value;
    if (value.type === 'audio.consumed') receipts.push(value.utterance_id);
  });
});
function emit(type, fields = {}) {
  socket.send(JSON.stringify({ protocol_version: 1, generation_id: command.generation_id, conversation_id: command.conversation_id, turn_id: command.turn_id, type, ...fields }));
}
function audio(id, seconds = 2) {
  const pcm = Buffer.alloc(32000 * seconds * 2);
  const metadata = Buffer.from(JSON.stringify({ protocol_version: 1, type: 'audio.ready', generation_id: command.generation_id, conversation_id: command.conversation_id, turn_id: command.turn_id, utterance_id: id, sample_rate: 32000, channels: 1, format: 'pcm_s16le', byte_length: pcm.length, sample_count: pcm.length / 2, duration_ms: seconds * 1000 }));
  const header = Buffer.alloc(4); header.writeUInt32LE(metadata.length);
  socket.send(Buffer.concat([header, metadata, pcm]));
}
async function send(text) {
  command = undefined;
  await page.getByLabel('消息', { exact: true }).fill(text);
  await page.getByLabel('发送', { exact: true }).click();
  for (let attempt = 0; !command && attempt < 100; attempt++) await page.waitForTimeout(20);
  assert.ok(command);
}
const line = index => page.locator('.transcript .speech-line').nth(index);
try {
  await page.goto(option('--url', 'http://127.0.0.1:5174/'));
  await page.getByLabel('激活码', { exact: true }).fill('synthetic');
  await page.locator('button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('.topbar-title')?.textContent.includes('已连接'));
  await page.locator('.stage img.portrait').waitFor();
  await page.getByLabel('打开菜单').click();
  assert.equal(await page.getByLabel('对白语言').inputValue(), 'ja');
  assert.equal(await page.getByLabel('翻译语言').inputValue(), 'zh');
  await page.locator('.drawer').getByLabel('关闭', { exact: true }).click();
  checks.push('Japanese primary and Chinese translation by default');
  await send('字幕同步');
  emit('utterance.ready', { utterance_id: 'first', speech_ja: 'ここで一緒に休もう。', expression: '吃惊', audio_enabled: true });
  emit('subtitle.ready', { utterance_id: 'first', display_zh: '我们一起在这里休息吧。' });
  emit('utterance.ready', { utterance_id: 'second', speech_ja: '明日もきっといい日になるよ。', expression: '开心', audio_enabled: true });
  emit('subtitle.ready', { utterance_id: 'second', display_zh: '明天也一定会是美好的一天。' });
  emit('task.state', { state: 'idle' });
  // Deliberately exceed the old nine-second forced-text fallback.
  await page.waitForTimeout(9500);
  assert.equal(await page.locator('.transcript .speech-line').count(), 0);
  assert.match(await page.locator('.thinking').innerText(), /准备语音/);
  assert.equal(receipts.length, 0);
  checks.push('No captions or premature audio receipts after nine seconds waiting');
  audio('second', 1);
  await page.waitForTimeout(180);
  assert.equal(await page.locator('.transcript .speech-line').count(), 0);
  audio('first', 2);
  await line(0).waitFor();
  await page.waitForTimeout(450);
  assert.equal(await page.locator('.transcript .speech-line').count(), 1);
  const firstPartial = await line(0).locator('.speech-main').getAttribute('aria-label');
  assert.ok(firstPartial.length > 0 && firstPartial.length < 'ここで一緒に休もう。'.length);
  const translatedPartial = await line(0).locator('.speech-secondary').innerText();
  assert.ok(translatedPartial.length > 0 && translatedPartial.length < '我们一起在这里休息吧。'.length);
  await page.screenshot({ path: path.join(output, 'first-sentence-streaming.png') });
  checks.push('Both captions stream with actual audio; second sentence stays hidden');
  await line(1).waitFor();
  assert.ok(receipts.includes('first'), 'second sentence appeared before first audio ended');
  await page.waitForFunction(() => !document.querySelector('.stop-button'));
  assert.deepEqual(receipts, ['first', 'second']);
  assert.equal(await line(0).locator('.speech-main').getAttribute('aria-label'), 'ここで一緒に休もう。');
  const animations = await page.evaluate(() => window.portraitAnimations);
  assert.ok(animations.some(item => item.frames.some(frame => frame.transform.includes('translateY(-9px)'))));
  checks.push('Sequential audio completes once per sentence and portrait bounce runs');
  await send('翻译慢到达');
  emit('utterance.ready', { utterance_id: 'delayed-translation', speech_ja: '待っているよ。', expression: '休闲', audio_enabled: true });
  audio('delayed-translation', 1);
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.transcript .speech-line').count(), 2);
  emit('subtitle.ready', { utterance_id: 'delayed-translation', display_zh: '我在等你。' });
  emit('task.state', { state: 'idle' });
  await line(2).waitFor();
  await page.getByLabel('打断', { exact: true }).click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.stop-button').count(), 0);
  checks.push('Audio waits for its translation; cancellation releases playback');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const before = await page.evaluate(() => window.portraitAnimations.length);
  await send('减少动态效果');
  emit('utterance.ready', { utterance_id: 'reduced', speech_ja: '静かに話そう。', expression: '不满', audio_enabled: true });
  emit('subtitle.ready', { utterance_id: 'reduced', display_zh: '安静地说话吧。' });
  audio('reduced', 1);
  emit('task.state', { state: 'idle' });
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => window.portraitAnimations.length), before);
  checks.push('Reduced-motion preference disables portrait bounce');
  // Existing installations must migrate the previous defaults only once.
  await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('ayana-independent-mobile', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('state', 'readwrite');
      const store = transaction.objectStore('state');
      const request = store.get('runtime:caption-sync-test');
      request.onsuccess = () => {
        const saved = request.result;
        saved.settings.companion_ui = { theme: 'ink', primary_language: 'zh', translation_language: 'none' };
        store.put(saved, 'runtime:caption-sync-test');
      };
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await page.reload();
  await page.getByLabel('打开菜单').click();
  assert.equal(await page.getByLabel('对白语言').inputValue(), 'ja');
  assert.equal(await page.getByLabel('翻译语言').inputValue(), 'zh');
  await page.getByLabel('对白语言').selectOption('zh');
  await page.getByLabel('翻译语言').selectOption('none');
  await page.waitForTimeout(300);
  await page.reload();
  await page.getByLabel('打开菜单').click();
  assert.equal(await page.getByLabel('对白语言').inputValue(), 'zh');
  assert.equal(await page.getByLabel('翻译语言').inputValue(), 'none');
  checks.push('Legacy defaults migrate once; later language choices survive reload');
  assert.deepEqual(errors, []);
  writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, errors }));
} finally { await browser.close(); }
