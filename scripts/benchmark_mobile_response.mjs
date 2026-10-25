/** Real model/SoVITS timing with synthetic prompts and an ephemeral activation in env. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
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
  for (const [name, address] of [['before', option('--before-url', 'http://127.0.0.1:4176/')], ['after', option('--after-url', 'http://127.0.0.1:4175/')]]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    await context.addInitScript(() => {
      const NativeSocket = window.WebSocket;
      window.WebSocket = class extends NativeSocket {
        send(value) {
          if (typeof value === 'string') {
            try { if (JSON.parse(value).type === 'turn.start') window.__responseTiming = { start: performance.now() }; } catch {}
          }
          return super.send(value);
        }
      };
      new MutationObserver(() => {
        const timing = window.__responseTiming;
        if (timing && timing.visible === undefined && document.querySelector('.speech-main')?.textContent.trim()) timing.visible = performance.now()-timing.start;
      }).observe(document, { childList: true, subtree: true, characterData: true });
      const NativeWorklet = window.AudioWorkletNode;
      if (NativeWorklet) window.AudioWorkletNode = class extends NativeWorklet {
        constructor(...args) {
          super(...args);
          this.port.addEventListener('message', ({ data }) => {
            const timing = window.__responseTiming;
            if (data.type === 'started' && timing && timing.playback === undefined) timing.playback = performance.now()-timing.start;
          });
          this.port.start();
        }
      };
    });
    const page = await context.newPage();
    const errors = []; let active;
    const failed = [];
    page.on('requestfailed', request => failed.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }));
    page.on('pageerror', error => errors.push(error.message));
    // The two static versions use separate loopback ports. Only activation needs
    // an origin shim; model, audio and consumption frames use the real gateway WS.
    await page.route(origin+'/v1/activate', async route => {
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      const response = await route.fetch();
      return route.fulfill({ response, headers: { ...response.headers(), ...headers } });
    });
    page.on('websocket', socket => {
      failed.push({ socket: socket.url() });
      socket.on('socketerror', error => failed.push({ socketError: String(error) }));
      socket.on('close', () => failed.push({ socketClosed: true }));
      socket.on('framesent', ({ payload }) => {
        let value; try { value = JSON.parse(String(payload)); } catch { return; }
        if (value.access_token) failed.push({ authenticated: true });
        if (value.type === 'turn.start') { active = { mode: name, turn: value.turn_id, start: Date.now(), speechCount: 0, audioCount: 0, consumed: 0 }; }
        if (value.type === 'audio.consumed' && active) { active.consumed++; active.firstPlaybackEndMs ??= Date.now()-active.start; }
      });
      socket.on('framereceived', ({ payload }) => {
        if (typeof payload === 'string' && !active) failed.push({ initialEvent: JSON.parse(payload).type });
        if (!active) return;
        if (typeof payload !== 'string') { active.audioCount++; active.firstAudioMs ??= Date.now()-active.start; return; }
        const value=JSON.parse(payload);
        if (value.type === 'error') errors.push(value.code || value.message);
        if (value.turn_id !== active.turn) return;
        if (value.type === 'utterance.ready') { active.speechCount++; active.firstSpeechMs ??= Date.now()-active.start; active.firstSpeechCharacters ??= value.speech_ja.length; }
        if (value.type === 'subtitle.ready') active.firstTranslationMs ??= Date.now()-active.start;
      });
    });
    await page.goto(address, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('激活码', { exact: true }).fill(code);
    await page.locator('button[type=submit]').click();
    try { await page.waitForFunction(() => document.querySelector('.topbar-title .status-dot')?.classList.contains('is-on')); }
    catch (error) { console.error(JSON.stringify({ mode: name, failed, errors, ui: (await page.locator('body').innerText()).slice(0,1000) })); throw error; }
    for (const [index, prompt] of ['今天有点累，陪我聊两句吧。','我准备睡觉了，跟我说两句晚安吧。','明天有一点紧张，鼓励我两句吧。'].slice(0, Number(option('--turns', '3'))).entries()) {
      if (index) { await page.getByLabel('打开菜单').click(); await page.locator('.new-conversation').click(); await page.waitForTimeout(150); }
      await page.getByLabel('消息', { exact: true }).fill(prompt);
      try { await page.getByLabel('发送', { exact: true }).click(); }
      catch (error) { console.error(JSON.stringify({ mode: name, failed, errors, ui: (await page.locator('body').innerText()).slice(-1000), draftLength: (await page.getByLabel('消息', { exact: true }).inputValue()).length })); throw error; }
      await page.locator('.speech-main').first().waitFor({ timeout: 90000 });
      active.firstVisibleMs = Math.round(await page.evaluate(() => window.__responseTiming.visible));
      await page.waitForFunction(() => !document.querySelector('.stop-button'), null, { timeout: 90000 });
      active.firstPlaybackStartMs = Math.round(await page.evaluate(() => window.__responseTiming.playback));
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
