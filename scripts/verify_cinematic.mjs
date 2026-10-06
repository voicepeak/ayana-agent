/** Real Electron companion regression in an isolated local/silent profile. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const moduleRoot = process.argv.includes('--playwright-root') ? process.argv[process.argv.indexOf('--playwright-root') + 1] : undefined;
const packaged = process.argv.includes('--packaged') ? process.argv[process.argv.indexOf('--packaged') + 1] : undefined;
const { _electron } = require(require.resolve('playwright', { paths: [moduleRoot || root] }));
const directory = path.join(root, '.runtime', 'benchmarks', `cinematic-${Date.now()}`), data = path.join(directory, 'profile');
mkdirSync(path.join(data, 'config'), { recursive: true });
writeFileSync(path.join(data, 'config', 'local.json'), JSON.stringify({ provider: 'local', voice: { voice_mode: 'silent' }, stt: { provider: 'disabled' }, hotkey: 'Control+Alt+F10', cancel_hotkey: 'Control+Alt+F11', subtitles: true }));
const report = { checks: [], errors: [], scope: 'Isolated Electron, local model, real PCM consumption and owned click-through probe; no network model or microphone' };
let application, page, design;
const emit = async events => application.evaluate(({ BrowserWindow }, events) => {
  const chat = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=chat'));
  events.forEach(event => chat.webContents.send('ayana:event', { protocol_version: 1, ...event }));
}, events.map(event => event.type === 'settings.ready' ? { ...event, settings: { companion_ui: JSON.parse(readFileSync(path.join(data, 'config/local.json'), 'utf8')).companion_ui, ...event.settings } } : event));
try {
 application = await _electron.launch({ executablePath: packaged || path.join(root, 'apps/desktop/node_modules/electron/dist/electron.exe'),
  args: [...(packaged ? [] : [path.join(root, 'apps/desktop')]), `--user-data-dir=${data}`],
  env: { ...process.env, AYANA_DATA_DIR: data, AYANA_REPOSITORY_ROOT: packaged ? '' : root, AYANA_PYTHON: packaged ? '' : path.join(root, '.venv/Scripts/python.exe') }, timeout: 30000 });
 const windows = await application.windows(); page = windows.find(w => w.url().includes('window=chat'));
 const settings = windows.find(w => w.url().includes('window=settings'));
 design = windows.find(w => w.url().includes('window=design'));
 assert(page && settings && design);
 page.on('pageerror', error => report.errors.push(error.message));
 page.on('console', message => { if (message.type() === 'error') console.log('Renderer:', message.text().slice(0, 240)); });
 await page.waitForFunction(() => window.ayana.getState().then(s => s.connected), null, { timeout: 30000 });
 await page.waitForFunction(() => { const im = document.querySelector('.portrait-stage img'); return im?.complete && im.naturalWidth > 0; }, null, { timeout: 30000 });
 await page.locator('.portrait-stage img').evaluate(im => im.decode());
 await page.waitForTimeout(500);
 assert.equal(await page.locator('.floating-input').count(), 1, 'A note has an inline input without stealing focus.');
 assert(await page.locator('.companion-note').isVisible());
 const portraitBounds = await page.locator('.portrait-stage').boundingBox();
 const noteBounds = await page.locator('.companion-note').boundingBox();
 if (await page.evaluate(() => innerWidth >= 812)) assert(noteBounds.width >= 759, 'Startup positioning preserves the roomy default note width.');
 if (noteBounds.width >= 620) assert(portraitBounds.height >= 300, 'The wide note gives the portrait room for head and torso.');
 assert.equal(await page.locator('.gal-dialogue').count(), 0);
 const canvasReadable = await page.locator('.portrait-stage img').evaluate(im => { const c = document.createElement('canvas'); c.width = 1; c.height = 1; const ctx = c.getContext('2d'); ctx.drawImage(im, 0, 0, 1, 1); return ctx.getImageData(0, 0, 1, 1).data.length === 4; });
 assert(canvasReadable, 'Controlled avatar CORS allows alpha hit testing.');
 await page.screenshot({ path: path.join(directory, 'idle.png'), omitBackground: true });
 report.checks.push('portrait and inline input belong to a persistent note; controlled avatar alpha is readable');
 await page.evaluate(() => window.ayana.summon());
 await page.getByLabel('输入问题', { exact: true }).waitFor();
 await page.waitForFunction(() => document.activeElement === document.querySelector('.floating-input textarea'));
 assert.equal(await page.getByLabel('发送', { exact: true }).count(), 0, 'Input actions are hidden until requested.');
 await page.screenshot({ path: path.join(directory, 'bare-input.png'), omitBackground: true });
 await page.getByLabel('更多输入操作', { exact: true }).click();
 await page.getByLabel('发送', { exact: true }).waitFor();
 await page.getByLabel('更多输入操作', { exact: true }).click();
 await page.getByLabel('输入问题', { exact: true }).focus();
 await page.getByLabel('输入问题', { exact: true }).fill('你好');
 await page.getByLabel('输入问题', { exact: true }).press('Escape');
 assert.notEqual(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '输入问题');
 await page.evaluate(() => window.ayana.summon());
 await page.getByLabel('输入问题', { exact: true }).waitFor();
 assert.equal(await page.getByLabel('输入问题', { exact: true }).inputValue(), '你好', 'Closing input keeps a draft.');
 await page.getByLabel('输入问题', { exact: true }).press('Enter');
 await page.waitForFunction(() => document.querySelector('.floating-input textarea').value === '');
 await page.locator('.cinematic-glyph.is-shown').first().waitFor();
 const style = await page.locator('.cinematic-dialogue').evaluate(el => { const s = getComputedStyle(el); return { background: s.backgroundColor, border: s.borderWidth, font: s.fontFamily, weight: s.fontWeight }; });
 assert.equal(style.background, 'rgba(0, 0, 0, 0)'); assert.equal(style.border, '0px'); assert(style.font.includes('Noto Serif SC')); assert.equal(style.weight, '300');
 const frameStyle = await page.locator('.companion-frame').evaluate(node => ({ background: getComputedStyle(node.querySelector('.note-surface') || node).backgroundColor, width: node.getBoundingClientRect().width }));
 assert.notEqual(frameStyle.background, 'rgba(0, 0, 0, 0)'); assert(Math.abs(frameStyle.width - (await page.evaluate(() => innerWidth))) <= 3, 'Visible frame reaches the native resize border.');
 const cdp = await page.context().newCDPSession(page);
 await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
 const documentNode = await cdp.send('DOM.getDocument');
 const glyphNode = await cdp.send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '.cinematic-glyph.is-shown' });
 report.fonts = (await cdp.send('CSS.getPlatformFontsForNode', { nodeId: glyphNode.nodeId })).fonts;
 assert(report.fonts.some(font => font.familyName === 'Noto Serif SC'), 'The chosen serif is actually used for Chinese glyphs.');
 await cdp.detach();
 await page.screenshot({ path: path.join(directory, 'local-reply.png'), omitBackground: true });
 report.checks.push('summon focuses inline input; actions open on request; Escape keeps draft; sending clears draft; roomy note uses actual Noto Serif SC Light glyphs');
 await page.evaluate(() => window.ayana.send({ type: 'generation.cancel' }));
 await page.evaluate(() => window.ayana.summon());
 await page.getByLabel('打开设计控件', { exact: true }).click();
 await design.getByLabel('设计控件', { exact: true }).waitFor();
 const pane = label => ['便签宽度', '便签高度', '背景不透明度'].includes(label) ? '便签' : label === '字幕字号' ? '对白' : '立绘';
 const adjust = async (label, value) => { await design.getByRole('tab', { name: pane(label), exact: true }).click(); return design.getByLabel(label, { exact: true }).evaluate((node, value) => {
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, String(value));
   node.dispatchEvent(new Event('input', { bubbles: true }));
   node.dispatchEvent(new Event('change', { bubbles: true }));
 }, value); };
 await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('window=chat')).setSize(420,480)); await adjust('字幕字号', 22); await adjust('立绘大小', 240); await adjust('背景不透明度', 94);
 await design.getByRole('tab', { name: '立绘', exact: true }).click(); await adjust('立绘大小',230);
 await design.getByRole('tab', { name: '对白', exact: true }).click(); await design.getByText('说话时显示字幕', { exact: true }).locator('..').locator('input').uncheck();
 await design.getByRole('button', { name: '保存设计', exact: true }).click();
 await design.getByText('设计已保存', { exact: true }).waitFor();
 let saved = JSON.parse(readFileSync(path.join(data, 'config/local.json'), 'utf8'));
 assert(Math.abs((await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('window=chat')).getBounds())).width-420)<=2); assert.equal(saved.companion_ui.font_size, 22);
 assert.equal(saved.companion_ui.portrait_size,230); assert.equal(saved.companion_ui.show_subtitles, false);
 assert.equal(saved.voice.voice_mode, 'silent');
 await page.reload();
 await page.waitForFunction(() => document.querySelector('.companion-shell') && document.querySelector('.portrait-stage img')?.naturalWidth>0);
 assert.equal(await page.evaluate(()=>window.ayana.getState().then(s=>s.designPreview.portrait_size)),230);
 await emit([{ type: 'utterance.ready', generation_id: 400, utterance_id: 'hidden-caption', speech_ja: 'こんにちは。', audio_enabled: false },
  { type: 'subtitle.ready', generation_id: 400, utterance_id: 'hidden-caption', display_zh: '你好。' },
  { type: 'desktop.present', generation_id: 400, utterance_id: 'hidden-caption' }]);
 await page.waitForTimeout(200); assert.equal(await page.locator('.cinematic-glyph').count(), 0);
 await page.evaluate(() => window.ayana.summon());
 await page.getByLabel('打开设计控件', { exact: true }).click();
 await design.getByRole('tab', { name: '便签', exact: true }).click(); await design.getByLabel('便签背景', { exact: true }).selectOption('transparent');
 assert.equal(await page.locator('.companion-note').evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
 const fixture = path.join(directory, 'background-fixture.png');
 const bitmap = await application.evaluate(({ nativeImage }) => nativeImage.createFromBitmap(Buffer.alloc(4 * 4 * 4, 140), { width: 4, height: 4 }).toPNG().toString('base64'));
 writeFileSync(fixture, Buffer.from(bitmap, 'base64'));
 await application.evaluate(({ app, dialog }, file) => { app.__backgroundDialog = dialog.showOpenDialog; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, fixture);
 await design.getByLabel('便签背景', { exact: true }).selectOption('image');
 await design.getByRole('button', { name: '选择 / 更换背景图片', exact: true }).click();
 await page.waitForFunction(() => document.querySelector('.note-background-image')?.style.backgroundImage.includes('?v=') && !document.querySelector('.note-background-image').style.backgroundImage.includes('?v=0'));
 assert.equal(await page.evaluate(async () => (await fetch('ayana-background://custom/')).status), 200);
 await application.evaluate(({ app, dialog }) => { dialog.showOpenDialog = app.__backgroundDialog; });
 await design.getByRole('button', { name: '保存设计', exact: true }).click();
 await design.getByText('设计已保存', { exact: true }).waitFor();
 assert.equal(JSON.parse(readFileSync(path.join(data, 'config/local.json'), 'utf8')).companion_ui.background_mode, 'image');
 assert(readFileSync(path.join(data, 'companion-background.png')).length > 0);
 report.checks.push('transparent and frosted backgrounds render correctly; native image selection copies a valid private PNG; controlled background protocol and saved image mode work');
 await design.getByLabel('重置设计', { exact: true }).click(); await design.getByRole('tab', { name: '对白', exact: true }).click();
 await design.getByLabel('对白翻译语言',{exact:true}).selectOption('ja');
 await design.getByRole('button', { name: '保存设计', exact: true }).click();
 await design.getByText('设计已保存', { exact: true }).waitFor();
 await page.screenshot({ path: path.join(directory, 'design-controls.png'), omitBackground: true });
 await design.getByLabel('收起设计控件', { exact: true }).click();
 await page.waitForFunction(() => window.ayana.getState().then(s => !s.designOpen));
 report.checks.push('native frame resize and drawing scale/font/opacity preview work; backend persists appearance without touching voice; reload restores it; subtitles can hide; reset and collapse work');
 const long = '慢慢来，我们先把整件事情想清楚，再一步一步去做。很长的台词也会继续往下展示，所有内容都应该能读到。';
 await emit([{ type: 'settings.ready', settings: { subtitles: true, voice: { voice_mode: 'sovits' } } },
  { type: 'utterance.ready', generation_id: 500, utterance_id: 'paused-caption', speech_ja: 'ゆっくり話そう。', audio_enabled: true },
  { type: 'subtitle.ready', generation_id: 500, utterance_id: 'paused-caption', display_zh: long },
  { type: 'playback.started', generation_id: 500, utterance_id: 'paused-caption', total_samples: 1000 },
  { type: 'playback.progress', generation_id: 500, utterance_id: 'paused-caption', played_samples: 180, total_samples: 1000 }]);
 await page.waitForTimeout(350);
 assert((await page.locator('.is-current .cinematic-original').textContent()).length > 0, 'Optional Japanese accompanies translated dialogue.');
 await page.evaluate(() => { const root = document.querySelector('.companion-shell'); root.style.setProperty('--frame-width', '380px'); root.style.setProperty('--dialogue-font', '26px'); });
 await page.getByLabel('输入问题', { exact: true }).fill('第一行\n第二行\n第三行\n第四行');
 await page.waitForTimeout(250);
 const contained = await page.evaluate(() => {
   const frame = document.querySelector('.companion-note').getBoundingClientRect();
   return ['.portrait-canvas', '.cinematic-memory', '.floating-input'].every(selector => {
     const node = document.querySelector(selector); const bounds = node.getBoundingClientRect();
     return bounds.left >= frame.left && bounds.right <= frame.right + 1 && bounds.top >= frame.top && bounds.bottom <= frame.bottom + 1 && node.scrollWidth <= node.clientWidth + 1;
   });
 });
 assert(contained, 'Largest font, smallest width, dual captions and long input all stay inside the note.');
 await page.getByLabel('输入问题', { exact: true }).fill('');
 await page.evaluate(() => { const root = document.querySelector('.companion-shell'); root.style.setProperty('--frame-width', '760px'); root.style.setProperty('--dialogue-font', '24px'); });
 report.checks.push('portrait and both languages remain inside the note at largest font/smallest width; long input stays bounded');
 const firstCount = await page.locator('.cinematic-glyph.is-shown').count();
 await page.waitForTimeout(450);
 assert.equal(await page.locator('.cinematic-glyph.is-shown').count(), firstCount, 'No receipt means no advancing voiced text.');
 assert((await page.locator('.is-current .cinematic-shot').textContent()).length>0);
 await emit([{ type: 'playback.progress', generation_id: 500, utterance_id: 'paused-caption', played_samples: 900, total_samples: 1000 }]);
 await page.waitForTimeout(300);
 assert((await page.locator('.is-current .cinematic-glyph.is-shown').count())>firstCount,'Consumed audio reveals more of the retained sentence.');
 await page.screenshot({ path: path.join(directory, 'voiced-caption.png'), omitBackground: true });
 await emit([{ type: 'desktop.cancelled', generation_id: 501, cancelled_generation_id: 500 }]);
 await page.waitForFunction(() => !document.querySelector('.is-current .cinematic-dialogue:not([data-complete=true])'));
 report.checks.push('voiced reveal freezes without consumed receipts, long lines retain their complete text, cancellation stops active reveal');
 await page.evaluate(() => { window.__cinematicEvents = []; window.ayana.onEvent(e => { if (e.type.startsWith('playback.')) window.__cinematicEvents.push(e); }); });
 const samples = Buffer.alloc(16000 * 3 * 4); // silent PCM tests consumption without acoustic output
 await emit([{ type: 'utterance.ready', generation_id: 600, utterance_id: 'real-pcm', speech_ja: 'ちゃんと聞いているよ。', audio_enabled: true },
  { type: 'subtitle.ready', generation_id: 600, utterance_id: 'real-pcm', display_zh: '嗯，我在这里。你慢慢说。' },
  { type: 'audio.ready', generation_id: 600, utterance_id: 'real-pcm', sample_rate: 16000, channels: 1, duration_ms: 3000, pcm_base64: samples.toString('base64') }]);
 await page.waitForFunction(() => window.__cinematicEvents.some(e => e.type === 'playback.progress' && e.utterance_id === 'real-pcm' && e.played_samples > 0), null, { timeout: 15000 });
 await page.waitForFunction(() => window.__cinematicEvents.some(e => e.type === 'playback.ended' && e.utterance_id === 'real-pcm'), null, { timeout: 15000 });
 await page.waitForFunction(() => document.querySelector('.is-current .cinematic-shot')?.textContent.includes('慢慢说'));
 await page.waitForTimeout(2500); assert(await page.locator('[data-caption-id="real-pcm"].is-current').isVisible(), 'Completed dialogue stays centered until another sentence arrives.');
 report.checks.push('actual AudioWorklet PCM consumption drives captions; completed sentence remains clear and readable');
 await application.evaluate(({ BrowserWindow, Menu, app }) => {
  app.__cinematicPopup = Menu.prototype.popup;
  Menu.prototype.popup = function(options) { app.__cinematicMenu = this; const result = app.__cinematicPopup.call(this, options); setTimeout(() => this.closePopup(options.window), 120); return result; };
 });
 await page.evaluate(() => window.ayana.openCompanionMenu());
 await page.waitForTimeout(350);
 const labels = await application.evaluate(({ Menu, app }) => { Menu.prototype.popup = app.__cinematicPopup; return app.__cinematicMenu.items.map(i => i.label); });
 for (const label of ['输入一句', '开始新话题', '话题与记录', '任务与结果', '设置', '收起彩名']) assert(labels.includes(label));
 await application.evaluate(({ app }) => { const item = app.__cinematicMenu.items.find(i => i.label === '输入一句'); item.click(item); });
 await page.getByLabel('输入问题', { exact: true }).waitFor();
 await page.getByLabel('输入问题', { exact: true }).press('Escape');
 report.checks.push('native context menu exposes input, topics, tasks, settings and hide without permanent buttons');
 const bounds = await application.evaluate(async ({ BrowserWindow, app }) => {
  const chat = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=chat'));
  const bounds = chat.getBounds();
  app.__cinematicProbe = new BrowserWindow({ ...bounds, frame: false, show: false, webPreferences: { sandbox: true, nodeIntegration: false } });
  await app.__cinematicProbe.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0;background:#25303a;color:#ddd;font:16px sans-serif"><script>window.clicks=0;document.addEventListener("click",()=>window.clicks++)</script></body>'));
  app.__cinematicProbe.setAlwaysOnTop(true, 'screen-saver'); app.__cinematicProbe.show(); app.__cinematicProbe.focus(); chat.showInactive(); chat.moveTop(); return bounds;
 });
 await page.waitForTimeout(250);
 const physical = await application.evaluate(({ screen }, b) => screen.dipToScreenPoint({ x: b.x + 6, y: b.y + 6 }), bounds);
 const hit = Number(execFileSync(path.join(root, '.venv/Scripts/python.exe'), ['-c', 'from native.windows.win32 import Win32; import sys; print(Win32().point_root(int(sys.argv[1]),int(sys.argv[2])))', String(physical.x), String(physical.y)], { cwd: root, windowsHide: true }).toString().trim());
 const underlying = await application.evaluate(({ app }) => app.__cinematicProbe.getNativeWindowHandle().readUInt32LE());
 assert.notEqual(hit, underlying, 'The native resize corner belongs to the companion.');
 await page.evaluate(() => window.ayana.moveCompanion(-24, -18));
 await page.waitForTimeout(400);
 const moved = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=chat')).getBounds());
 assert(Math.abs(moved.x - bounds.x + 24) <= 2); assert(Math.abs(moved.y - bounds.y + 18) <= 2);
 await application.evaluate(({ app }) => app.__cinematicProbe.close());
 report.checks.push('native frame retains resize corners; window movement preserves its position');
 await application.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=chat')); w.setResizable(true); w.setMinimumSize(240,200); w.setSize(360, 620); });
 await page.evaluate(() => window.ayana.summon());
 await page.getByLabel('输入问题', { exact: true }).waitFor();
 assert(await page.evaluate(() => document.querySelector('.companion-shell').scrollWidth <= innerWidth));
 await page.screenshot({ path: path.join(directory, 'compact-input.png'), omitBackground: true });
 await page.getByLabel('输入问题', { exact: true }).press('Escape');
 await page.keyboard.press('Escape');
 const visible = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=chat')).isVisible());
 assert.equal(visible, false, 'Second Escape hides the portrait even after removing input focus.');
 report.checks.push('360px layout has no horizontal overflow and summon/input/hide still work');
 assert.deepEqual(report.errors, []); report.passed = true;
} catch(error) { report.passed = false; report.failure = String(error); process.exitCode = 1; if(page) { report.diagnostics = await page.evaluate(() => ({ active: document.activeElement?.outerHTML.slice(0, 180), frame: document.querySelector('.companion-frame')?.className, input: document.querySelector('.floating-input textarea')?.getBoundingClientRect().toJSON() })).catch(() => null); await page.screenshot({ path: path.join(directory, 'failure.png'), omitBackground: true }).catch(()=>{}); } }
finally { if(application) await application.close(); writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ...report, directory }, null, 2)); }
