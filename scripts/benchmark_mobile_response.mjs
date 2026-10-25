/** Real model/SoVITS timing with synthetic prompts and an ephemeral activation in env. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const option = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name)+1] : fallback;
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright-core', { paths: [option('--playwright-root', process.cwd())] }));
const code = process.env.AYANA_LATENCY_ACTIVATION;
assert.ok(code, 'Provide an ephemeral test activation in AYANA_LATENCY_ACTIVATION');
const origin = JSON.parse(Buffer.from(code.split('.')[1], 'base64url')).url;
const output = path.resolve(option('--output', '.runtime/benchmarks/mobile-response-live'));
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: option('--browser', 'C:/Program Files/Google/Chrome/Application/chrome.exe'), args: ['--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] });
const report = [];
try {
  for (const [name, root] of [['before', option('--baseline', '.runtime/benchmarks/mobile-speed-baseline-web')], ['after', option('--current', 'apps/mobile/dist')]]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = []; let active;
    const failed = [];
    page.on('requestfailed', request => failed.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }));
    page.on('pageerror', error => errors.push(error.message));
    await page.route(origin+'/**', async route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== 'GET' || url.pathname.startsWith('/v1/')) return route.continue();
      const file = path.resolve(root, '.'+(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(path.resolve(root)+path.sep) || !existsSync(file)) return route.continue();
      return route.fulfill({ path: file });
    });
    page.on('websocket', socket => {
      socket.on('framesent', ({ payload }) => {
        let value; try { value = JSON.parse(String(payload)); } catch { return; }
        if (value.type === 'turn.start') { active = { mode: name, turn: value.turn_id, start: Date.now(), speechCount: 0, audioCount: 0, consumed: 0 }; }
        if (value.type === 'audio.consumed' && active) { active.consumed++; active.firstPlaybackEndMs ??= Date.now()-active.start; }
      });
      socket.on('framereceived', ({ payload }) => {
        if (!active) return;
        if (typeof payload !== 'string') { active.audioCount++; active.firstAudioMs ??= Date.now()-active.start; return; }
        const value=JSON.parse(payload);
        if (value.type === 'error') errors.push(value.code || value.message);
        if (value.turn_id !== active.turn) return;
        if (value.type === 'utterance.ready') { active.speechCount++; active.firstSpeechMs ??= Date.now()-active.start; active.firstSpeechCharacters ??= value.speech_ja.length; }
        if (value.type === 'subtitle.ready') active.firstTranslationMs ??= Date.now()-active.start;
      });
    });
    await page.goto(origin+'/', { waitUntil: 'domcontentloaded' });
    await page.getByLabel('激活码', { exact: true }).fill(code);
    await page.locator('button[type=submit]').click();
    try { await page.waitForFunction(() => document.querySelector('.topbar-title .status-dot')?.classList.contains('is-on')); }
    catch (error) { console.error(JSON.stringify({ mode: name, failed, errors, ui: (await page.locator('body').innerText()).slice(0,1000) })); throw error; }
    for (const [index, prompt] of ['今天有点累，陪我聊两句吧。','我准备睡觉了，跟我说两句晚安吧。','明天有一点紧张，鼓励我两句吧。'].entries()) {
      if (index) { await page.getByLabel('打开菜单').click(); await page.locator('.new-conversation').click(); }
      await page.getByLabel('消息', { exact: true }).fill(prompt);
      await page.getByLabel('发送', { exact: true }).click();
      await page.locator('.speech-main').first().waitFor({ timeout: 90000 });
      active.firstVisibleMs = Date.now()-active.start;
      await page.waitForFunction(() => !document.querySelector('.stop-button'), null, { timeout: 90000 });
      assert.ok(active.speechCount > 0 && active.audioCount === active.speechCount && active.consumed === active.audioCount);
      const { start, ...record } = active; report.push(record); console.log(JSON.stringify(record));
      assert.deepEqual(errors, []);
    }
    await context.close();
  }
} finally {
  writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
