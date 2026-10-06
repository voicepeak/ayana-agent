import {
  app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage,
  protocol, screen, session, Tray,
  shell,
} from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import defaults from '../../../config/default.json';
import { clampCompanion, companionSize, companionDragBounds, inspectorBounds, type Bounds, type Point } from './companionGeometry';

type Event = Record<string, unknown> & { type: string; protocol_version: number };
const commands = new Set([
  'session.start', 'session.close', 'turn.start', 'generation.cancel', 'target.bind',
  'target.capture', 'windows.list', 'repository.inspect', 'repository.read',
  'repository.search', 'settings.get', 'settings.update', 'history.get', 'tool.execute', 'utterance.displayed', 'mode.set', 'input.audio',
  'capabilities.get', 'directory.grant', 'directory.revoke', 'task.pause', 'task.resume', 'task.cancel',
  'approval.resolve', 'artifact.get', 'artifact.open', 'artifact.restore', 'source.open',
  'computer.start',
  'conversations.get', 'conversation.create', 'conversation.select', 'conversation.rename', 'conversation.materials.clear',
]);
app.setName('Ayana');
const playbackTypes = new Set(['playback.started', 'playback.progress', 'playback.ended', 'playback.cancelled', 'playback.error']);
protocol.registerSchemesAsPrivileged([
  { scheme: 'ayana-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'ayana-background', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let chat: BrowserWindow | undefined;
let settingsWindow: BrowserWindow | undefined;
let designWindow: BrowserWindow | undefined;
let highlight: BrowserWindow | undefined;
let tray: Tray | undefined;
let child: ChildProcess | undefined;
let socket: WebSocket | undefined;
let service = 'starting';
let token = '';
let port = 0;
let currentGeneration = 0;
let quitting = false;
let restarting = false;
let focusAfterCapture = false;
let summonPending = false;
let startupSummonDone = false;
let companionShown = false;
let refreshSummon = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let highlightTimer: ReturnType<typeof setTimeout> | undefined;
let focusTimer: ReturnType<typeof setTimeout> | undefined;
let recentEvents: Event[] = [];
let repositoryRoot = '';
let summonShortcut = 'Control+Alt+A';
let cancelShortcut = 'Control+Alt+Space';
let inputAfterCapture = true;
let composerRequested = false;
let companionMenuOpen = false;
let companionPositionTimer: ReturnType<typeof setTimeout> | undefined;
let companionSettings: Record<string, unknown> = {};
let companionMode = 'teach';
let designPreview = { ...defaults.companion_ui };
let companionDrag: { origin: Bounds; cursor: Point; moved: boolean; timer: ReturnType<typeof setInterval> } | undefined;

function storedDesign(settings: Record<string, unknown>) {
  return { ...defaults.companion_ui, ...(settings.companion_ui as Partial<typeof designPreview> || {}) };
}

function persistCompanionPosition() {
  if (!chat || chat.isDestroyed()) return;
  if (companionPositionTimer) clearTimeout(companionPositionTimer);
  try { writeFileSync(path.join(app.getPath('userData'), 'companion-position.json'), JSON.stringify({ version: 2, ...chat.getBounds() })); } catch { /* Position is cosmetic. */ }
}

function queueCompanionPosition() {
  if (companionPositionTimer) clearTimeout(companionPositionTimer);
  companionPositionTimer = setTimeout(persistCompanionPosition, 180);
}

function positionDesignWindow() {
  if (!chat || chat.isDestroyed() || !designWindow || designWindow.isDestroyed() || !designWindow.isVisible()) return;
  const card = chat.getBounds();
  designWindow.setBounds(inspectorBounds(card, screen.getDisplayMatching(card).workArea));
}

function notifyDesignPreview() {
  broadcast({ protocol_version: 1, type: 'desktop.design-preview', value: designPreview }, false);
}

function openDesign() {
  if (!designWindow || !chat) return;
  designWindow.setBounds(inspectorBounds(chat.getBounds(), screen.getDisplayMatching(chat.getBounds()).workArea));
  designWindow.show(); designWindow.focus();
  notifyDesignPreview();
  broadcast({ protocol_version: 1, type: 'desktop.design-visibility', open: true }, false);
}

function closeDesign() {
  designWindow?.hide();
  broadcast({ protocol_version: 1, type: 'desktop.design-visibility', open: false }, false);
}

function stepCompanionDrag() {
  if (!chat || chat.isDestroyed() || !companionDrag) return;
  const cursor = screen.getCursorScreenPoint();
  if (!companionDrag.moved && Math.hypot(cursor.x - companionDrag.cursor.x, cursor.y - companionDrag.cursor.y) < 4) return;
  companionDrag.moved = true;
  const bounds = companionDragBounds(companionDrag.origin, companionDrag.cursor, cursor, screen.getDisplayNearestPoint(cursor).workArea);
  const current = chat.getBounds();
  // setPosition round-trips the size through DIP on Windows and grows it at 175% DPI.
  // Every step uses the same requested dimensions instead of the previous rounded size.
  if (current.x !== bounds.x || current.y !== bounds.y) chat.setBounds(bounds);
}

function endCompanionDrag() {
  if (!companionDrag) return;
  stepCompanionDrag();
  clearInterval(companionDrag.timer);
  const moved = companionDrag.moved;
  companionDrag = undefined;
  if (moved) persistCompanionPosition();
}

function backendRoot(): string {
  return process.env.AYANA_REPOSITORY_ROOT
    || (app.isPackaged ? path.join(process.resourcesPath, 'backend') : path.resolve(__dirname, '../../..'));
}

function diagnostic(value: string) {
  try {
    const dir = app.getPath('logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 'ayana-runtime.log'), `${new Date().toISOString()} ${value}\n`);
  } catch { /* Logging must never break lifecycle cleanup. */ }
}

function broadcast(event: Event, remember = true) {
  if (remember && !event.type.startsWith('audio.') && !event.type.startsWith('playback.')) {
    if (event.type === 'conversation.changed') {
      const retained = new Set(['settings.ready', 'service.state', 'desktop.service', 'desktop.shortcuts', 'capabilities.ready']);
      recentEvents = recentEvents.filter(previous => retained.has(previous.type));
      repositoryRoot = String((event.materials as Record<string, unknown>)?.repository_root || '');
    }
    if (event.type === 'repository.cleared') {
      recentEvents = recentEvents.filter(previous => !['repository.inspected', 'evidence.ready', 'repository.file'].includes(previous.type));
      repositoryRoot = '';
    }
    if (event.type === 'repository.inspected') repositoryRoot = String(event.root || (event.repository as Record<string, unknown>)?.root || '');
    if (event.type === 'snapshot.invalidated') {
      recentEvents = recentEvents.filter(previous => previous.type !== 'snapshot.ready');
    }
    if (['snapshot.ready', 'repository.inspected', 'settings.ready', 'history.ready', 'conversations.ready', 'context.state'].includes(event.type)) {
      recentEvents = recentEvents.filter(previous => previous.type !== event.type);
    }
    recentEvents.push(event);
    const snapshots = new Set(['snapshot.ready', 'repository.inspected', 'settings.ready', 'history.ready', 'conversations.ready', 'conversation.changed', 'context.state']);
    recentEvents = recentEvents.filter((previous, index) => snapshots.has(previous.type) || index >= recentEvents.length - 160);
  }
  for (const window of [chat, settingsWindow, designWindow, highlight]) {
    if (window !== chat && event.type.startsWith('audio.')) continue;
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('ayana:event', event);
    }
  }
}

function desktopEvent(type: string, payload: Record<string, unknown> = {}) {
  broadcast({ protocol_version: 1, type, generation_id: currentGeneration, ...payload });
}

function runtimeSend(command: Record<string, unknown>): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(command));
  return true;
}

function cancel() {
  // This IPC event is emitted immediately, before waiting for the runtime.
  desktopEvent('desktop.cancelled', { cancelled_generation_id: currentGeneration });
  runtimeSend({ type: 'generation.cancel' });
  highlight?.hide();
}

function hide() {
  endCompanionDrag(); closeDesign();
  composerRequested = false;
  focusAfterCapture = false;
  summonPending = false;
  companionShown = false;
  refreshSummon = false;
  if (focusTimer) clearTimeout(focusTimer);
  cancel();
  runtimeSend({ type: 'session.close' });
  chat?.hide();
  highlight?.hide();
  desktopEvent('desktop.hidden');
}

async function summon(openInput = true) {
  // Already waiting on the runtime: the portrait is on screen; keep it still.
  if (summonPending) return;
  // A repeat summon still re-captures the foreground window (so the user can switch
  // workspace) but must not replay the portrait entrance.
  const refresh = companionShown;
  // Runtime records the foreground HWND before either assistant window gains focus.
  cancel();
  inputAfterCapture = openInput;
  focusAfterCapture = true;
  refreshSummon = refresh;
  if (!runtimeSend({ type: 'session.start' })) {
    summonPending = true;
    chat?.showInactive();
    if (!refresh) desktopEvent('desktop.summoned');
    desktopEvent('desktop.service', { state: service, message: '本地服务正在启动…' });
    return;
  }
  if (focusTimer) clearTimeout(focusTimer);
  // In an unavailable target scenario, runtime should emit target/error; this fallback
  // allows typing after a bounded wait without performing another foreground query.
  focusTimer = setTimeout(() => focusChat(), 3000);
}

function focusChat() {
  if (!focusAfterCapture) return;
  focusAfterCapture = false;
  if (focusTimer) clearTimeout(focusTimer);
  if (inputAfterCapture) chat?.show(); else chat?.showInactive();
  const refresh = refreshSummon;
  refreshSummon = false;
  companionShown = true;
  // A repeat summon names the freshly captured workspace instead of replaying the entrance.
  // Deferred so the runtime's session.started target reaches the renderer first.
  if (refresh) setTimeout(() => desktopEvent('desktop.workspace-hint'), 0);
  else desktopEvent('desktop.summoned');
  if (inputAfterCapture) chat?.focus();
  // Request composer focus on every summon, including an already-focused chat.
  // This is transient UI intent and must not be replayed with runtime history.
  if (inputAfterCapture) requestComposer();
}

function requestComposer() {
  composerRequested = true;
  chat?.setIgnoreMouseEvents(false);
  chat?.show(); chat?.focus();
  broadcast({ protocol_version: 1, type: 'desktop.focus-input', generation_id: currentGeneration }, false);
}

function openManagement(tab?: 'tasks' | 'history') {
  closeDesign();
  // The transparent companion must not cover the management window's controls.
  chat?.setAlwaysOnTop(false);
  settingsWindow?.show(); settingsWindow?.focus();
  broadcast({ protocol_version: 1, type: 'desktop.navigate', tab: tab || 'settings' }, false);
}

function hideManagement() {
  settingsWindow?.hide();
  chat?.setAlwaysOnTop(true, 'screen-saver');
}

function companionMenuItems(): Electron.MenuItemConstructorOptions[] {
  return [
    { label: '输入一句', click: requestComposer },
    { label: '调整外观', click: openDesign },
    { label: '开始新话题', click: () => { requestComposer(); broadcast({ protocol_version: 1, type: 'desktop.new-topic' }, false); } },
    { label: `立即打断 · ${cancelShortcut}`, click: cancel },
    { type: 'separator' },
    { label: '允许本次任务执行', type: 'checkbox', checked: companionSettings.full_access === true || companionMode === 'execute', enabled: companionSettings.full_access !== true,
      click: item => { runtimeSend({ type: 'mode.set', mode: item.checked ? 'execute' : 'teach' }); } },
    { label: '显示中文字幕', type: 'checkbox', checked: companionSettings.subtitles !== false,
      click: item => { runtimeSend({ type: 'settings.update', settings: { subtitles: item.checked } }); } },
    { label: '话题与记录', click: () => openManagement('history') },
    { label: '任务与结果', click: () => openManagement('tasks') },
    { label: '设置', click: () => openManagement() },
    { type: 'separator' },
    { label: '收起彩名', click: hide },
  ];
}

function windowHandle(window: BrowserWindow): number {
  const buffer = window.getNativeWindowHandle();
  return buffer.length >= 8 ? Number(buffer.readBigUInt64LE()) : buffer.readUInt32LE();
}

function registerWindows() {
  runtimeSend({
    type: 'assistant.register',
    hwnds: [chat, settingsWindow, designWindow, highlight].filter((win): win is BrowserWindow => !!win && !win.isDestroyed()).map(windowHandle),
  });
}

function updateShortcuts(settings: Record<string, unknown>) {
  const raw = settings.shortcuts as Record<string, unknown> | undefined;
  const nextSummon = String(raw?.summon || settings.hotkey || settings.summon_shortcut || summonShortcut);
  const nextCancel = String(raw?.cancel || settings.cancel_hotkey || settings.cancel_shortcut || cancelShortcut);
  globalShortcut.unregisterAll();
  summonShortcut = nextSummon;
  cancelShortcut = nextCancel;
  let summonOk = false;
  let cancelOk = false;
  try { summonOk = globalShortcut.register(summonShortcut, () => { void summon(); }); } catch { /* Invalid accelerator. */ }
  try { cancelOk = globalShortcut.register(cancelShortcut, cancel); } catch { /* Invalid accelerator. */ }
  desktopEvent('desktop.shortcuts', { summon: summonShortcut, cancel: cancelShortcut, summon_ok: summonOk, cancel_ok: cancelOk });
  if (tray) tray.setContextMenu(Menu.buildFromTemplate([
    { label: `呼出 Ayana · ${summonShortcut}`, click: () => { void summon(); } },
    { label: `停止当前回复 · ${cancelShortcut}`, click: cancel },
    { label: '收起会话', click: hide },
    { label: '话题与记录', click: () => openManagement('history') },
    { label: '任务与结果', click: () => openManagement('tasks') },
    { label: '设置与管理', click: () => openManagement() },
    { type: 'separator' },
    { label: '重新启动本地服务', click: () => { void restartRuntime(); } },
    { label: '退出 Ayana', click: () => { quitting = true; app.quit(); } },
  ]));
}

function showHighlight(event: Event) {
  const result = (event.result ?? event) as Record<string, unknown>;
  const rect = (result.screen_rect ?? result.rect ?? event.screen_rect) as Record<string, number> | undefined;
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return;
  // Native coordinates are physical screen pixels; Electron bounds use DIP.
  const bounds = screen.screenToDipRect(chat!, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  const padding = 18;
  highlight?.setBounds({
    x: Math.floor(bounds.x - padding), y: Math.floor(bounds.y - padding),
    width: Math.max(40, Math.ceil(bounds.width + padding * 2)),
    height: Math.max(40, Math.ceil(bounds.height + padding * 2)),
  });
  highlight?.showInactive();
  desktopEvent('desktop.target-cue', { cue_id: Date.now(), variant: 'hint' });
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => highlight?.hide(), 6000);
}

function showTargetCue(event: Event) {
  const target = event.target as Record<string, unknown> | undefined;
  const rect = target?.bounds as Record<string, number> | undefined;
  if (!highlight || !chat || !rect || ![rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite)) return;
  if (rect.right <= rect.left || rect.bottom <= rect.top) return;
  const bounds = screen.screenToDipRect(chat, { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top });
  highlight.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.max(40, Math.round(bounds.width)), height: Math.max(40, Math.round(bounds.height)) });
  highlight.showInactive();
  desktopEvent('desktop.target-cue', { cue_id: Date.now(), variant: 'summon', title: String(target?.title || '') });
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => highlight?.hide(), 1800);
}

