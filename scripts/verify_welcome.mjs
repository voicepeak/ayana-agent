/** Isolated Electron QA for the interactive MG first-run guide. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const require = createRequire(import.meta.url);
const { _electron } = require(require.resolve('playwright', { paths: [option('--playwright-root') || root] }));
const directory = path.join(root, '.runtime/benchmarks', `welcome-mg-${Date.now()}`);
const report = { checks: [], errors: [], narrationRequests: [], directory };

function createProfile(name) {
  const data = path.join(directory, name);
  mkdirSync(path.join(data, 'config'), { recursive: true });
  writeFileSync(path.join(data, 'config/local.json'), JSON.stringify({
    user_name: '', onboarding_version: 0, provider: 'openai', model: 'welcome-test', voice: { voice_mode: 'silent' }, volume: 1,
    send_screenshot: false, ambient_attention: false, hotkey: 'Control+Alt+F8', cancel_hotkey: 'Control+Alt+F9',
    talk_hotkey: 'Control+Shift+F12', companion_ui: { theme: 'ink', background_mode: 'minimal' },
    character_profiles: { 'ayana-su': { avatar_root: 'assets/ayana-su', avatar_costume: '白色校服', voice: { voice_mode: 'silent' } } },
  }));
  return data;
}

const disk = data => JSON.parse(readFileSync(path.join(data, 'config/local.json'), 'utf8'));

async function launch(data) {
  const app = await _electron.launch({
    executablePath: path.join(root, 'apps/desktop/node_modules/electron/dist/electron.exe'),
    args: [path.join(root, 'apps/desktop'), `--user-data-dir=${data}`],
    env: { ...process.env, AYANA_DATA_DIR: data, AYANA_REPOSITORY_ROOT: root, AYANA_PYTHON: path.join(root, '.venv/Scripts/python.exe'), AYANA_API_KEY: 'sk-welcome-test' },
    timeout: 30000,
  });
  let page;
  for (let i = 0; i < 300; i++) {
    page = (await app.windows()).find(item => item.url().includes('window=welcome'));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!page) throw new Error('welcome window did not open');
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('request', request => { if (/\/welcome\/.*\.wav/.test(request.url())) report.narrationRequests.push(request.url()); });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.webContents.setAudioMuted(true)));
  // Observe real browser audio scheduling without replacing its implementation.
  const observeAudio = () => {
    if (window.__welcomeSounds) return;
    window.__welcomeSounds = [];
    window.__welcomeVoiceStarts = [];
    const start = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (...args) { window.__welcomeSounds.push(args[0]); return start.apply(this, args); };
    const startBuffer = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      if (this.buffer?.duration > 1.1) window.__welcomeVoiceStarts.push(this.buffer.duration);
      if (Math.abs((this.buffer?.duration || 0) - 3) < .01) {
        window.__championStarted = performance.now();
        this.addEventListener('ended', () => { window.__championEnded = performance.now(); });
      }
      return startBuffer.apply(this, args);
    };
  };
  await page.addInitScript(observeAudio);
  await page.evaluate(observeAudio);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=welcome')).setBounds({ x: -3000, y: 0, width: 1600, height: 900 }));
  await page.waitForTimeout(300);
  return { app, page };
}

const shot = (page, name) => page.screenshot({ path: path.join(directory, `${name}.png`) });
async function layout(page) {
  assert.deepEqual(await page.locator('.mg-stage').evaluate(node => [node.scrollLeft, node.scrollTop]), [0, 0], 'Focus and animated presses must not scroll the stage');
  const clipped = await page.locator('.mg-scene').evaluate(scene => {
    const stage = scene.parentElement.getBoundingClientRect();
    return [...scene.querySelectorAll('button,input,.mg-title')].filter(node => {
      const box = node.getBoundingClientRect();
      return box.width && box.height && (box.left < stage.left - 1 || box.right > stage.right + 1 || box.top < stage.top - 1 || box.bottom > stage.bottom + 1);
    }).filter(node => !node.closest('.mg-appearance-native')).map(node => node.getAttribute('aria-label') || node.textContent);
  });
  assert.deepEqual(clipped, [], 'Scene controls and titles must stay within the visible stage');
}
async function ready(page) {
  await page.waitForFunction(() => {
    const scene = document.querySelector('.mg-scene');
    return scene && !scene.hasAttribute('inert') && !document.querySelector('.mg-cut') && scene.getAttribute('data-entrance') === 'done' && document.querySelector('.welcome')?.getAttribute('data-saving') === 'false';
  }, null, { timeout: 15000 });
  await page.waitForTimeout(180);
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.locator('.mg-kicker,.mg-sub,.mg-chapter,.mg-hint,.mg-portrait-meta,.mg-ready-note,.mg-result-note,.mg-cut-sign').count(), 0, 'Peripheral microcopy must be removed');
  assert.equal(await page.locator('.mg-main-text').count(), 0, 'Pages show only a title above the interactive content');
}

async function next(page, chapter, key) {
  await page.locator('.mg-next:not(:disabled)').waitFor();
  if (key) {
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press(key);
  } else await page.locator('.mg-next').evaluate(button => { button.click(); button.click(); button.click(); });
  await page.locator(`.mg-cut[data-cut=${chapter}]`).waitFor();
  assert.equal(await page.locator('.mg-scene').getAttribute('inert'), '');
  // Repeated activation must not queue more cuts or jump over a chapter.
  assert.equal(await page.locator('.mg-cut').count(), 1);
  const duration = await page.locator('.mg-cut').evaluate(node => parseFloat(node.style.getPropertyValue('--cut-ms')));
  assert(duration >= 3500, 'The transition leaves time to read the next feature');
  assert.equal(await page.locator('.mg-cut-description p').count(), 2);
  await page.waitForTimeout(duration * .56);
  await shot(page, `cut-${chapter}`);
  await page.locator('.mg-cut').waitFor({ state: 'detached' });
  await page.locator('.mg-scene[data-entrance=playing]').waitFor();
  await page.waitForTimeout(220);
  await shot(page, `entrance-${chapter}`);
  await ready(page);
  assert.equal(await page.locator('.welcome').getAttribute('data-chapter'), chapter);
}

async function savedLine(page, text = '设定成功。') {
  await page.waitForFunction(text => document.querySelector('.mg-character-caption')?.getAttribute('aria-label') === text && document.querySelector('.welcome')?.getAttribute('data-saving') === 'false', text);
  await page.waitForFunction(text => document.querySelector('.mg-character-caption > span')?.textContent === text, text);
}

async function waitForDisk(data, predicate, label) {
  const deadline = Date.now() + 12000;
  let last;
  while (Date.now() < deadline) {
    try { last = disk(data); if (predicate(last)) return last; } catch { /* The profile may be mid-write. */ }
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(`${label} was not saved: ${JSON.stringify(last)}`);
}

