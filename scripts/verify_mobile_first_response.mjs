/** Delayed synthetic PCM reproduces the gap after model completion, before speech. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const option = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright-core', { paths: [option('--playwright-root', process.cwd())] }));
const browser = await chromium.launch({ headless: true, executablePath: option('--browser', 'C:/Program Files/Google/Chrome/Application/chrome.exe'), args: ['--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const errors = [], receipts = [], timeline = [], timers = [];
const output = path.resolve(option('--output', '.runtime/benchmarks/mobile-first-response'));
mkdirSync(output, { recursive: true });
const strict = process.argv.includes('--strict');
let start = 0;
const mark = name => timeline.push({ name, ms: Date.now() - start });
page.on('pageerror', error => errors.push(error.message));
await page.route('**/v1/activate', route => route.fulfill({ json: { user_id: 'first-response-test', access_token: 'synthetic', refresh_token: 'synthetic', expires_at: Date.now()/1000+900, config: {} } }));
await page.routeWebSocket('**/v1/mobile', socket => socket.onMessage(raw => {
  const command = JSON.parse(String(raw));
  if (command.access_token) {
    socket.send(JSON.stringify({ protocol_version: 1, type: 'gateway.ready' }));
    socket.send(JSON.stringify({ protocol_version: 1, type: 'service.state', service: 'tts', state: 'ready' }));
  }
  if (command.type === 'audio.consumed') { receipts.push(command); mark('audio.consumed'); }
  if (command.type !== 'turn.start') return;
  start = Date.now(); mark('turn.start');
  const emit = (type, fields = {}) => socket.send(JSON.stringify({ protocol_version: 1, type, generation_id: command.generation_id, conversation_id: command.conversation_id, turn_id: command.turn_id, ...fields }));
  emit('task.state', { state: 'thinking' });
  timers.push(setTimeout(() => {
    mark('model.finished');
    emit('utterance.ready', { utterance_id: 'response', speech_ja: 'ここで一緒に休もう。', audio_enabled: true });
    emit('subtitle.ready', { utterance_id: 'response', display_zh: '这句话已经生成。' });
    emit('task.state', { state: 'idle' });
  }, 120));
  timers.push(setTimeout(() => {
    mark('audio.sent');
    const pcm = Buffer.alloc(6400);
    const metadata = Buffer.from(JSON.stringify({ protocol_version: 1, type: 'audio.ready', generation_id: command.generation_id, conversation_id: command.conversation_id, turn_id: command.turn_id, utterance_id: 'response', sample_rate: 32000, channels: 1, format: 'pcm_s16le', byte_length: pcm.length, sample_count: pcm.length/2, duration_ms: 100 }));
    const header = Buffer.alloc(4); header.writeUInt32LE(metadata.length);
    socket.send(Buffer.concat([header, metadata, pcm]));
  }, 1700));
}));
try {
  await page.goto(option('--url', 'http://127.0.0.1:5174/'));
  await page.getByLabel('激活码', { exact: true }).fill('synthetic');
  await page.locator('button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('.topbar-title')?.textContent.includes('已连接'));
  await page.getByLabel('消息', { exact: true }).fill('检查首句等待');
  await page.getByLabel('发送', { exact: true }).click();
  const visible = page.locator('.speech-main').waitFor().then(() => mark('caption.visible'));
  await page.waitForTimeout(500);
  const pending = await page.locator('.transcript').innerText();
  const captionBeforeAudio = pending.includes('这句话已经生成。');
  const waitingAfterModelFinished = /准备语音|语音准备中/.test(pending);
  assert.equal(receipts.length, 0, 'caption preview consumed unplayed audio');
  await page.screenshot({ path: path.join(output, 'waiting-for-first-audio.png') });
  if (strict) { assert.ok(captionBeforeAudio); assert.ok(waitingAfterModelFinished); }
  await visible;
  await page.waitForFunction(() => !document.querySelector('.stop-button'), null, { timeout: 10000 });
  assert.equal(receipts.length, 1, 'audio was skipped or consumed twice');
  assert.deepEqual(errors, []);
  const report = { passed: true, captionBeforeAudio, waitingAfterModelFinished, timeline, errors };
  writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { timers.forEach(clearTimeout); await browser.close(); }