function receive(event: Event) {
  if (event.protocol_version !== 1 || typeof event.type !== 'string') return;
  if (typeof event.generation_id === 'number') currentGeneration = Math.max(currentGeneration, event.generation_id);
  if (event.type === 'artifact.open') {
    const artifact = event.artifact as Record<string, unknown> | undefined;
    const file = String(artifact?.absolute_path || '');
    if (artifact?.artifact_id && path.isAbsolute(file) && /\.(md|txt|json|toml|ya?ml|csv|py|tsx?|jsx?|vue|html|css|sql|rs|go|cs|java|c|cpp|h)$/i.test(file)) {
      // Source extensions can be associated with interpreters; always open as text.
      const viewer = spawn('notepad.exe', [file], { windowsHide: false, stdio: 'ignore' });
      viewer.on('error', () => desktopEvent('error', { message: '无法打开文本查看器。' }));
      viewer.unref();
    }
    return;
  }
  if (event.type === 'source.open') {
    try { const url = new URL(String(event.url)); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) void shell.openExternal(url.href); } catch { /* Invalid runtime URL. */ }
    return;
  }
  if (event.type === 'settings.ready') {
    const settings = (event.settings ?? {}) as Record<string, unknown>;
    const before = storedDesign(companionSettings);
    const edits = Object.fromEntries(Object.entries(designPreview).filter(([key, value]) => value !== before[key as keyof typeof before]));
    designPreview = { ...storedDesign(settings), ...edits };
    companionSettings = settings;
    placeCompanion(); notifyDesignPreview();
    updateShortcuts(settings);
  }
  if (event.type === 'mode.ready') companionMode = event.mode === 'execute' ? 'execute' : 'teach';
  if (event.type === 'conversation.changed') highlight?.hide();
  if (event.type === 'utterance.ready' && event.presentation === 'costume-change') {
    // Show the saved outfit's acknowledgment without summoning/cancelling its generation.
    chat?.showInactive();
  }
  // The backend captures the foreground identity before chat takes focus.
  // Later screenshots and playback must not restart the summon effect.
  if (event.type === 'session.started' && focusAfterCapture) {
    showTargetCue(event);
    focusChat();
  }
  if (event.type === 'target.bound' || event.type === 'snapshot.ready' || event.type === 'error') focusChat();
  if (event.type === 'highlight.ready' || event.type === 'target.highlight'
    || (event.type === 'tool.completed' && ((event.result as Record<string, unknown> | undefined)?.kind === 'highlight'))) {
    showHighlight(event);
  }
  broadcast(event);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const selected = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(selected));
    });
  });
}

