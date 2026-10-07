/** Preview the actual compiled companion renderer with isolated fixture events. No backend or personal profile. */
import { app, BrowserWindow, ipcMain, Menu, protocol } from 'electron';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktop, '../..');
const defaults = JSON.parse(readFileSync(path.join(root, 'config/default.json'), 'utf8'));
const catalog = JSON.parse(readFileSync(path.join(root, 'characters/ayana/avatar-map.json'), 'utf8'));
protocol.registerSchemesAsPrivileged([{ scheme: 'ayana-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.setName('Ayana Waiting Preview');
let window, generation = 0, events = [], scene = 'working';
let design = { ...defaults.companion_ui, bubble_color: '#30343d' };
const event = (type, payload = {}) => ({ protocol_version: 1, type, generation_id: generation, ...payload });
function emit(type, payload) {
  const value = event(type, payload); events.push(value);
  window.webContents.send('ayana:event', value);
}
function settings(voice = 'silent') {
  return { ...defaults, companion_ui: design, voice: { voice_mode: voice }, remember_user: false };
}
function setScene(next, text = '帮我把这份资料整理一下') {
  scene = next; generation++; events = [];
  emit('desktop.reset');
  emit('settings.ready', { settings: settings(next === 'voice' ? 'sovits' : 'silent') });
  emit('desktop.service', { connected: true, state: 'ready' });
  if (next === 'history') {
    emit('history.ready', { history_conversation_id: 'waiting-demo', has_more: false, history: [
      { id: 1, role: 'user', text: '先看看这份资料，好吗？' },
      { id: 2, role: 'assistant', utterance_id: 'history-first', speech_ja: 'まず、全体を見てみよう。', display_zh: '先看看整体，再决定从哪里开始。', displayed: true, status: 'played' },
      { id: 3, role: 'user', text: '有几处好像互相矛盾。' },
      { id: 4, role: 'assistant', utterance_id: 'history-second', speech_ja: 'その違いを、確かめたいね。', display_zh: '这里的说法不一样，需要再核对。', displayed: true, status: 'played' },
      { id: 5, role: 'user', text: '那就把线索连起来。' },
      { id: 6, role: 'assistant', utterance_id: 'history-third', speech_ja: '資料を見直してみるね。', display_zh: '我再看看资料，你可以先回看刚才的话。', displayed: true, status: 'played' },
    ] });
  }
  emit('user.message', { text, turn_id: `preview-${generation}` });
  emit('task.state', { state: 'thinking' });
  if (next === 'reading' || next === 'working' || next === 'continuing' || next === 'history') {
    if (next === 'continuing') {
      emit('utterance.ready', { utterance_id: `ack-${generation}`, speech_ja: '先に資料を見てみるね。', audio_enabled: false });
      emit('subtitle.ready', { utterance_id: `ack-${generation}`, display_zh: '我先看看资料，再帮你整理。' });
    }
    emit('tool.started', { call_id: `work-${generation}`, tool: next === 'reading' ? 'files.read' : 'shell.run' });
  } else if (next === 'organizing') {
    emit('tool.started', { call_id: `work-${generation}`, tool: 'files.read' });
    emit('tool.completed', { call_id: `work-${generation}`, tool: 'files.read', result: {} });
  } else if (next === 'voice' || next === 'complete') {
    emit('utterance.ready', { utterance_id: `reply-${generation}`, speech_ja: '資料を整理したよ。', audio_enabled: next === 'voice' });
    emit('subtitle.ready', { utterance_id: `reply-${generation}`, display_zh: '资料整理好了，重点都放在这里。' });
    emit('task.state', { state: 'idle' });
  } else if (next === 'cancelled') {
    emit('generation.cancelled', { cancelled_generation_id: generation });
  } else if (next === 'failed') {
    emit('error', { message: '预览：这次资料没有读取成功，可以再试一次。' });
  }
}
function setTheme(theme) {
  const colors = { ink: ['#25282d', '#30343d'], paper: ['#e6dfd0', '#faf3e5'] }[theme];
  design = { ...design, theme, background_color: colors[0], bubble_color: colors[1] };
  emit('settings.ready', { settings: settings(scene === 'voice' ? 'sovits' : 'silent') });
}

void app.whenReady().then(async () => {
protocol.handle('ayana-asset', request => {
  const id = new URL(request.url).hostname;
  const asset = catalog.assets[id];
  if (!asset) return new Response('Missing asset', { status: 404 });
  return new Response(readFileSync(path.join(root, 'assets/ayana', asset.file)), {
    headers: { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' },
  });
});
ipcMain.handle('ayana:state', () => ({ connected: true, service: 'ready', version: 'waiting-preview', repositoryRoot: '', events }));
ipcMain.handle('ayana:command', (_event, command) => {
  if (command.type === 'turn.start') setScene('working', command.text);
  if (command.type === 'generation.cancel') setScene('cancelled');
  return { ok: true };
});
ipcMain.handle('ayana:hide', () => window.close());
ipcMain.handle('ayana:summon', () => window.show());
ipcMain.handle('ayana:companion-menu', () => Menu.buildFromTemplate(sceneItems()).popup({ window }));
for (const name of ['design-open', 'design-close', 'design-revert-preview', 'settings', 'hide-settings', 'restart'])
  ipcMain.handle(`ayana:${name}`, () => {});
for (const name of ['choose-repository', 'choose-directory']) ipcMain.handle(`ayana:${name}`, () => null);
ipcMain.handle('ayana:note-background', () => ({ ok: false, error: '等待预览使用项目内置主题。' }));
ipcMain.on('ayana:design-preview', (_event, patch) => { design = { ...design, ...patch }; emit('desktop.design-preview', { value: design }); });
function sceneItems() {
  return [
    ['整理思路', 'thinking'], ['翻阅资料', 'reading'], ['正在处理', 'working'],
    ['整理结果', 'organizing'], ['准备语音', 'voice'], ['说完一句，继续工作', 'continuing'],
    ['等待时回看对白', 'history'],
    ['回复完成', 'complete'], ['取消等待', 'cancelled'], ['读取失败', 'failed'],
  ].map(([label, value]) => ({ label, click: () => setScene(value) }));
}
Menu.setApplicationMenu(Menu.buildFromTemplate([
  { label: '等待状态 · 演示', submenu: [...sceneItems(), { type: 'separator' },
    { label: '让新回复到来', click: () => globalThis.ayanaWaitingPreview.finishHistory() }] },
  { label: '外观', submenu: [
    { label: '夜墨', click: () => setTheme('ink') }, { label: '纸笺', click: () => setTheme('paper') },
    { type: 'separator' }, { label: '正常宽度', click: () => window.setContentSize(760, 480) },
    { label: '窄窗口', click: () => window.setContentSize(440, 500) },
  ] },
  { label: '关闭预览', submenu: [{ label: '关闭', role: 'quit' }] },
]));
window = new BrowserWindow({ width: 780, height: 550, title: 'Ayana · 等待状态预览（演示）',
  backgroundColor: '#25282d', show: false,
  webPreferences: { preload: path.join(desktop, 'dist-electron/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
});
await window.loadFile(path.join(desktop, 'dist/index.html'), { query: { window: 'chat' } });
window.setTitle('Ayana · 等待状态预览（演示）');
window.setContentSize(760, 480);
window.show();
setTimeout(() => setScene('working'), 200);
// Automation is confined to this separate preview main process.
globalThis.ayanaWaitingPreview = { setScene, setTheme, setSize: (width, height) => window.setContentSize(width, height), finishHistory: () => {
  emit('tool.completed', { call_id: `work-${generation}`, tool: 'shell.run', result: {} });
  emit('utterance.ready', { utterance_id: `latest-${generation}`, speech_ja: '結果を整理したよ。', audio_enabled: false });
  emit('subtitle.ready', { utterance_id: `latest-${generation}`, display_zh: '这次的结果回来了，我已经整理好。' });
  emit('task.state', { state: 'idle' });
} };
});
app.on('window-all-closed', () => app.quit());
