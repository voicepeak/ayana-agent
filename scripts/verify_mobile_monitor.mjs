/** Browser checks use synthetic API responses; no gateway conversations or TTS jobs. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const option = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright-core', { paths: [option('--playwright-root', process.cwd())] }));
const output = path.resolve(option('--output', '.runtime/benchmarks/mobile-monitor'));
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ executablePath: option('--browser', 'C:/Program Files/Google/Chrome/Application/chrome.exe'), headless: true, args: ['--no-proxy-server'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
const now = Date.now() / 1000;
let authorized = false, snapshotRequests = 0;
const users = [
  { id: 'one', label: '测试者 01 · iPhone', enabled: true, activated_devices: 1 },
  { id: 'two', label: '测试者 02 · Android', enabled: true, activated_devices: 1 },
];
function turn(id, uid, start, extra = {}) {
  return { id, user_id: uid, conversation_id: `topic-${uid}`, started_at: start, last_at: start + 3, text: '今天发现了一件小小的好事。',
    status: 'complete', severity: 'good', model_state: 'complete', age_seconds: now - start, first_text_ms: 1040,
    translation_ms: 1260, first_audio_ms: 2850, model_ms: 1400,
    speeches: [{ id: id + 's', ja: 'その小さな発見、聞かせて。', zh: '说说那个小小的发现吧。', audio_enabled: true, at: start + 1, audio: { synthesis_ms: 1590, duration_ms: 2800 } }],
    audio_expected: 1, audio_completed: 1, errors: [], event_count: 5, record_incomplete: false, ...extra };
}
const turns = [
  turn('failure', 'one', now - 500, { status: 'failed', severity: 'error', model_state: 'failed', first_audio_ms: null, first_text_ms: null, translation_ms: null,
    text: '<img src=x onerror="window.pwned=true"> 这个昵称为什么没有回复？', speeches: [], audio_expected: 0, audio_completed: 0,
    errors: [{ type: 'model.failed', code: 'invalid_model_repair', at: now - 498 }] }),
  turn('slow', 'two', now - 200, { status: 'slow_audio', severity: 'warning', first_audio_ms: 6420, text: '刚才第一句等得有点久。' }),
  turn('complete', 'two', now - 90, { text: '现在听到了，陪我聊一会儿吧。' }),
  turn('pending', 'one', now - 8, { status: 'thinking', severity: 'neutral', model_state: null, first_text_ms: null, first_audio_ms: null, translation_ms: null,
    speeches: [], audio_expected: 0, audio_completed: 0, event_count: 1, text: '今天的测试刚刚开始。' }),
];
function snapshot(query) {
  snapshotRequests++;
  const user = query.get('user_id'), topic = query.get('conversation_id');
  let selected = turns.filter(turn => (!user || turn.user_id === user) && (!topic || turn.conversation_id === topic));
  const values = selected.map(turn => turn.first_audio_ms).filter(value => value != null).sort((a, b) => a - b);
  const topicMap = new Map(turns.filter(turn => !user || turn.user_id === user).map(turn => [turn.conversation_id, turn.text.slice(0, 32)]));
  const summary = { accounts: 2, requests: selected.length, failed: selected.filter(turn => turn.severity === 'error').length,
    attention: selected.filter(turn => ['error', 'warning'].includes(turn.severity)).length,
    audio_p50_ms: values.length ? values[Math.floor(values.length / 2)] : null, audio_p95_ms: values.at(-1) ?? null,
    audio_samples: values.length, completed: selected.filter(turn => ['complete', 'slow_audio'].includes(turn.status)).length };
  if (query.get('issues_only') === 'true') selected = selected.filter(turn => ['error', 'warning'].includes(turn.severity));
  return { now: now + 1, source: { logs: 'ready', gateway: 'ready', users: 'ready', last_event_at: now, pending_delivery: 0, event_limit_reached: false },
    users: users.map(user => ({ ...user, requests: turns.filter(turn => turn.user_id === user.id).length, last_request_at: now - 8,
      attention: turns.filter(turn => turn.user_id === user.id && ['error', 'warning'].includes(turn.severity)).length })),
    topics: [...topicMap].map(([id, title]) => ({ id, title })), summary,
    audio_trend: turns.filter(turn => turn.first_audio_ms != null).map(turn => ({ at: turn.started_at, id: turn.id, ms: turn.first_audio_ms })),
    turns: selected.sort((a, b) => b.started_at - a.started_at), turn_limit_reached: false, window_hours: 24,
    limitations: ['完整系统提示词和手机记忆未采集。', '合成就绪不等于实际出声。'] };
}
await page.route('**/api/**', route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/login') { authorized = true; return route.fulfill({ json: { ok: true } }); }
  if (url.pathname === '/api/logout') { authorized = false; return route.fulfill({ json: { ok: true } }); }
  if (url.pathname === '/api/session') return route.fulfill({ json: { authenticated: authorized } });
  if (!authorized) return route.fulfill({ status: 401, json: { detail: '请登录' } });
  if (url.pathname === '/api/snapshot') return route.fulfill({ json: snapshot(url.searchParams) });
  const selected = turns.find(turn => turn.id === decodeURIComponent(url.pathname.split('/').at(-1)) && turn.user_id === url.searchParams.get('user_id'));
  return route.fulfill({ json: { turn: selected, events: [{ at: selected.started_at, event: { type: 'user.message', text: selected.text } }] } });
});
async function noOverflow() { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true); }
try {
  await page.goto(option('--url', 'http://127.0.0.1:17340/') + '#token=synthetic-admin-token');
  await page.locator('#console').waitFor();
  await page.locator('.turn').first().waitFor();
  assert.equal(new URL(page.url()).hash, '');
  assert.equal(await page.locator('#request-count').innerText(), '4');
  assert.equal(await page.locator('#attention-count').innerText(), '2');
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  assert.equal(await page.locator('#turn-list img').count(), 0);
  checks.push('Authenticated console opens; fragment removed; messages render as text');
  await page.locator('[data-key="one/failure"]').click();
  assert.match(await page.locator('#error-detail').innerText(), /invalid_model_repair/);
  assert.equal(await page.locator('#follow').getAttribute('aria-pressed'), 'false');
  turns.push(turn('new-turn', 'two', now + 1, { text: '这条是刚收到的新消息。' }));
  await page.waitForFunction(() => document.querySelector('#request-count').textContent === '5');
  assert.equal(await page.locator('.turn.selected').getAttribute('data-key'), 'one/failure');
  await page.locator('#follow').click();
  assert.equal(await page.locator('.turn.selected').getAttribute('data-key'), 'two/new-turn');
  checks.push('New records appear automatically; manual inspection survives new records; follow latest resumes');
  Object.assign(turns.find(turn => turn.id === 'pending'), { status: 'tts_failed', severity: 'error', model_state: 'complete',
    errors: [{ type: 'tts.failed', code: 'RuntimeError', at: now + 2 }], event_count: 4 });
  await page.waitForFunction(() => [...document.querySelectorAll('.badge')].some(badge => badge.textContent === '语音合成失败'));
  await page.locator('[data-key="one/pending"]').click();
  assert.match(await page.locator('#detail-label').innerText(), /语音合成失败/);
  assert.match(await page.locator('#facts').innerText(), /已完成/);
  checks.push('Voice synthesis failures remain distinct from successful model generation');
  await page.locator('[data-key="two/slow"]').click();
  assert.match(await page.locator('#phases').innerText(), /6.42 s/);
  await noOverflow();
  await page.screenshot({ path: path.join(output, 'desktop-1440.png') });
  await page.locator('[data-user="two"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.turn')].every(turn => turn.dataset.key.startsWith('two/')));
  await page.locator('#issues-only').check();
  await page.waitForFunction(() => document.querySelectorAll('.turn').length === 1);
  assert.equal(await page.locator('.turn').getAttribute('data-key'), 'two/slow');
  checks.push('User and issue filters isolate the selected account and slow request');
  await page.locator('#pause').click();
  const beforePause = snapshotRequests;
  await page.waitForTimeout(2300);
  assert.equal(snapshotRequests, beforePause);
  await page.locator('#pause').click();
  await page.waitForTimeout(200);
  assert.ok(snapshotRequests > beforePause);
  const downloadWait = page.waitForEvent('download');
  await page.locator('#export').click();
  const download = await downloadWait;
  const exported = path.join(output, 'filtered-export.txt'); await download.saveAs(exported);
  const content = readFileSync(exported, 'utf8');
  assert.match(content, /刚才第一句等得有点久/); assert.ok(!content.includes('window.pwned'));
  checks.push('Pause stops panel polling; resume and filtered log export work');
  for (const [width, height] of [[980, 900], [390, 844]]) {
    await page.setViewportSize({ width, height }); await page.waitForTimeout(150); await noOverflow();
    await page.screenshot({ path: path.join(output, `responsive-${width}.png`), fullPage: true });
  }
  checks.push('Desktop, tablet and phone layouts do not overflow');
  await page.locator('#logout').click();
  await page.locator('#login').waitFor();
  assert.deepEqual(errors, []);
  checks.push('Logout returns to authentication; no page exceptions');
  const report = { passed: true, synthetic_data_only: true, checks, errors };
  writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await browser.close(); }
