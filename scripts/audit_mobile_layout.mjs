/** Typography/layout stress audit. Synthetic local data only; never contacts a model. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const option = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright-core', { paths: [option('--playwright-root', process.cwd())] }));
const browser = await chromium.launch({ headless: true, executablePath: option('--browser', 'C:/Program Files/Google/Chrome/Application/chrome.exe'), args: ['--no-proxy-server'] });
const output = path.resolve(option('--output', '.runtime/benchmarks/mobile-typography'));
mkdirSync(output, { recursive: true });
const address = option('--url', 'http://127.0.0.1:5174/');
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block', reducedMotion: 'reduce' });
const page = await context.newPage();
const errors = [], cases = [], problems = [];
page.on('pageerror', error => errors.push(error.message));
await page.routeWebSocket('**/v1/mobile', socket => socket.onMessage(raw => {
  const value = JSON.parse(String(raw));
  if (value.access_token) {
    socket.send(JSON.stringify({ protocol_version: 1, type: 'gateway.ready' }));
    socket.send(JSON.stringify({ protocol_version: 1, type: 'service.state', service: 'tts', state: 'failed' }));
  }
  if (value.type === 'ping') socket.send(JSON.stringify({ type: 'pong', protocol_version: 1 }));
}));
const mainText = '今天也辛苦了。先慢慢呼吸，再喝一口水，不必急着把所有事情一次做好。我们可以从最小的一件事开始，我会在这里陪你。';
const japanese = '今日もおつかれさま。ゆっくり息をして、お水を飲んでね。急がなくても大丈夫だから、ここで一緒にひと休みしよう。';
const english = 'A long continuous address or identifier must wrap without widening the card: ' + 'https://example.test/VeryLongUnbrokenTextWithoutSpaces'.repeat(4);
async function seed() {
  await page.goto(address);
  await page.evaluate(async ({ mainText, japanese, english }) => {
    const { writeLocal } = await import('/src/storage.ts');
    await writeLocal('web-session', JSON.stringify({ gateway: location.origin, user_id: 'layout-audit', access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_at: Date.now() / 1000 + 900, config: {} }));
    const cid = 'layout-topic';
    await writeLocal('runtime:layout-audit', {
      settings: { character: 'ayana', avatar_costume: '校服', volume: 1, user_name: '正在认真生活的你', companion_ui: { theme: 'ink', primary_language: 'zh', translation_language: 'ja' } },
      conversations: [{ conversation_id: cid, title: '一个很长很长的话题名称：关于生活、工作，还有最近慢慢变好的心情', preview: '有标点的长标题应该省略显示，并保留点击区域。', updated: Date.now() }],
      current: cid, generation: 20, memory: ['喜欢安静的咖啡店', '周末想去海边走走'], history: { [cid]: [
        { id: 1, role: 'user', text: '今天有点累。\n也想聊聊明天该怎么安排。', turn_id: 'a1' },
        { id: 2, role: 'assistant', utterance_id: 'a2', speech_ja: japanese, display_zh: mainText, displayed: true, status: 'played', turn_id: 'a1' },
        { id: 3, role: 'user', text: english, turn_id: 'a3' },
        { id: 4, role: 'assistant', utterance_id: 'a4', speech_ja: japanese, display_zh: mainText.repeat(3) + '\n一家人 👨‍👩‍👧‍👦 和 café、A\u0301、こんにちは。', displayed: true, status: 'played', turn_id: 'a3' },
      ] },
    });
  }, { mainText, japanese, english });
  await page.reload();
  await page.locator('.topbar').waitFor();
  await page.waitForFunction(() => document.querySelector('.portrait')?.naturalWidth > 0);
}
async function inspect(name, { strict = true } = {}) {
  await page.waitForTimeout(100);
  const result = await page.evaluate(() => {
    const viewport = { width: innerWidth, height: visualViewport?.height || innerHeight };
    const selector = '.topbar, .composer, .composer-area, .drawer, .drawer > header, .drawer-scroll, .floating-note, .floating-heading, .floating-composer, .floating-caption';
    const bounds = [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length).map(element => {
      const box = element.getBoundingClientRect();
      return { name: element.className, x: box.x, y: box.y, width: box.width, height: box.height, overflowX: element.scrollWidth > element.clientWidth + 2, scroll: element.scrollHeight > element.clientHeight + 2 };
    });
    const small = [...document.querySelectorAll('p, label, small, .field-hint, .composer-hint, .floating-thinking')].filter(element => element.getClientRects().length && !element.closest('[inert]')).map(element => ({ tag: element.tagName, text: element.textContent.slice(0, 55), size: parseFloat(getComputedStyle(element).fontSize) })).filter(item => item.size < 12);
    const inputs = [...document.querySelectorAll('textarea')].filter(element => element.getClientRects().length).map(element => ({ label: element.getAttribute('aria-label'), height: element.clientHeight, scrollHeight: element.scrollHeight, font: getComputedStyle(element).fontSize }));
    return { viewport, bounds, small, inputs, pageOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
  });
  const bad = result.bounds.filter(box => box.overflowX || box.x < -1 || box.x + box.width > result.viewport.width + 1);
  if (result.pageOverflow || bad.length || result.small.length) problems.push({ name, pageOverflow: result.pageOverflow, bad, small: result.small });
  cases.push({ name, ...result });
  await page.screenshot({ path: path.join(output, name + '.png') });
  if (strict && process.argv.includes('--strict')) assert.ok(!result.pageOverflow && !bad.length && !result.small.length, `${name}: layout/typography issue`);
}
try {
  await seed();
  for (const [width, height] of [[320,568], [390,844], [430,932], [844,390]]) {
    await page.setViewportSize({ width, height });
    await inspect(`main-${width}x${height}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('打开菜单').click();
  await inspect('settings-top');
  await page.getByLabel('对白语言', { exact: true }).scrollIntoViewIfNeeded();
  await inspect('settings-language');
  await page.getByLabel('本机记忆（每行一条）').scrollIntoViewIfNeeded();
  await inspect('settings-memory');
  await page.getByRole('button', { name: '预览悬浮便签' }).click();
  for (const [width, height] of [[260,300], [300,360], [340,440], [390,520]]) {
    await page.setViewportSize({ width, height });
    await inspect(`floating-${width}x${height}`);
  }
  await page.setViewportSize({ width: 340, height: 440 });
  if (await page.getByRole('button', { name: '展开全文', exact: true }).count()) {
    await page.getByRole('button', { name: '展开全文', exact: true }).click();
    await inspect('floating-expanded-long');
    const text = page.locator('.floating-caption');
    await text.evaluate(element => element.scrollTop = element.scrollHeight);
    await inspect('floating-expanded-tail');
    await page.getByRole('button', { name: '收起全文', exact: true }).click();
  }
  await page.getByLabel('悬浮窗消息', { exact: true }).fill('这是一条较长的输入消息。\n第二行文字应该完整显示。\n第三行也不能遮住发送按钮。');
  await inspect('floating-multiline-input');
  await page.setViewportSize({ width: 340, height: 250 });
  await page.locator('html').evaluate(element => element.classList.add('keyboard-open'));
  await inspect('floating-keyboard-height');
  await page.setViewportSize({ width: 320, height: 568 });
  await page.locator('html').evaluate(element => { element.classList.remove('keyboard-open'); element.style.fontSize = '24px'; });
  await inspect('floating-text-150');
  await page.getByLabel('返回主界面', { exact: true }).click();
  await inspect('main-text-150');
  await page.getByLabel('打开菜单').click();
  await inspect('settings-text-150');
  await page.locator('html').evaluate(element => element.style.fontSize = '32px');
  await inspect('settings-text-200');
  await page.locator('.drawer').getByLabel('关闭', { exact: true }).click();
  await inspect('main-text-200');
  assert.deepEqual(errors, []);
} finally {
  writeFileSync(path.join(output, 'report.json'), JSON.stringify({ errors, problems, cases }, null, 2));
  console.log(JSON.stringify({ cases: cases.length, problemCases: problems.length, errors, output }));
  await browser.close();
}