function connectRuntime(attempt = 0) {
  if (quitting || restarting) return;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { Authorization: `Bearer ${token}` }, maxPayload: 32 * 1024 * 1024,
  });
  socket = ws;
  ws.on('open', () => {
    service = 'ready';
    desktopEvent('desktop.service', { state: service, connected: true });
    registerWindows();
    runtimeSend({ type: 'settings.get' });
    runtimeSend({ type: 'history.get' });
    runtimeSend({ type: 'capabilities.get' });
    if (summonPending || !startupSummonDone) {
      const openInput = summonPending ? inputAfterCapture : false;
      summonPending = false;
      startupSummonDone = true;
      void summon(openInput);
    }
  });
  ws.on('message', (raw) => {
    try { receive(JSON.parse(raw.toString()) as Event); }
    catch { desktopEvent('error', { code: 'invalid_runtime_event', message: '本地服务返回了无法读取的事件。' }); }
  });
  ws.on('error', (error) => diagnostic(`Connection: ${error.message}`));
  ws.on('close', () => {
    if (socket !== ws || quitting || restarting) return;
    service = child?.exitCode === null ? 'connecting' : 'failed';
    desktopEvent('desktop.cancelled', { cancelled_generation_id: currentGeneration });
    desktopEvent('desktop.service', { state: service, connected: false });
    if (attempt < 40 && child?.exitCode === null) {
      reconnectTimer = setTimeout(() => connectRuntime(attempt + 1), Math.min(250 + attempt * 200, 2000));
    } else {
      desktopEvent('error', { code: 'runtime_unavailable', message: '本地服务未连接。请查看运行日志或点击重启服务。' });
      chat?.show();
    }
  });
}

