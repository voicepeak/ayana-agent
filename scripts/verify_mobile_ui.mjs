/** Isolated browser regression. Uses a synthetic gateway; no personal activation or model calls. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
const option = name => process.argv[process.argv.indexOf(name) + 1];
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright-core', { paths: [process.argv.includes('--playwright-root') ? option('--playwright-root') : process.cwd()] }));
const browser = await chromium.launch({ headless: true, ...(process.argv.includes('--browser') ? { executablePath: option('--browser') } : { channel: 'chrome' }), args: ['--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] });
const address = process.argv.includes('--url') ? option('--url') : 'http://127.0.0.1:5174/';
const output = path.resolve('.runtime/benchmarks/mobile-ui'); mkdirSync(output, { recursive: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
const page = await context.newPage();
const errors = [], turns = [], sockets = [], commands = [];
let refreshes = 0;
page.on('pageerror', error => errors.push(error.message));
const session = () => ({ user_id: 'ui-regression', access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_at: Date.now() / 1000 + 900, config: {} });
await page.route('**/v1/activate', route => route.fulfill({ json: session() }));
await page.route('**/v1/refresh', route => { refreshes++; return route.fulfill({ json: session() }); });
await page.route('**/v1/logout', route => route.fulfill({ json: { ok: true } }));
function emit(socket, command, type, extra = {}) {
  socket.send(JSON.stringify({ protocol_version: 1, type, generation_id: command.generation_id, conversation_id: command.conversation_id, turn_id: command.turn_id, ...extra }));
}
function reply(socket, command, suffix = '1', audio = false) {
  const id = command.turn_id + suffix;
  emit(socket, command, 'utterance.ready', { utterance_id: id, speech_ja: 'ここにいるよ。', expression: '休闲', audio_enabled: audio });
  emit(socket, command, 'subtitle.ready', { utterance_id: id, display_zh: `回复：${command.text}${suffix}` });
  if (audio) {
    const pcm = Buffer.alloc(6400);
    for (let index = 0; index < 3200; index++) pcm.writeInt16LE(Math.sin(index / 12) * 2000, index * 2);
    const metadata = Buffer.from(JSON.stringify({ protocol_version: 1, type: 'audio.ready', generation_id: command.generation_id, conversation_id: command.conversation_id, turn_id: command.turn_id, utterance_id: id, format: 'pcm_s16le', sample_rate: 32000, channels: 1, byte_length: pcm.length, sample_count: pcm.length / 2, duration_ms: 100 }));
    const header = Buffer.alloc(4); header.writeUInt32LE(metadata.length);
    socket.send(Buffer.concat([header, metadata, pcm]));
  }
}
await page.routeWebSocket('**/v1/mobile', socket => {
  sockets.push(socket);
  socket.onMessage(raw => {
    const command = JSON.parse(String(raw)); commands.push(command);
    if (command.access_token) {
      socket.send(JSON.stringify({ protocol_version: 1, type: 'gateway.ready' }));
      socket.send(JSON.stringify({ protocol_version: 1, type: 'service.state', service: 'tts', state: 'ready' }));
    }
    if (command.type === 'ping') socket.send(JSON.stringify({ protocol_version: 1, type: 'pong' }));
    if (command.type !== 'turn.start') return;
    turns.push(command);
    emit(socket, command, 'task.state', { state: 'thinking' });
    if (command.text === '等待取消') return;
    if (command.text === '请求被拒绝') {
      emit(socket, command, 'error', { source: 'turn', message: '测试：请求被拒绝' });
      emit(socket, command, 'task.state', { state: 'failed' });
      return;
    }
    reply(socket, command, '1', command.text === '音频检查');
    if (command.text === '两句') reply(socket, command, '2');
    emit(socket, command, 'task.state', { state: 'idle' });
  });
});
const menu = () => page.getByLabel('打开菜单');
const closeMenu = () => page.locator('.drawer').getByLabel('关闭', { exact: true }).click();
async function send(text) {
  await page.getByRole('textbox', { name: '消息', exact: true }).fill(text);
  await page.getByLabel('发送', { exact: true }).click();
}
async function settled() { await page.waitForFunction(() => !document.querySelector('.stop-button'), null, { timeout: 20000 }); }
async function noOverflow() {
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.composer, .topbar, .drawer')].every(element => element.getBoundingClientRect().right <= innerWidth + 1)), true);
}
try {
  await page.goto(address);
  if (new URL(address).port === '5174') {
    const runtimeChecks = await page.evaluate(async () => {
      const { LocalRuntime } = await import('/src/localRuntime.ts');
      const events = [];
      const runtime = new LocalRuntime(event => events.push(event));
      const check = (value, label) => { if (!value) throw new Error(label); };
      await runtime.initialize();
      const originalSnapshot = events.find(event => event.type === 'history.ready');
      const first = await runtime.start('未听到的回复不能进入上下文');
      runtime.receive({ ...first, protocol_version: 1, type: 'utterance.ready', utterance_id: 'unheard', speech_ja: '聞こえないよ。' });
      runtime.cancel();
      check(!runtime.receive({ ...first, protocol_version: 1, type: 'utterance.ready', utterance_id: 'late', speech_ja: '遅れたよ。' }), 'late packet entered runtime');
      const second = await runtime.start('继续');
      check(!second.messages.some(message => message.role === 'assistant'), 'unheard speech entered model context');
      check(originalSnapshot.history.length === 0, 'snapshot mutated after emission');
      const incoming = { ...second, protocol_version: 1, type: 'utterance.ready', utterance_id: 'heard', speech_ja: 'ここにいるよ。' };
      runtime.receive(incoming); runtime.receive(incoming);
      runtime.receive({ ...incoming, type: 'subtitle.ready', display_zh: '我在这里。' });
      runtime.playback({ ...incoming, type: 'playback.started' });
      runtime.playback({ ...incoming, type: 'playback.ended', played_samples: 3200, total_samples: 3200 });
      const third = await runtime.start('再继续');
      check(third.messages.filter(message => message.role === 'assistant').length === 1, 'deduplication or heard context failed');
      await runtime.command({ type: 'settings.update', settings: { companion_ui: { theme: 'paper' } } });
      await runtime.command({ type: 'settings.update', settings: { companion_ui: { primary_language: 'ja' } } });
      const settingsEvent = events.filter(event => event.type === 'settings.ready').at(-1);
      check(settingsEvent.settings.companion_ui.theme === 'paper', 'nested settings overwritten');
      await runtime.command({ type: 'settings.update', settings: { character: 'ayana-su', avatar_costume: '白色校服' } });
      const blackOnly = events.filter(event => event.type === 'settings.ready').at(-1).settings;
      check(blackOnly.character === 'ayana' && blackOnly.avatar_costume === '校服', 'white Ayana enabled despite mobile restriction');
      const oldConversation = third.conversation_id;
      await runtime.command({ type: 'conversation.create' });
      check(!runtime.receive({ ...incoming, generation_id: runtime.generation }), 'old topic packet accepted');
      const fresh = await runtime.start('新话题');
      check(!fresh.messages.some(message => message.role === 'assistant'), 'topic context leaked');
      await runtime.command({ type: 'conversation.select', conversation_id: oldConversation });
      await runtime.command({ type: 'memory.set', text: '喜欢咖啡\n喜欢咖啡\n安静' });
      await runtime.command({ type: 'settings.update', settings: { volume: NaN } });
      check(events.filter(event => event.type === 'settings.ready').at(-1).settings.volume === 1, 'invalid volume not sanitized');
      const restoredEvents = [];
      const restored = new LocalRuntime(event => restoredEvents.push(event));
      await restored.initialize();
      check(restoredEvents.find(event => event.type === 'settings.ready').settings.companion_ui.theme === 'paper', 'settings not persisted');
      check((await restored.exportConversation()).history.some(item => item.utterance_id === 'heard'), 'displayed history not persisted');
      await restored.command({ type: 'conversation.delete', conversation_id: oldConversation });
      check(!(await restored.exportConversation()).history.some(item => item.utterance_id === 'heard'), 'deleted topic remained selected');
      return 13;
    });
    console.log(JSON.stringify({ runtimeChecks }));
  }
  await page.getByLabel('激活码', { exact: true }).fill('synthetic-key');
  await page.locator('button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('.topbar-title')?.textContent.includes('已连接'));
  await page.waitForFunction(() => document.querySelector('.portrait')?.naturalWidth > 0);
  await noOverflow();
  await page.screenshot({ path: path.join(output, 'phone-home.png') });
  await send('第一轮'); await settled();
  await send('第二轮'); await settled();
  assert.deepEqual(await page.locator('.transcript-inner > .message, .transcript-inner > .speech-line').allTextContents(), ['你第一轮', '回复：第一轮1', '你第二轮', '回复：第二轮1']);
  assert.ok(turns[1].messages.some(message => message.role === 'assistant'));
  await send('两句'); await settled();
  assert.ok(await page.getByText('回复：两句2', { exact: true }).count());
  await send('音频检查'); await settled();
  assert.ok(commands.some(command => command.type === 'audio.consumed'));
  // Cancel before the gateway reply. Even deliberately late events must remain invisible.
  await send('等待取消');
  await page.getByLabel('打断', { exact: true }).click();
  reply(sockets.at(-1), turns.at(-1), 'late');
  emit(sockets.at(-1), turns.at(-1), 'task.state', { state: 'thinking' });
  await page.waitForTimeout(1000);
  assert.equal(await page.getByText('回复：等待取消late', { exact: true }).count(), 0);
  assert.equal(await page.locator('.stop-button').count(), 0);
  await send('取消后恢复'); await settled();
  assert.ok(!turns.at(-1).messages.some(message => message.content.includes('等待取消late')));
  const beforeDouble = turns.length;
  await page.getByLabel('消息', { exact: true }).fill('快速双击');
  await page.locator('.send-button').evaluate(button => { button.click(); button.click(); });
  await settled();
  assert.equal(turns.length, beforeDouble + 1);
  await send('请求被拒绝'); await settled();
  await page.locator('.turn-failed').waitFor();
  await send('错误后恢复'); await settled();
  assert.equal(await page.locator('.turn-failed').count(), 0);
  // Browser online/offline events must update both the socket and the UI state.
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.waitForFunction(() => document.querySelector('.topbar-title')?.textContent.includes('暂时离线'));
  await page.getByLabel('消息', { exact: true }).fill('断网保留');
  assert.equal(await page.locator('.send-button').isDisabled(), true);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => document.querySelector('.topbar-title')?.textContent.includes('已连接'));
  assert.equal(await page.getByLabel('消息', { exact: true }).inputValue(), '断网保留');
  // A server-side 4401 must force refresh even if the stored expiry is in the future.
  sockets.at(-1).close({ code: 4401, reason: 'test access revocation' });
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => document.querySelector('.topbar-title')?.textContent.includes('已连接'));
  assert.ok(refreshes > 0);
  // Drafts survive both reload and topic switches.
  await page.getByLabel('消息', { exact: true }).fill('没有发出的草稿');
  await page.reload(); await menu().waitFor();
  await page.waitForFunction(() => document.querySelector('.composer textarea')?.value === '没有发出的草稿');
  await menu().click();
  await page.getByLabel('称呼', { exact: true }).fill('回归用户');
  await page.getByLabel('本机记忆（每行一条）').fill('喜欢安静的咖啡店');
  await page.getByRole('button', { name: '主题：苔绿', exact: true }).click();
  await page.getByLabel('对白语言', { exact: true }).selectOption('ja');
  await page.getByLabel('翻译语言', { exact: true }).selectOption('zh');
  await page.waitForTimeout(750);
  await page.screenshot({ path: path.join(output, 'phone-settings.png') });
  await closeMenu();
  assert.equal(await page.locator('.app').evaluate(element => getComputedStyle(element).getPropertyValue('--bubble-ink').trim()), '#252a2b');
  await menu().click();
  await page.locator('.new-conversation').click();
  assert.equal(await page.getByLabel('消息', { exact: true }).inputValue(), '');
  await menu().click();
  await page.getByLabel('搜索话题').fill('第一轮');
  await page.locator('.conversation-list button').first().click();
  await page.waitForFunction(() => document.querySelector('.composer textarea')?.value === '没有发出的草稿');
  await menu().click();
  await page.getByLabel('搜索话题').fill('');
  await page.getByLabel('重命名当前话题').fill('更好的日常');
  await page.getByRole('button', { name: '改名', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.topbar-title strong')?.textContent === '更好的日常');
  await closeMenu();
  await page.reload(); await menu().click();
  assert.equal(await page.getByLabel('称呼', { exact: true }).inputValue(), '回归用户');
  assert.equal(await page.getByLabel('本机记忆（每行一条）').inputValue(), '喜欢安静的咖啡店');
  assert.equal(await page.getByLabel('对白语言', { exact: true }).inputValue(), 'ja');
  assert.equal(await page.getByLabel('角色', { exact: true }).textContent(), '彩名 · 黑制服');
  assert.equal(await page.locator('select[aria-label=角色]').count(), 0);
  await closeMenu();
  await page.waitForFunction(() => document.querySelector('.portrait')?.naturalWidth > 0);
  // Focus returns to the menu and Escape closes the modal.
  await menu().click(); await page.keyboard.press('Escape');
  await page.waitForSelector('.drawer', { state: 'detached' });
  assert.equal(await menu().evaluate(element => element === document.activeElement), true);
  for (const [width, height] of [[320, 568], [360, 640], [430, 932], [844, 390], [768, 1024]]) {
    await page.setViewportSize({ width, height });
    await noOverflow();
    await menu().click(); await noOverflow();
    await page.screenshot({ path: path.join(output, `settings-${width}x${height}.png`) });
    await closeMenu();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  // Floating companion reuses the existing runtime, history and audio consumer.
  const floatingSockets = sockets.length;
  await menu().click();
  await page.getByRole('button', { name: '预览悬浮便签', exact: true }).click();
  await page.locator('.floating-note').waitFor();
  await page.setViewportSize({ width: 340, height: 440 });
  await page.getByLabel('悬浮窗消息', { exact: true }).fill('悬浮窗对话');
  await page.getByLabel('发送悬浮窗消息', { exact: true }).click();
  await page.getByText('回复：悬浮窗对话1', { exact: true }).waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(output, 'floating-companion.png') });
  assert.equal(sockets.length, floatingSockets, 'Floating mode opened a second socket');
  await page.getByLabel('悬浮窗消息', { exact: true }).fill('悬浮窗草稿');
  await page.getByLabel('收起悬浮窗', { exact: true }).click();
  await page.locator('.floating-mini').waitFor();
  await page.getByLabel('展开悬浮窗', { exact: true }).click();
  await page.locator('.floating-note').waitFor();
  assert.equal(await page.getByLabel('悬浮窗消息', { exact: true }).inputValue(), '悬浮窗草稿');
  await page.getByLabel('返回主界面', { exact: true }).click();
  await page.locator('.app').waitFor();
  assert.equal(await page.getByLabel('消息', { exact: true }).inputValue(), '悬浮窗草稿');
  assert.equal(await page.locator('.transcript').getByText('回复：悬浮窗对话1', { exact: true }).count(), 1);
  await page.setViewportSize({ width: 390, height: 844 });
  // Scrollback stays where the reader placed it, then the latest button restores it.
  await page.evaluate(() => { const element = document.querySelector('.transcript'); element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
  if (await page.locator('.jump-latest').count()) await page.locator('.jump-latest').click();
  // Delete is explicitly confirmed and a new empty topic remains usable.
  await menu().click();
  await page.getByRole('button', { name: '删除话题', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.delete-confirm'));
  await closeMenu();
  await send('删除后新话题'); await settled();
  assert.equal(turns.at(-1).messages.some(message => message.content.includes('第一轮')), false);
  // Simulate a severed socket and wait for a fresh authenticated connection.
  const before = sockets.length;
  sockets.at(-1).close({ code: 1001, reason: 'test connection loss' });
  await page.waitForFunction(() => document.querySelector('.topbar-title')?.textContent.includes('已连接'), null, { timeout: 10000 });
  await page.waitForTimeout(1000);
  assert.ok(sockets.length > before);
  await send('重连后'); await settled();
  assert.ok(commands.filter(command => command.type).every(command => ['turn.start', 'generation.cancel', 'audio.consumed', 'ping'].includes(command.type)));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, turns: turns.length, responsiveSizes: 5, errors, screenshots: output }));
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png') });
  console.error(JSON.stringify({ errors, turns: turns.length, ui: (await page.locator('body').innerText()).slice(-3500) }));
  throw error;
} finally { await browser.close(); }
