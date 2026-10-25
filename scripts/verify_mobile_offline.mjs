/** Production PWA, first-visit shell caching and offline recovery; synthetic credentials only. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const option = name => process.argv[process.argv.indexOf(name) + 1];
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright-core', { paths: [option('--playwright-root')] }));
const browser = await chromium.launch({ headless: true, executablePath: option('--browser'), args: ['--no-proxy-server'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const address = process.argv.includes('--url') ? option('--url') : 'http://127.0.0.1:4175/';
const errors = []; page.on('pageerror', error => errors.push(error.message));
let offline = false;
await page.route('**/v1/activate', route => route.fulfill({ json: { user_id: 'offline-test', access_token: 'synthetic', refresh_token: 'synthetic-refresh', expires_at: Date.now() / 1000 + 900, config: {} } }));
await page.routeWebSocket('**/v1/mobile', socket => socket.onMessage(() => {
  if (!offline) socket.send(JSON.stringify({ type: 'gateway.ready', protocol_version: 1 }));
}));
try {
  await page.goto(address);
  await page.getByLabel('激活码', { exact: true }).fill('synthetic');
  await page.locator('button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('.portrait')?.naturalWidth > 0);
  await page.getByLabel('消息', { exact: true }).fill('离线也要保留的草稿');
  await page.getByLabel('打开菜单').click();
  assert.equal(await page.getByLabel('角色', { exact: true }).textContent(), '彩名 · 黑制服');
  await page.getByLabel('称呼', { exact: true }).fill('离线用户');
  await page.locator('.drawer').getByLabel('关闭', { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.portrait')?.naturalWidth > 0);
  await page.waitForFunction(async () => {
    if (!navigator.serviceWorker.controller) return false;
    const names = await fetch('precache.json').then(response => response.json());
    return (await Promise.all(names.map(name => caches.match(name)))).every(Boolean);
  });
  offline = true;
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.portrait')?.naturalWidth > 0);
  await page.waitForFunction(() => document.querySelector('.composer textarea')?.value === '离线也要保留的草稿');
  await page.getByLabel('打开菜单').click();
  assert.equal(await page.getByLabel('称呼', { exact: true }).inputValue(), '离线用户');
  await page.getByRole('button', { name: '主题：茶白', exact: true }).click();
  assert.equal(await page.locator('.app').evaluate(element => element.classList.contains('is-light')), true);
  // An uncached resource must fail; returning HTML for a missing image/script is invalid.
  assert.equal(await page.evaluate(async () => {
    try { await fetch('missing-offline-portrait.webp'); return false; } catch { return true; }
  }), true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, firstVisitOfflineShell: true, portrait: true, draft: true, settings: true, errors }));
} catch (error) {
  await page.screenshot({ path: '.runtime/benchmarks/mobile-ui/offline-failure.png' });
  console.error(JSON.stringify({ errors, body: await page.locator('body').innerText(), cache: await page.evaluate(async () => ({ keys: await caches.keys(), resources: await (await caches.open('ayana-portraits-v1')).keys().then(keys => keys.map(key => new URL(key.url).pathname)) })) }));
  throw error;
} finally { await browser.close(); }