async function startRuntime() {
  service = 'starting';
  desktopEvent('desktop.service', { state: service, connected: false });
  token = randomBytes(32).toString('hex');
  port = await freePort();
  const root = backendRoot();
  repositoryRoot = '';
  const bundled = path.join(process.resourcesPath, 'python', 'python.exe');
  const local = path.join(root, '.venv', 'Scripts', 'python.exe');
  const python = process.env.AYANA_PYTHON || (existsSync(bundled) ? bundled : existsSync(local) ? local : 'python');
  diagnostic(`Runtime start: packaged=${app.isPackaged} backend=${root} python=${python} data=${app.getPath('userData')}`);
  child = spawn(python, [...(app.isPackaged ? ['-I', '-X', 'utf8', '-u'] : []), '-m', 'services.agent', '--port', String(port),
    ...(app.isPackaged ? ['--data-dir', app.getPath('userData')] : [])], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1', PYTHONPATH: root, AYANA_RUNTIME_TOKEN: token,
      ...(app.isPackaged ? { AYANA_DATA_DIR: app.getPath('userData') } : {}), },
  });
  child.stdout?.on('data', (chunk: Buffer) => diagnostic(chunk.toString('utf8').replaceAll(token, '[redacted]')));
  child.stderr?.on('data', (chunk: Buffer) => diagnostic(chunk.toString('utf8').replaceAll(token, '[redacted]')));
  child.on('error', (error) => {
    service = 'failed';
    diagnostic(`Spawn: ${error.message}`);
    desktopEvent('error', { code: 'runtime_launch', message: '无法启动 Python 服务。请配置 AYANA_PYTHON 或安装项目依赖。' });
    chat?.show();
  });
  child.on('exit', (code) => {
    if (quitting || restarting) return;
    service = 'failed';
    cancel();
    desktopEvent('desktop.service', { state: service, connected: false, exit_code: code });
  });
  connectRuntime();
}

