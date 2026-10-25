/** Headless mobile PWA smoke test. Requires Playwright and an installed Chrome. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const require = createRequire(import.meta.url);
const playwrightRoot = option('--playwright-root') || root;
let playwright;
try {
  playwright = require(require.resolve('playwright', { paths: [playwrightRoot] }));
} catch {
  playwright = require(require.resolve('playwright-core', { paths: [playwrightRoot] }));
}
const { chromium } = playwright;

const url = option('--url') || 'http://127.0.0.1:17321/m/';
const token = option('--token') || process.env.AYANA_MOBILE_TOKEN;
const executable = option('--executable');
const screenshot = option('--screenshot') || path.join(root, '.runtime/benchmarks', `mobile-${Date.now()}.png`);
assert.ok(token, 'Pass --token or set AYANA_MOBILE_TOKEN');
mkdirSync(path.dirname(screenshot), { recursive: true });

const browser = await chromium.launch({
  headless: true,
  ...(executable ? { executablePath: executable } : { channel: 'chrome' }),
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const page = await context.newPage();
const errors = [];
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('pageerror', error => errors.push(String(error)));

try {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.pair-card', { timeout: 15000 });
  await page.fill('#mobile-token', token);
  await page.click('button[type=submit]');
  await page.waitForSelector('.app', { timeout: 20000 });
  await page.waitForFunction(() => document.body.innerText.includes('已连接'), null, { timeout: 20000 });
  await page.fill('.composer textarea', '你好');
  await page.click('.send-button');
  await page.waitForSelector('.speech-line, .message.assistant', { timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: screenshot, fullPage: false });
  assert.deepEqual(errors, [], `Console errors: ${errors.join(' | ')}`);
  console.log(`PASS: ${url}`);
  console.log(`screenshot: ${screenshot}`);
} finally {
  await browser.close();
}