async function hidden(app) {
  await app.evaluate(({ BrowserWindow }) => new Promise((resolve, reject) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('window=welcome'));
    const deadline = Date.now() + 8000;
    const clock = setInterval(() => {
      if (!window || window.isDestroyed() || !window.isVisible()) { clearInterval(clock); resolve(true); }
      else if (Date.now() > deadline) { clearInterval(clock); reject(new Error('Welcome did not finish fading')); }
    }, 50);
  }));
}

async function recordShortcut(page, field, combo) {
  const editor = page.locator(`.mg-shortcut-editor[data-field=${field}]`);
  await editor.locator('.mg-shortcut-capture').click();
  await page.waitForFunction(field => document.querySelector(`.mg-shortcut-editor[data-field=${field}]`)?.getAttribute('data-phase') === 'recording', field);
  const parts = combo.split('+');
  for (const key of parts) await page.keyboard.down(key);
  assert.equal(await editor.locator('kbd[data-pressed=true]').count(), parts.length, 'Recorded keys light up live');
  await shot(page, `keys-${field}-held`);
  for (const key of [...parts].reverse()) await page.keyboard.up(key);
  return editor;
}

try {
  const data = createProfile('main');
  const { app, page } = await launch(data);
  try {
    await page.locator('#mg-name').waitFor({ timeout: 60000 });
    await ready(page);
    assert(await page.evaluate(() => document.fonts.check('48px "Ayana Flourish"', '你好我是彩名')), 'The bundled display font loads offline');
    assert.equal(await page.locator('.welcome').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 249, 239)');
    assert.equal(await page.locator('.mg-round').isDisabled(), true);
    await shot(page, '01-meet');
    await page.getByRole('slider', { name: '声音音量' }).fill('130');
    assert.equal(await page.getByRole('slider', { name: '声音音量' }).inputValue(), '130');
    await page.locator('#mg-name').pressSequentially('星野', { delay: 90 });
    await page.waitForFunction(() => { const button = document.querySelector('.mg-round'); return button && !button.disabled; }, null, { timeout: 60000 });
    await page.locator('#mg-name').press('Enter');
    await page.locator('.mg-next').waitFor();
    await ready(page);
    assert.equal(await page.locator('.mg-title').getAttribute('aria-label'), '星野，记住你了。');
    await savedLine(page, '记住了。以后就这么叫你。');
    assert((await page.evaluate(() => window.__welcomeVoiceStarts.length)) > 0, 'The short Ayana greeting is decoded and actually starts playing');
    assert.equal(await page.locator('.mg-portrait').evaluate(node => getComputedStyle(node).visibility), 'visible');
    assert.equal(await page.locator('.mg-portrait').evaluate(node => getComputedStyle(node).opacity), '1');
    assert.equal(disk(data).user_name, '星野');
    await shot(page, '02-greeting');
    report.checks.push('name is entered inline, saved by the backend and answered with a greeting');
    await next(page, 'chat');
    await page.locator('.mg-send').hover();
    const beforeSend = await page.evaluate(() => window.__welcomeSounds.length);
    await page.locator('.mg-send').click();
    await page.locator('.mg-feedback-flight').waitFor();
    assert(await page.locator('.mg-feedback-burst').count() > 0, 'Presses produce a visible burst');
    assert(await page.evaluate(() => window.__welcomeSounds.length) > beforeSend, 'Send has its own audible cue');
    await page.locator('.mg-bubble-ai[data-visible=true]').waitFor();
    assert.equal(await page.locator('.mg-note').getAttribute('data-sent'), 'true');
    await layout(page);
    await shot(page, '03-chat');
    report.checks.push('sending the first message is a real click; the reply arrives on the same playhead');
    await next(page, 'voice');
    for (const combo of ['A', 'Alt+Control+F8', 'Control+Alt+F9']) {
      assert.equal((await page.evaluate(combo => window.ayana.welcomeShortcutCheck('talk_hotkey', combo), combo)).ok, false);
    }
    await app.evaluate(({ globalShortcut }) => globalShortcut.register('Control+Alt+F7', () => {}));
    assert.equal((await page.evaluate(() => window.ayana.welcomeShortcutCheck('talk_hotkey', 'Control+Alt+F7'))).ok, false, 'OS registration conflicts are detected');
    await app.evaluate(({ globalShortcut }) => globalShortcut.unregister('Control+Alt+F7'));
    const unchanged = disk(data).talk_hotkey;
    const rejected = await recordShortcut(page, 'talk_hotkey', 'Control+Alt+F8');
    await rejected.locator('[role=alert]').waitFor();
    assert.equal(disk(data).talk_hotkey, unchanged, 'A duplicate chord cannot change saved settings');
    const voiceEditor = await recordShortcut(page, 'talk_hotkey', 'Control+Alt+F6');
    await page.waitForFunction(() => document.querySelector('.mg-shortcut-editor[data-field=talk_hotkey]')?.getAttribute('data-phase') === 'saved');
    assert.equal(disk(data).talk_hotkey, 'Control+Alt+F6');
    await savedLine(page);
    await voiceEditor.getByRole('button', { name: '检验按键' }).click();
    await page.waitForFunction(() => document.querySelector('.mg-shortcut-editor[data-field=talk_hotkey]')?.getAttribute('data-phase') === 'testing');
    await page.keyboard.down('Control'); await page.keyboard.down('Alt'); await page.keyboard.down('F6');
    await page.locator('.mg-voice[data-phase=holding]').waitFor();
    assert.equal(await voiceEditor.getAttribute('data-phase'), 'verified');
    await page.keyboard.up('F6'); await page.keyboard.up('Alt'); await page.keyboard.up('Control');
    await page.locator('.mg-voice-result').waitFor();
    await voiceEditor.getByRole('button', { name: '检验按键' }).click();
    await page.waitForFunction(() => document.querySelector('.mg-shortcut-editor[data-field=talk_hotkey]')?.getAttribute('data-phase') === 'testing');
    await page.keyboard.down('Control'); await page.keyboard.down('Alt'); await page.keyboard.down('F6');
    await page.locator('.mg-voice[data-phase=holding]').waitFor();
    await page.keyboard.up('F6'); await page.keyboard.up('Alt'); await page.keyboard.up('Control');
    await page.locator('.mg-voice-result').waitFor();
    // Return to idle after a successful edit so the on-screen hold is exercised too.
    await recordShortcut(page, 'talk_hotkey', 'Control+Alt+F6');
    await page.waitForFunction(() => document.querySelector('.mg-shortcut-editor[data-field=talk_hotkey]')?.getAttribute('data-phase') === 'saved');
    const hold = await page.locator('.mg-record').boundingBox();
    await page.mouse.move(hold.x + hold.width / 2, hold.y + hold.height / 2);
    await page.mouse.down();
    assert.equal(await page.locator('.mg-record').evaluate(node => getComputedStyle(node, '::before').animationName), 'mg-record-ring');
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.mg-voice').getAttribute('data-phase'), 'holding');
    await page.mouse.up();
    await page.locator('.mg-voice-result').waitFor();
    assert.match(await page.getByLabel('识别结果').inputValue(), /散步/);
    await shot(page, '04-voice');
    report.checks.push('holding the on-screen shortcut drives the waveform; release produces editable text');
    await next(page, 'search');
    await page.locator('.mg-query').click();
    await page.locator('.mg-result').first().waitFor();
    await shot(page, '05-search-results');
    await page.locator('.mg-result').first().click();
    await page.locator('.mg-search[data-phase=source]').waitFor();
    assert.equal(await page.locator('.mg-result').first().getAttribute('data-selected'), 'true');
    await shot(page, '06-search-source');
    report.checks.push('query, result fan and source selection are separate interactive beats');
    await next(page, 'observe');
    await page.locator('.mg-switch').click();
    assert.equal(await page.getByRole('switch').isChecked(), true);
    await waitForDisk(data, saved => saved.ambient_attention === true, 'ambient_attention');
    assert.equal(await page.locator('.mg-character-caption[data-visible=true]').count(), 0, 'Ordinary setting saves do not play the spoken success line');
    await shot(page, '07-observe');
    await next(page, 'outfit', 'ArrowRight');
    await next(page, 'observe', 'ArrowLeft');
    await next(page, 'outfit', 'Enter');
    await page.getByRole('button', { name: '试穿裸露' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.mg-appearance .character')].some(image => image.complete && image.naturalWidth > 0 && image.src.includes('aya_z1a0200__a0001')));
    const outfit = await waitForDisk(data, saved => saved.avatar_costume === '裸露' && saved.character === 'ayana', 'outfit');
    assert.equal(outfit.character, 'ayana', 'The wardrobe only offers Ayana costumes');
    assert.equal(outfit.avatar_costume, '裸露', 'The selected costume is saved without a spoken success line');
    assert.equal(await page.locator('.mg-character-caption[data-visible=true]').count(), 0);
    await page.waitForTimeout(500);
    await shot(page, '08-outfit');
    await next(page, 'placement', 'Enter');
    const appearance = page.locator('.mg-appearance');
    const viewport = await page.locator('.mg-appearance-viewport').boundingBox();
    const figure = await page.locator('.mg-appearance .portrait-stage').boundingBox();
    const startX = Math.min(viewport.x + viewport.width - 15, Math.max(viewport.x + 15, figure.x + figure.width * .6));
    const startY = Math.max(viewport.y + 25, figure.y + 45);
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 65, startY + 35, { steps: 12 });
    await page.mouse.up();
    await waitForDisk(data, saved => Number(saved.companion_ui?.portrait_y) !== 0, 'portrait drag');
    assert.notEqual(Number(await appearance.getAttribute('data-y')), 0, 'Dragging changes the portrait position');
    await page.getByRole('button', { name: '重置位置和大小' }).click();
    await waitForDisk(data, saved => Number(saved.companion_ui?.portrait_y) === 0 && Number(saved.companion_ui?.portrait_size) === 320, 'portrait reset');
    assert.equal(await appearance.getAttribute('data-y'), '0');
    assert.equal(await appearance.getAttribute('data-size'), '320');
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 65, startY + 35, { steps: 12 });
    await page.mouse.up();
    await waitForDisk(data, saved => Number(saved.companion_ui?.portrait_y) !== 0, 'second portrait drag');
    await page.mouse.move(startX - 65, startY + 35);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(400);
    await waitForDisk(data, saved => Number(saved.companion_ui?.portrait_size) > 320, 'portrait wheel zoom');
    const portrait = { x: Number(await appearance.getAttribute('data-x')), y: Number(await appearance.getAttribute('data-y')), size: Number(await appearance.getAttribute('data-size')) };
    assert(portrait.size > 320, 'The native portrait wheel interaction scales the preview');
    await shot(page, '09-placement');
    report.checks.push('left/right/Enter navigate without requiring each demo; outfit and placement changes persist without the spoken success line; native drag, reset and wheel zoom work at preview scale');
    await next(page, 'style');
    await page.getByRole('button', { name: '暮海 · 雾蓝' }).click();
    await waitForDisk(data, saved => saved.companion_ui?.theme === 'sea', 'theme');
    await page.waitForTimeout(800);
    await shot(page, '08-style');
    report.checks.push('the permission switch and the theme swatch are the settings themselves');
    await next(page, 'ready');
    await page.locator('.mg-ready').waitFor();
    const summonEditor = await recordShortcut(page, 'hotkey', 'Control+Shift+F7');
    await page.waitForFunction(() => document.querySelector('.mg-shortcut-editor[data-field=hotkey]')?.getAttribute('data-phase') === 'saved');
    assert.equal(disk(data).hotkey, 'Control+Shift+F7');
    await savedLine(page);
    await summonEditor.getByRole('button', { name: '检验按键' }).click();
    await page.waitForFunction(() => document.querySelector('.mg-shortcut-editor[data-field=hotkey]')?.getAttribute('data-phase') === 'testing');
    await page.keyboard.press('Control+Shift+F7');
    await page.locator('.mg-ready-stage[data-summoned=true]').waitFor();
    assert.equal(await summonEditor.getAttribute('data-phase'), 'verified');
    // The native global-shortcut path sends this receipt when Windows consumes keydown.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('window=welcome')).webContents.send('ayana:event', { protocol_version: 1, type: 'desktop.welcome-shortcut-used', field: 'hotkey', shortcut: 'Control+Shift+F7' }));
    assert.equal(await summonEditor.getAttribute('data-phase'), 'verified');
    report.checks.push('both hotkeys record live, reject invalid/duplicate/system-occupied chords, persist and respond to test presses; native shortcut receipts are handled');
    await page.getByRole('button', { name: '试试呼出彩名' }).click();
    await page.locator('.mg-ready-stage[data-summoned=true]').waitFor();
    assert.equal(await page.locator('.mg-title').getAttribute('aria-label'), '来了，我在呢。');
    await shot(page, '09-ready');
    assert((await page.evaluate(() => window.__welcomeSounds.length)) > 10, 'Web Audio foley must be scheduled by the actual interactions and cuts');
    await page.getByRole('button', { name: '静音声音', exact: true }).click();
    await page.getByRole('button', { name: '开启声音', exact: true }).waitFor();
    assert(await page.getByRole('slider', { name: '声音音量' }).isDisabled());
    await page.waitForTimeout(850);
    assert.equal(await page.locator('.mg-feedback-layer > *').count(), 0, 'Feedback particles clean themselves up');
    report.checks.push('volume slider, typing cues, send flight, press bursts, recording rings and summon rehearsal respond to real input; particles are cleaned up');
    report.checks.push('warm light stage, eight distinct page cuts with animated descriptions, inert input lock and rapid-click protection; Web Audio foley runs');
    await page.getByRole('button', { name: '开启声音', exact: true }).click();
    await page.locator('.mg-next').click();
    await page.locator('.welcome[data-leaving=true]').waitFor();
    assert.equal(await page.locator('.mg-completion').count(), 0, 'The last page dissolves without adding a completion page');
    assert.equal(await page.locator('.mg-character-caption[data-visible=true]').count(), 0, 'The ending original voice has no printed caption');
    assert.equal(await page.locator('.mg-ready').count(), 1, 'The current page is retained during the dissolve');
    await page.waitForFunction(() => window.__welcomeVoiceStarts.some(duration => Math.abs(duration - 3) < .01));
    await page.waitForTimeout(320);
    await shot(page, '10-outro-no-caption');
    const opacity = await app.evaluate(({ BrowserWindow }) => Object.fromEntries(BrowserWindow.getAllWindows()
      .filter(w => /window=(welcome|chat)/.test(w.webContents.getURL()))
      .map(w => [new URL(w.webContents.getURL()).searchParams.get('window'), w.getOpacity()])));
    assert(opacity.welcome > 0 && opacity.welcome < 1 && opacity.chat > 0 && opacity.chat < 1, JSON.stringify(opacity));
    await hidden(app);
    assert((await page.evaluate(() => window.__championEnded - window.__championStarted)) >= 2900, 'The original line completes during the fade');
    const saved = disk(data);
    assert.equal(saved.onboarding_version, 1);
    assert.equal(saved.user_name, '星野');
    assert.equal(saved.hotkey, 'Control+Shift+F7');
    assert.equal(saved.talk_hotkey, 'Control+Alt+F6');
    assert.equal(saved.ambient_attention, true);
    assert.equal(saved.companion_ui.theme, 'sea');
    assert.equal(saved.companion_ui.background_color, '#1c3042');
    assert.equal(saved.companion_ui.bubble_color, '#dce6ed');
    assert.equal(saved.character, 'ayana');
    assert.equal(saved.avatar_costume, '裸露');
    assert.equal(saved.companion_ui.portrait_x, portrait.x);
    assert.equal(saved.companion_ui.portrait_y, portrait.y);
    assert.equal(saved.companion_ui.portrait_size, portrait.size);
    report.checks.push('only shortcut changes speak the saved line; the last page dissolves for the full original 3-second game line, with no completion page or ending caption');
  } finally { await app.close(); }

  const skipped = createProfile('skip');
  const second = await launch(skipped);
  try {
    await second.page.locator('#mg-name').waitFor({ timeout: 60000 });
    // Skip immediately after reload, while the opening cut still owns pending timers.
    await second.page.reload();
    await second.page.locator('.mg-cut').waitFor();
    await second.page.getByRole('button', { name: '跳过介绍' }).click();
    assert.equal(await second.page.locator('.mg-cut').count(), 0);
    await second.page.locator('#mg-name').fill('悠');
    await second.page.waitForFunction(() => { const button = document.querySelector('.mg-round'); return button && !button.disabled; }, null, { timeout: 60000 });
    await second.page.locator('#mg-name').press('Enter');
    await second.page.locator('.welcome[data-leaving=true]').waitFor();
    await hidden(second.app);
    const saved = disk(skipped);
    assert.equal(saved.user_name, '悠');
    assert.equal(saved.onboarding_version, 1);
    report.checks.push('skip still requires a name and then completes the onboarding');
    const chat = (await second.app.windows()).find(item => item.url().includes('window=chat'));
    await chat.evaluate(() => window.ayana.openWelcome());
    await second.page.locator('.mg-cut').waitFor();
    await ready(second.page);
    assert.equal(await second.page.locator('#mg-name').inputValue(), '悠');
    // Closing during a transition must cancel the handoff and allow a fresh replay.
    await second.page.locator('#mg-name').press('Enter');
    await second.page.locator('.mg-next').waitFor();
    await second.page.locator('.mg-next').click();
    await second.page.getByRole('button', { name: '关闭初次见面' }).click();
    await second.page.waitForTimeout(1800);
    await second.page.emulateMedia({ reducedMotion: 'reduce' });
    await second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=welcome')).setBounds({ width: 900, height: 600 }));
    await chat.evaluate(() => window.ayana.openWelcome());
    await ready(second.page);
    await layout(second.page);
    assert.equal(await second.page.locator('.welcome').getAttribute('data-chapter'), 'meet');
    await second.page.locator('#mg-name').press('Enter');
    await second.page.locator('.mg-next').waitFor();
    await second.page.locator('.mg-next').click();
    await ready(second.page);
    assert.equal(await second.page.locator('.welcome').getAttribute('data-chapter'), 'chat');
    await second.page.locator('.mg-send').click();
    await second.page.locator('.mg-bubble-ai[data-visible=true]').waitFor();
    await layout(second.page);
    await shot(second.page, 'small-chat');
    await second.page.locator('.mg-next').click(); await ready(second.page);
    await layout(second.page);
    await second.page.keyboard.press('Control+Shift+F12');
    await second.page.locator('.mg-voice-result').waitFor();
    await second.page.locator('.mg-next').click(); await ready(second.page);
    await second.page.locator('.mg-query').click();
    await second.page.locator('.mg-result').first().click();
    await layout(second.page);
    await shot(second.page, 'small-search');
    await second.page.locator('.mg-next').click(); await ready(second.page); await layout(second.page);
    const file = path.join(skipped, 'config/local.json');
    const voiceBeforeFailure = await second.page.evaluate(() => window.__welcomeVoiceStarts.length);
    try {
      chmodSync(file, 0o444);
      await second.page.locator('.mg-switch').click();
      await second.page.locator('.mg-service-status[role=alert]').waitFor();
      assert.equal(await second.page.getByRole('switch').isChecked(), false, 'A failed write rolls the switch back');
      assert.equal(await second.page.locator('.mg-character-caption[data-visible=true]').count(), 0, 'A failed write cannot claim success');
      assert.equal(await second.page.evaluate(() => window.__welcomeVoiceStarts.length), voiceBeforeFailure);
      assert.equal(disk(skipped).ambient_attention, false);
    } finally { chmodSync(file, 0o666); }
    await second.page.locator('.mg-switch').click();
    await waitForDisk(skipped, saved => saved.ambient_attention === true, 'ambient_attention retry');
    report.checks.push('a real read-only config write failure rolls back the preview and produces no spoken or printed success; retry succeeds without the success voice');
    for (const chapter of ['outfit', 'placement', 'style', 'ready']) {
      if ((await second.page.locator('.welcome').getAttribute('data-chapter')) !== chapter) {
        await second.page.locator('.mg-next').click(); await ready(second.page);
      }
      assert.equal(await second.page.locator('.welcome').getAttribute('data-chapter'), chapter);
      await layout(second.page); await shot(second.page, `small-${chapter}`);
    }
    report.checks.push('900×600 window keeps titles and every interactive control inside the visible stage');
    report.checks.push('skip during the opening, close during a cut, replay and reduced-motion navigation cancel stale clocks');
  } finally { await second.app.close(); }

  assert.equal(report.errors.length, 0, report.errors.join('\n'));
  assert(report.narrationRequests.length > 0, 'Selected interactions request short Ayana lines');
  assert(report.narrationRequests.every(url => /\/welcome\/snippets\/(remember|setting|champion)\.wav/.test(url)), 'Only the retained greeting, setting success and original game completion are requested');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.errors.push(error.stack);
  console.error(error);
  process.exitCode = 1;
} finally {
  writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
}