async function restartRuntime() {
  if (restarting || quitting) return;
  restarting = true;
  try {
  cancel();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  socket?.terminate();
  const previous = child;
  child = undefined;
  if (previous && previous.exitCode === null) {
    await stopRuntime(previous);
  }
  recentEvents = [];
  currentGeneration = 0;
  desktopEvent('desktop.reset');
  // connectRuntime must be enabled before the new service is started.
  restarting = false;
  await startRuntime();
  } finally {
    restarting = false;
  }
}

async function stopRuntime(previous = child) {
  if (!previous || previous.exitCode !== null) return;
  try {
    await fetch(`http://127.0.0.1:${port}/shutdown`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2500),
    });
  } catch { /* A failed service is terminated after the bounded wait below. */ }
  if (previous.exitCode !== null) return;
  await new Promise<void>(resolve => {
    const timeout = setTimeout(() => { previous.kill(); resolve(); }, 8000);
    previous.once('exit', () => { clearTimeout(timeout); resolve(); });
  });
}

function windowId(window: BrowserWindow | undefined) {
  return !quitting && window && !window.isDestroyed() && !window.webContents.isDestroyed() ? window.webContents.id : undefined;
}

function trustedSender(id: number) {
  return [chat, settingsWindow, designWindow, highlight].some(win => windowId(win) === id);
}

function registerIpc() {
  ipcMain.handle('ayana:command', (event, value: unknown) => {
    if (![windowId(chat), windowId(settingsWindow), windowId(designWindow)].includes(event.sender.id)) return { ok: false, error: '不允许此窗口发送控制命令。' };
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: '命令格式无效。' };
    const command = value as Record<string, unknown>;
    if (!commands.has(String(command.type)) || JSON.stringify(command).length > 2_000_000) return { ok: false, error: '命令不在允许范围内。' };
    if (['turn.start', 'generation.cancel', 'session.close', 'conversation.create', 'conversation.select', 'conversation.materials.clear'].includes(String(command.type))) {
      desktopEvent('desktop.cancelled', { cancelled_generation_id: currentGeneration });
    }
    if (command.type === 'repository.inspect' && typeof command.root === 'string') repositoryRoot = command.root;
    return runtimeSend(command) ? { ok: true } : { ok: false, error: '本地服务未连接，请稍后重试。' };
  });
  ipcMain.on('ayana:playback', (event, value: unknown) => {
    if (event.sender.id !== windowId(chat) || !value || typeof value !== 'object') return;
    const receipt = value as Event;
    if (receipt.protocol_version !== 1 || !playbackTypes.has(receipt.type)) return;
    if (typeof receipt.utterance_id !== 'string' || typeof receipt.played_samples !== 'number') return;
    runtimeSend(receipt);
    broadcast(receipt, false);
  });
  ipcMain.handle('ayana:summon', (event) => trustedSender(event.sender.id) ? summon() : undefined);
  ipcMain.handle('ayana:hide', (event) => trustedSender(event.sender.id) ? hide() : undefined);
  ipcMain.on('ayana:companion-interactive', (event, interactive: unknown) => {
    if (!chat || event.sender.id !== windowId(chat) || typeof interactive !== 'boolean' || companionMenuOpen || companionDrag) return;
    chat.setIgnoreMouseEvents(!interactive, { forward: true });
  });
  ipcMain.on('ayana:companion-move', (event, dx: unknown, dy: unknown) => {
    if (!chat || event.sender.id !== windowId(chat) || typeof dx !== 'number' || typeof dy !== 'number'
      || !Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 2000 || Math.abs(dy) > 2000) return;
    const bounds = chat.getBounds();
    const next = { ...bounds, x: bounds.x + dx, y: bounds.y + dy };
    const placed = clampCompanion(next, screen.getDisplayMatching(next).workArea);
    chat.setBounds({ ...placed, ...companionSize(designPreview, screen.getDisplayMatching(placed).workArea) });
    queueCompanionPosition();
  });
  ipcMain.on('ayana:companion-drag-start', event => {
    if (event.sender.id !== windowId(chat) || !chat || companionDrag) return;
    chat.setIgnoreMouseEvents(false);
    const origin = chat.getBounds();
    companionDrag = { origin: { ...origin, ...companionSize(designPreview, screen.getDisplayMatching(origin).workArea) }, cursor: screen.getCursorScreenPoint(), moved: false, timer: setInterval(stepCompanionDrag, 16) };
  });
  ipcMain.on('ayana:companion-drag-end', event => { if (event.sender.id === windowId(chat)) endCompanionDrag(); });
  ipcMain.handle('ayana:design-open', event => { if (event.sender.id === windowId(chat)) openDesign(); });
  ipcMain.handle('ayana:design-close', event => { if ([windowId(chat), windowId(designWindow)].includes(event.sender.id)) closeDesign(); });
  ipcMain.on('ayana:design-preview', (event, value: unknown) => {
    if (event.sender.id !== windowId(designWindow) || !value || typeof value !== 'object' || Array.isArray(value)) return;
    const next = value as Record<string, unknown>;
    const bounds = { portrait_size: [220, 380], frame_width: [380, 900], frame_height: [320, 720], font_size: [18, 26], opacity: [0, 96] };
    if (Object.keys(next).some(key => !(key in defaults.companion_ui))) return;
    if (Object.entries(bounds).some(([key, [low, high]]) => key in next && (!Number.isInteger(next[key]) || Number(next[key]) < low || Number(next[key]) > high))) return;
    if (['show_subtitles', 'show_japanese'].some(key => key in next && typeof next[key] !== 'boolean')) return;
    if ('portrait_range' in next && !['half', 'full'].includes(String(next.portrait_range))) return;
    if ('background_mode' in next && !['transparent', 'frosted', 'image'].includes(String(next.background_mode))) return;
    designPreview = { ...designPreview, ...next };
    placeCompanion(); notifyDesignPreview();
  });
  ipcMain.handle('ayana:companion-menu', event => {
    if (!chat || event.sender.id !== windowId(chat) || companionMenuOpen) return;
    companionMenuOpen = true; chat.setIgnoreMouseEvents(false);
    Menu.buildFromTemplate(companionMenuItems()).popup({ window: chat, callback: () => { companionMenuOpen = false; } });
  });
  ipcMain.handle('ayana:settings', (event, tab?: unknown) => {
    if (!trustedSender(event.sender.id)) return;
    openManagement(tab === 'tasks' || tab === 'history' ? tab : undefined);
  });
  ipcMain.handle('ayana:note-background', async event => {
    if (![windowId(chat), windowId(designWindow)].includes(event.sender.id)) return { ok: false };
    const result = await dialog.showOpenDialog(event.sender.id === windowId(designWindow) ? designWindow! : chat!, { title: '选择便签背景', properties: ['openFile'], filters: [{ name: '背景图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (result.canceled || !result.filePaths[0]) return { ok: false };
    try {
      const bytes = readFileSync(result.filePaths[0]);
      if (bytes.length > 8_000_000) return { ok: false, error: '请选用小于 8MB 的图片。' };
      let image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) return { ok: false, error: '图片无法读取，请换一张。' };
      const { width, height } = image.getSize();
      const scale = Math.min(1, 1280 / Math.max(width, height));
      if (scale < 1) image = image.resize({ width: Math.round(width * scale), height: Math.round(height * scale) });
      writeFileSync(path.join(app.getPath('userData'), 'companion-background.png'), image.toPNG());
      broadcast({ protocol_version: 1, type: 'desktop.background-changed', revision: Date.now() }, false);
      return { ok: true };
    } catch { return { ok: false, error: '背景图片未保存，请重试。' }; }
  });
  ipcMain.handle('ayana:hide-settings', event => {
    if (event.sender.id === windowId(settingsWindow)) hideManagement();
  });
  ipcMain.handle('ayana:choose-repository', async (event) => {
    if (event.sender.id !== windowId(settingsWindow)) return null;
    const result = await dialog.showOpenDialog(settingsWindow!, { title: '选择仓库上下文', properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('ayana:choose-directory', async (event) => {
    if (event.sender.id !== windowId(settingsWindow)) return null;
    const result = await dialog.showOpenDialog(settingsWindow!, { title: '选择 Ayana 可访问的文本目录', properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('ayana:restart', (event) => event.sender.id === windowId(settingsWindow) ? restartRuntime() : undefined);
  ipcMain.handle('ayana:state', (event) => {
    if (!trustedSender(event.sender.id)) return null;
    return { connected: socket?.readyState === WebSocket.OPEN, service, version: app.getVersion(), repositoryRoot, events: recentEvents, composerRequested, designPreview, designOpen: designWindow?.isVisible() === true };
  });
}

function createWindow(kind: 'chat' | 'settings' | 'design' | 'highlight') {
  const overlay = kind !== 'settings';
  const { workArea } = screen.getPrimaryDisplay();
  const window = new BrowserWindow({
    width: kind === 'settings' ? Math.min(1160, workArea.width - 40) : kind === 'chat' ? companionSize(designPreview, workArea).width : kind === 'design' ? 336 : 300,
    height: kind === 'settings' ? Math.min(830, workArea.height - 40) : kind === 'chat' ? companionSize(designPreview, workArea).height : kind === 'design' ? Math.min(600, workArea.height - 32) : 140,
    minWidth: kind === 'settings' ? 820 : kind === 'chat' ? 240 : 40,
    minHeight: kind === 'settings' ? 480 : undefined,
    show: false, frame: !overlay, transparent: overlay, backgroundColor: overlay ? '#00000000' : '#f5f7fb',
    alwaysOnTop: overlay, focusable: kind !== 'highlight', skipTaskbar: overlay,
    title: kind === 'settings' ? 'Ayana · 设置与管理' : kind === 'design' ? '彩名 · 外观' : 'Ayana', autoHideMenuBar: true, hasShadow: !overlay,
    resizable: kind === 'settings',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  if (overlay) {
    if (kind === 'highlight') window.setIgnoreMouseEvents(true, { forward: true });
    window.setAlwaysOnTop(true, 'screen-saver');
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    const dev = process.env.AYANA_RENDERER_URL;
    const destination = new URL(url);
    const allowed = dev ? destination.origin === new URL(dev).origin
      : destination.href.split('?')[0] === pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
    if (!allowed) event.preventDefault();
  });
  if (process.env.AYANA_RENDERER_URL) {
    void window.loadURL(`${process.env.AYANA_RENDERER_URL}/?window=${kind}`);
  } else {
    void window.loadFile(path.join(__dirname, '../dist/index.html'), { query: { window: kind } });
  }
  if (kind === 'chat') {
    window.on('close', event => { if (!quitting) { event.preventDefault(); hide(); } });
    window.on('move', () => { queueCompanionPosition(); positionDesignWindow(); });
  }
  if (kind === 'design') window.on('close', event => { if (!quitting) { event.preventDefault(); closeDesign(); } });
  if (kind === 'settings') window.on('close', event => { if (!quitting) { event.preventDefault(); hideManagement(); } });
  window.on('closed', () => {
    if (window === chat) { endCompanionDrag(); chat = undefined; }
    if (window === settingsWindow) settingsWindow = undefined;
    if (window === designWindow) designWindow = undefined;
    if (window === highlight) highlight = undefined;
  });
  return window;
}

function placeCompanion(initial = false) {
  if (!chat || chat.isDestroyed() || companionDrag) return;
  let current = initial ? undefined : chat.getBounds();
  if (initial) {
    try {
      const saved = JSON.parse(readFileSync(path.join(app.getPath('userData'), 'companion-position.json'), 'utf8'));
      // Old positions describe the large invisible canvas; migrate away from its bottom lock.
      if (saved.version === 2 && Number.isFinite(saved.x) && Number.isFinite(saved.y)) current = { ...chat.getBounds(), x: saved.x, y: saved.y };
    } catch { /* First launch. */ }
  }
  const { workArea } = current ? screen.getDisplayMatching(current) : screen.getPrimaryDisplay();
  const size = companionSize(designPreview, workArea);
  const next = clampCompanion({ ...size, x: current?.x ?? workArea.x + workArea.width - size.width - 24,
    y: current?.y ?? workArea.y + (workArea.height - size.height) / 2 }, workArea);
  if (initial || !current || Math.abs(current.width - next.width) > 2 || Math.abs(current.height - next.height) > 2 || current.x !== next.x || current.y !== next.y) {
    chat.setBounds(next);
    positionDesignWindow();
  }
}

async function ready() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes;
    callback(webContents.id === windowId(chat) && permission === 'media'
      && Array.isArray(mediaTypes) && mediaTypes.every(type => type === 'audio'));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) =>
    webContents?.id === windowId(chat) && permission === 'media');
  protocol.handle('ayana-asset', async request => {
    const id = new URL(request.url).hostname;
    if (!/^[a-z0-9_-]{1,80}$/i.test(id) || !port || !token) return new Response(null, { status: 404 });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/assets/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } });
      return new Response(await response.arrayBuffer(), { status: response.status, headers: { 'Content-Type': response.headers.get('Content-Type') || 'image/png', 'Cache-Control': response.ok ? 'private, max-age=3600' : 'no-store', 'Access-Control-Allow-Origin': '*' } });
    } catch { return new Response(null, { status: 503 }); }
  });
  protocol.handle('ayana-background', request => {
    if (new URL(request.url).hostname !== 'custom') return new Response(null, { status: 404 });
    const file = path.join(app.getPath('userData'), 'companion-background.png');
    return existsSync(file) ? new Response(readFileSync(file), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } }) : new Response(null, { status: 404 });
  });
  chat = createWindow('chat');
  settingsWindow = createWindow('settings');
  designWindow = createWindow('design');
  highlight = createWindow('highlight');
  placeCompanion(true);
  screen.on('display-metrics-changed', () => placeCompanion());
  screen.on('display-removed', () => placeCompanion());
  // A small bundled bitmap is used so the tray remains available while offline.
  const iconPath = path.join(__dirname, '../dist/tray.png');
  const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('Ayana · 你的私人 Agent');
  tray.on('click', () => { void summon(); });
  updateShortcuts({});
  registerIpc();
  await startRuntime();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { void summon(); });
  void app.whenReady().then(ready).catch(error => { diagnostic(String(error)); app.quit(); });
}
app.on('window-all-closed', () => { if (quitting) app.quit(); });
app.on('before-quit', event => {
  event.preventDefault();
  quitting = true;
  endCompanionDrag(); persistCompanionPosition();
  globalShortcut.unregisterAll();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (highlightTimer) clearTimeout(highlightTimer);
  if (focusTimer) clearTimeout(focusTimer);
  socket?.terminate();
  tray?.destroy();
  void stopRuntime().finally(() => app.exit(0));
});
