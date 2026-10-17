import {
  app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage,
  protocol, screen, session, Tray,
  shell,
} from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import defaults from '../../../config/default.json';
import voicePackConfig from '../../../config/voice-pack.json';
import { clampCompanion, companionSize, companionDragBounds, inspectorBounds, type Bounds, type Point } from './companionGeometry';
import { releasePortableRuntime, stagePortableRuntime, type PortableRuntime } from './portableRuntime';
import { VoicePackManager, type VoicePackState } from './voicePack';
import { resolveTheme } from '../renderer/companionThemes';

type Event = Record<string, unknown> & { type: string; protocol_version: number };
const commands = new Set([
  'session.start', 'session.close', 'turn.start', 'generation.cancel',
  'settings.get', 'settings.update', 'history.get', 'utterance.displayed', 'input.audio',
  'capabilities.get', 'source.open',
  'conversations.get', 'conversation.create', 'conversation.select', 'conversation.rename', 'subtitles.translate',
  'conversation.history', 'conversation.search', 'conversation.export', 'conversation.delete',
  'memory.get', 'memory.update', 'memory.forget',
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
let welcomeWindow: BrowserWindow | undefined;
let welcomeReplay = false;
let welcomeRun = 0;
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
let summonRaised = false;
let refreshSummon = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let focusTimer: ReturnType<typeof setTimeout> | undefined;
let recentEvents: Event[] = [];
let summonShortcut = 'Control+Alt+A';
let cancelShortcut = 'Control+Alt+Space';
let talkShortcut = defaults.talk_hotkey;
let talkHold: { id: string; timer: ReturnType<typeof setTimeout> } | undefined;
let welcomeLeaving = false;
let inputAfterCapture = true;
let composerRequested = false;
let companionMenuOpen = false;
let companionPositionTimer: ReturnType<typeof setTimeout> | undefined;
let companionSettings: Record<string, unknown> = {};
let designPreview = { ...defaults.companion_ui };
let designDraft = { ...designPreview };
let designPreviewReverted = true;
const designSaves = new Map<string, typeof designDraft>();
let companionDrag: { origin: Bounds; cursor: Point; moved: boolean; timer: ReturnType<typeof setInterval> } | undefined;
let portableRuntime: PortableRuntime | undefined;
let voicePack: VoicePackManager | undefined;
const voiceConfigRequests = new Map<string, {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

function voicePackSettingsFile() {
  return path.join(app.getPath('userData'), 'config/voice-pack.json');
}

function voicePackConfiguration() {
  let personal: { manifest_url?: string; manifest_path?: string } = {};
  try {
    const file = voicePackSettingsFile();
    if (existsSync(file)) personal = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as typeof personal;
  } catch { /* A damaged override must not block the bundled manifest. */ }
  const manifestPath = String(process.env.AYANA_VOICE_PACK_MANIFEST_PATH || personal.manifest_path || voicePackConfig.manifest_path || '').trim();
  return {
    manifestUrl: String(process.env.AYANA_VOICE_PACK_MANIFEST || personal.manifest_url || voicePackConfig.manifest_url || '').trim(),
    manifestPath: manifestPath ? path.resolve(manifestPath) : '',
  };
}

function writeLocalVoice(voice: Record<string, unknown>) {
  const file = path.join(app.getPath('userData'), 'config/local.json');
  let current: Record<string, unknown> = {};
  try { current = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>; } catch { /* First profile. */ }
  const existing = current.voice && typeof current.voice === 'object' && !Array.isArray(current.voice)
    ? current.voice as Record<string, unknown> : {};
  const next = { ...current, voice: { ...existing, ...voice } };
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.voice-pack.tmp`;
  writeFileSync(temporary, JSON.stringify(next, null, 2), 'utf8');
  try { renameSync(temporary, file); }
  catch {
    rmSync(file, { force: true });
    renameSync(temporary, file);
  }
}

function applyVoiceConfig(voice: Record<string, unknown>): Promise<void> {
  if (socket?.readyState !== WebSocket.OPEN) {
    writeLocalVoice(voice);
    return Promise.resolve();
  }
  const requestId = randomBytes(12).toString('hex');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      voiceConfigRequests.delete(requestId);
      reject(new Error('写入语音配置超时，请重启 Ayana 后重试'));
    }, 30_000);
    voiceConfigRequests.set(requestId, { resolve, reject, timer });
    if (!runtimeSend({ type: 'settings.update', settings: { voice }, request_id: requestId, defer_voice: true })) {
      clearTimeout(timer);
      voiceConfigRequests.delete(requestId);
      try { writeLocalVoice(voice); resolve(); }
      catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
    }
  });
}

function voicePackManager(): VoicePackManager {
  if (!voicePack) {
    const config = voicePackConfiguration();
    const localAppData = process.env.LOCALAPPDATA || path.join(app.getPath('appData'), '..', 'Local');
    voicePack = new VoicePackManager({
      voiceRoot: path.join(localAppData, 'Ayana', 'voice'),
      stateFile: path.join(app.getPath('userData'), 'voice-pack-state.json'),
      manifestUrl: config.manifestUrl,
      manifestPath: config.manifestPath,
      applyVoice: applyVoiceConfig,
      onState: (state: VoicePackState) => broadcast({
        protocol_version: 1, type: 'voice.pack.state', ...state,
      }, false),
    });
    void voicePack.init().catch(() => {});
  }
  return voicePack;
}

async function restartApplication() {
  if (quitting) return;
  quitting = true;
  endCompanionDrag();
  persistCompanionPosition();
  globalShortcut.unregisterAll();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (focusTimer) clearTimeout(focusTimer);
  socket?.terminate();
  tray?.destroy();
  await stopRuntime();
  releasePortableRuntime(portableRuntime?.root);
  // A portable launch runs from %TEMP%; relaunch the original launcher so the
  // next session receives a fresh packaged runtime instead of a deleted copy.
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portable) app.relaunch({ execPath: portable, args: [] });
  else app.relaunch();
  app.exit(0);
}

function storedDesign(settings: Record<string, unknown>) {
  const stored = settings.companion_ui as Partial<typeof designPreview> || {};
  const primary = stored.primary_language || (settings.subtitles === false ? 'ja' : defaults.companion_ui.primary_language);
  const translation = stored.translation_language || (stored.show_japanese && primary !== 'ja' ? 'ja' : 'none');
  return { ...defaults.companion_ui, ...stored, theme: resolveTheme(stored), opacity: 100,
    background_mode: ['transparent', 'frosted'].includes(stored.background_mode || '') ? 'solid' : stored.background_mode || defaults.companion_ui.background_mode,
    primary_language: primary, translation_language: translation === primary ? 'none' : translation };
}

function persistCompanionPosition() {
  if (!chat || chat.isDestroyed()) return;
  if (companionPositionTimer) clearTimeout(companionPositionTimer);
  try { writeFileSync(path.join(app.getPath('userData'), 'companion-position.json'), JSON.stringify({ version: 3, ...chat.getBounds() })); } catch { /* Position is cosmetic. */ }
}

function queueCompanionPosition() {
  if (companionPositionTimer) clearTimeout(companionPositionTimer);
  companionPositionTimer = setTimeout(persistCompanionPosition, 180);
}

function positionDesignWindow() {
  if (!chat || chat.isDestroyed() || !designWindow || designWindow.isDestroyed() || !designWindow.isVisible()) return;
  const card = chat.getBounds();
  designWindow.setBounds(inspectorBounds(card, screen.getDisplayMatching(card).workArea, designPreview.portrait_side as 'left' | 'right'));
}

function notifyDesignPreview() {
  for (const [window, value] of [[chat, designPreview], [designWindow, designDraft]] as const) {
    if (windowId(window)) window!.webContents.send('ayana:event', { protocol_version: 1, type: 'desktop.design-preview', value });
  }
}

function revertDesignPreview() {
  designPreviewReverted = true;
  designPreview = storedDesign(companionSettings);
  placeCompanion(); notifyDesignPreview();
}

function openDesign() {
  if (!designWindow || !chat) return;
  designPreviewReverted = false;
  designPreview = { ...designDraft };
  designWindow.setBounds(inspectorBounds(chat.getBounds(), screen.getDisplayMatching(chat.getBounds()).workArea, designPreview.portrait_side as 'left' | 'right'));
  designWindow.show(); designWindow.focus();
  chat.setMovable(true);
  notifyDesignPreview();
  broadcast({ protocol_version: 1, type: 'desktop.design-visibility', open: true }, false);
}

function closeDesign() {
  endCompanionDrag();
  chat?.setMovable(true);
  designWindow?.hide();
  revertDesignPreview();
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

// The portable NSIS target extracts the app into %TEMP%. Keep a hard-linked
// duplicate of the runtime under userData so a temp cleaner cannot delete the
// persona, assets or importable Python modules of a running session.
function stageRuntime() {
  if (portableRuntime || !app.isPackaged || !process.env.PORTABLE_EXECUTABLE_FILE) return;
  try {
    portableRuntime = stagePortableRuntime(process.resourcesPath, app.getPath('userData'));
    diagnostic(`Portable runtime staged: ${portableRuntime.root}`);
  } catch (error) {
    diagnostic(`Portable runtime staging failed, using %TEMP%: ${String(error)}`);
  }
}

function backendRoot(): string {
  return process.env.AYANA_REPOSITORY_ROOT
    || portableRuntime?.backend
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
  if (remember && !event.type.startsWith('audio.') && !event.type.startsWith('playback.')
      && !['conversation.review', 'conversation.search-results', 'conversation.exported'].includes(event.type)) {
    if (event.type === 'conversation.changed') {
      const retained = new Set(['settings.ready', 'service.state', 'desktop.service', 'desktop.shortcuts', 'capabilities.ready']);
      recentEvents = recentEvents.filter(previous => retained.has(previous.type));
    }
    if (event.type === 'conversation.deleted') recentEvents = recentEvents.filter(previous => previous.conversation_id !== event.deleted_id);
    if (['settings.ready', 'history.ready', 'conversations.ready', 'context.state', 'memory.ready', 'sources.ready'].includes(event.type)) {
      recentEvents = recentEvents.filter(previous => previous.type !== event.type);
    }
    recentEvents.push(event);
    const snapshots = new Set(['settings.ready', 'history.ready', 'conversations.ready', 'conversation.changed', 'context.state', 'memory.ready', 'sources.ready']);
    recentEvents = recentEvents.filter((previous, index) => snapshots.has(previous.type) || index >= recentEvents.length - 160);
  }
  for (const window of [chat, settingsWindow, designWindow, welcomeWindow]) {
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
}

function stopCurrent() { endTalking(true); cancel(); }

function endTalking(cancelled = false, id?: string) {
  if (!talkHold || (id && id !== talkHold.id)) return;
  const hold = talkHold;
  talkHold = undefined;
  clearTimeout(hold.timer);
  runtimeSend({ type: 'input.hold-cancel' });
  broadcast({ protocol_version: 1, type: 'desktop.talk-ended', hold_id: hold.id, cancelled }, false);
}

function startTalking(global = false) {
  if (talkHold || !windowId(chat) || welcomeWindow?.isVisible() || socket?.readyState !== WebSocket.OPEN) return { ok: false };
  const id = randomBytes(12).toString('hex');
  talkHold = { id, timer: setTimeout(() => endTalking(false, id), 60_000) };
  cancel();
  if (!chat!.isVisible()) summon(false);
  requestComposer();
  broadcast({ protocol_version: 1, type: 'desktop.talk-started', hold_id: id }, false);
  if (global) runtimeSend({ type: 'input.hold-watch', hold_id: id });
  return { ok: true, hold_id: id };
}

function hide() {
  endTalking(true);
  endCompanionDrag(); closeDesign();
  composerRequested = false;
  focusAfterCapture = false;
  summonPending = false;
  companionShown = false;
  summonRaised = false;
  refreshSummon = false;
  if (focusTimer) clearTimeout(focusTimer);
  cancel();
  runtimeSend({ type: 'session.close' });
  chat?.hide();
  desktopEvent('desktop.hidden');
}

function summon(openInput = true) {
  if (welcomeWindow?.isVisible()) { welcomeWindow.show(); welcomeWindow.focus(); return; }
  // The first explicit invocation raises her; the next hides her even when
  // Windows declines focus or changes focus while dispatching the shortcut.
  if (chat?.isVisible() && summonRaised) {
    hide();
    return;
  }
  if (chat?.isVisible()) {
    summonRaised = openInput;
    chat.setAlwaysOnTop(true, 'screen-saver');
    chat.moveTop();
    if (openInput) requestComposer();
    return;
  }
  if (summonPending) return;
  summonRaised = openInput;
  inputAfterCapture = openInput;
  focusAfterCapture = true;
  refreshSummon = false;
  if (!runtimeSend({ type: 'session.start' })) {
    summonPending = true;
    chat?.setAlwaysOnTop(true, 'screen-saver');
    chat?.showInactive();
    desktopEvent('desktop.summoned');
    desktopEvent('desktop.service', { state: service, message: '本地服务正在启动…' });
    return;
  }
  if (focusTimer) clearTimeout(focusTimer);
  focusTimer = setTimeout(() => focusChat(), 3000);
}

function focusChat() {
  if (!focusAfterCapture) return;
  focusAfterCapture = false;
  if (focusTimer) clearTimeout(focusTimer);
  chat?.setAlwaysOnTop(true, 'screen-saver');
  if (chat?.isMinimized()) chat.restore();
  if (inputAfterCapture) chat?.show(); else chat?.showInactive();
  chat?.moveTop();
  refreshSummon = false;
  companionShown = true;
  desktopEvent('desktop.summoned');
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

function openManagement(tab?: 'history' | 'model') {
  closeDesign();
  summonRaised = false;
  // The transparent companion must not cover the management window's controls.
  chat?.setAlwaysOnTop(true, 'screen-saver');
  settingsWindow?.setAlwaysOnTop(true, 'screen-saver');
  settingsWindow?.show(); settingsWindow?.moveTop(); settingsWindow?.focus();
  broadcast({ protocol_version: 1, type: 'desktop.navigate', tab: tab || 'settings' }, false);
}

function hideManagement() {
  settingsWindow?.hide();
  chat?.setAlwaysOnTop(true, 'screen-saver');
}

function openWelcome(replay = false) {
  if (welcomeWindow?.isVisible()) { welcomeWindow.focus(); return; }
  welcomeReplay = replay;
  welcomeRun += 1;
  hide();
  settingsWindow?.hide();
  if (!welcomeWindow || welcomeWindow.isDestroyed()) {
    welcomeWindow = createWindow('welcome');
    welcomeWindow.once('ready-to-show', () => { welcomeWindow?.show(); welcomeWindow?.focus(); registerWindows(); });
  } else {
    broadcast({ protocol_version: 1, type: 'desktop.welcome-open', replay, run: welcomeRun }, false);
    welcomeWindow.show(); welcomeWindow.focus();
  }
}

function companionMenuItems(): Electron.MenuItemConstructorOptions[] {
  return [
    { label: '输入一句', click: requestComposer },
    { label: '调整外观', click: openDesign },
    { label: '开始新话题', click: () => { requestComposer(); broadcast({ protocol_version: 1, type: 'desktop.new-topic' }, false); } },
    { label: `立即打断 · ${cancelShortcut}`, click: stopCurrent },
    { type: 'separator' },
    { label: '显示中文字幕', type: 'checkbox', checked: companionSettings.subtitles !== false,
      click: item => { runtimeSend({ type: 'settings.update', settings: { subtitles: item.checked } }); } },
    { label: '话题与记录', click: () => openManagement('history') },
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
    hwnds: [chat, settingsWindow, designWindow, welcomeWindow].filter((win): win is BrowserWindow => !!win && !win.isDestroyed()).map(windowHandle),
  });
}

function updateShortcuts(settings: Record<string, unknown>) {
  const raw = settings.shortcuts as Record<string, unknown> | undefined;
  const nextSummon = String(raw?.summon || settings.hotkey || settings.summon_shortcut || summonShortcut);
  const nextCancel = String(raw?.cancel || settings.cancel_hotkey || settings.cancel_shortcut || cancelShortcut);
  const nextTalk = String(settings.talk_hotkey || defaults.talk_hotkey);
  if (nextTalk !== talkShortcut) endTalking(true);
  globalShortcut.unregisterAll();
  summonShortcut = nextSummon;
  cancelShortcut = nextCancel;
  talkShortcut = nextTalk;
  let summonOk = false;
  let cancelOk = false;
  let talkOk = false;
  try { summonOk = globalShortcut.register(summonShortcut, () => { summon(); }); } catch { /* Invalid accelerator. */ }
  try { cancelOk = globalShortcut.register(cancelShortcut, stopCurrent); } catch { /* Invalid accelerator. */ }
  try { talkOk = globalShortcut.register(talkShortcut, () => { startTalking(true); }); } catch { /* Invalid accelerator. */ }
  desktopEvent('desktop.shortcuts', { summon: summonShortcut, cancel: cancelShortcut, talk: talkShortcut, summon_ok: summonOk, cancel_ok: cancelOk, talk_ok: talkOk });
  if (tray) tray.setContextMenu(Menu.buildFromTemplate([
    { label: `呼出 Ayana · ${summonShortcut}`, click: () => { summon(); } },
    { label: `停止当前回复 · ${cancelShortcut}`, click: stopCurrent },
    { label: '收起会话', click: hide },
    { label: '话题与记录', click: () => openManagement('history') },
    { label: '设置与管理', click: () => openManagement() },
    { type: 'separator' },
    { label: '重新启动本地服务', click: () => { void restartRuntime(); } },
    { label: '退出 Ayana', click: () => { quitting = true; app.quit(); } },
  ]));
}

function receive(event: Event) {
  if (event.protocol_version !== 1 || typeof event.type !== 'string') return;
  if (event.type === 'desktop.reset') {
    endTalking(true);
    for (const [requestId, pending] of voiceConfigRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('服务已重启，请重新应用语音配置'));
      voiceConfigRequests.delete(requestId);
    }
  }
  if (event.type === 'input.hold-ended') {
    endTalking(event.reason === 'unavailable', String(event.hold_id));
    return;
  }
  const configRequest = String(event.request_id || '');
  const configPending = voiceConfigRequests.get(configRequest);
  if (configPending && (event.type === 'settings.ready' || event.type === 'error')) {
    clearTimeout(configPending.timer);
    voiceConfigRequests.delete(configRequest);
    if (event.type === 'settings.ready') configPending.resolve();
    else configPending.reject(new Error(String(event.message || event.error || '语音配置写入失败')));
  }
  if (event.type === 'conversation.exported') {
    const file = String(event.path || '');
    const directory = path.join(app.getPath('userData'), 'artifacts', 'conversations');
    if (path.dirname(file) === directory && /\.(md|json)$/.test(file) && existsSync(file)) shell.showItemInFolder(file);
  }
  // Historical translations keep their original generation. They must not
  // make a desktop cancel reject newer audio from this running session.
  if (!['subtitle.translated', 'subtitle.translation-failed'].includes(event.type)
      && typeof event.generation_id === 'number') currentGeneration = Math.max(currentGeneration, event.generation_id);
  if (event.type === 'source.open') {
    void (async () => {
      try {
        const url = new URL(String(event.url));
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid source URL');
        await shell.openExternal(url.href);
        broadcast({ protocol_version: 1, type: 'source.opened', source_id: event.source_id, request_id: event.request_id }, false);
      } catch {
        broadcast({ protocol_version: 1, type: 'error', source: 'source.open', request_id: event.request_id, message: '网页未打开，请检查默认浏览器后重试。' }, false);
      }
    })();
    return;
  }
  if (event.type === 'settings.ready') {
    const settings = (event.settings ?? {}) as Record<string, unknown>;
    const before = storedDesign(companionSettings);
    const requestId = String(event.request_id || '');
    const baseline = designSaves.get(requestId) || before;
    const edits = Object.fromEntries(Object.entries(designDraft).filter(([key, value]) => value !== baseline[key as keyof typeof baseline]));
    designSaves.delete(requestId);
    designDraft = { ...storedDesign(settings), ...edits };
    designPreview = designWindow?.isVisible() && !designPreviewReverted ? { ...designDraft } : storedDesign(settings);
    companionSettings = settings;
    placeCompanion(); notifyDesignPreview();
    updateShortcuts(settings);
    if (!startupSummonDone) {
      startupSummonDone = true;
      if (Number(settings.onboarding_version || 0) < 1) openWelcome();
      else { summonPending = false; summon(false); }
    }
  }
  if (event.type === 'error' && designSaves.delete(String(event.request_id || ''))) revertDesignPreview();
  if (event.type === 'session.started' && focusAfterCapture) focusChat();
  if (event.type === 'error') focusChat();
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
    if (startupSummonDone && summonPending) {
      const openInput = summonPending ? inputAfterCapture : false;
      summonPending = false;
      startupSummonDone = true;
      companionShown = false;
      summon(openInput);
    }
  });
  ws.on('message', (raw) => {
    try { receive(JSON.parse(raw.toString()) as Event); }
    catch { desktopEvent('error', { code: 'invalid_runtime_event', message: '本地服务返回了无法读取的事件。' }); }
  });
  ws.on('error', (error) => diagnostic(`Connection: ${error.message}`));
  ws.on('close', () => {
    if (socket !== ws || quitting || restarting) return;
    endTalking(true);
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
  stageRuntime();
  const root = backendRoot();
  const bundled = portableRuntime?.python ?? path.join(process.resourcesPath, 'python', 'python.exe');
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
  stopCurrent();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  socket?.terminate();
  const previous = child;
  child = undefined;
  if (previous && previous.exitCode === null) {
    await stopRuntime(previous);
  }
  recentEvents = [];
  designSaves.clear(); revertDesignPreview();
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
  return [chat, settingsWindow, designWindow, welcomeWindow].some(win => windowId(win) === id);
}

function registerIpc() {
  ipcMain.handle('ayana:talk-start', event => event.sender.id === windowId(chat) ? startTalking() : { ok: false });
  ipcMain.handle('ayana:talk-end', (event, id?: unknown, cancelled?: unknown) => {
    if (event.sender.id === windowId(chat) && typeof id === 'string') endTalking(cancelled === true, id);
  });
  ipcMain.handle('ayana:command', (event, value: unknown) => {
    if (!trustedSender(event.sender.id)) return { ok: false, error: '不允许此窗口发送控制命令。' };
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: '命令格式无效。' };
    const command = value as Record<string, unknown>;
    if (event.sender.id === windowId(welcomeWindow) && !['settings.get', 'settings.update', 'capabilities.get'].includes(String(command.type))) return { ok: false, error: '开场窗口不支持此命令。' };
    if (!commands.has(String(command.type)) || JSON.stringify(command).length > 2_000_000) return { ok: false, error: '命令不在允许范围内。' };
    if (['turn.start', 'generation.cancel', 'session.close', 'conversation.create', 'conversation.select'].includes(String(command.type))) {
      desktopEvent('desktop.cancelled', { cancelled_generation_id: currentGeneration });
    }
    const designRequest = command.type === 'settings.update' && typeof command.request_id === 'string'
      && Boolean((command.settings as Record<string, unknown> | undefined)?.companion_ui);
    if (designRequest) designSaves.set(String(command.request_id), { ...designDraft });
    if (runtimeSend(command)) return { ok: true };
    if (designRequest) { designSaves.delete(String(command.request_id)); revertDesignPreview(); }
    return { ok: false, error: '本地服务未连接，请稍后重试。' };
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
    // Windows owns hit testing through the card's native region. Ignoring the whole
    // window also ignores WM_NCHITTEST and prevents a system titlebar drag.
  });
  ipcMain.on('ayana:companion-move', (event, dx: unknown, dy: unknown) => {
    if (!chat || event.sender.id !== windowId(chat) || typeof dx !== 'number' || typeof dy !== 'number'
      || !Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 2000 || Math.abs(dy) > 2000) return;
    const bounds = chat.getBounds();
    const next = { ...bounds, x: bounds.x + dx, y: bounds.y + dy };
    const placed = clampCompanion(next, screen.getDisplayMatching(next).workArea);
    chat.setBounds(placed);
    queueCompanionPosition();
  });
  ipcMain.on('ayana:companion-drag-start', event => {
    if (event.sender.id !== windowId(chat) || !chat || companionDrag) return;
    chat.setIgnoreMouseEvents(false);
    const origin = chat.getBounds();
    companionDrag = { origin, cursor: screen.getCursorScreenPoint(), moved: false, timer: setInterval(stepCompanionDrag, 16) };
  });
  ipcMain.on('ayana:companion-drag-end', event => { if (event.sender.id === windowId(chat)) endCompanionDrag(); });
  ipcMain.handle('ayana:design-open', event => { if (event.sender.id === windowId(chat)) openDesign(); });
  ipcMain.handle('ayana:design-close', event => { if ([windowId(chat), windowId(designWindow)].includes(event.sender.id)) closeDesign(); });
  ipcMain.handle('ayana:design-revert-preview', event => { if (event.sender.id === windowId(designWindow)) revertDesignPreview(); });
  ipcMain.on('ayana:design-preview', (event, value: unknown) => {
    if (![windowId(designWindow), windowId(chat)].includes(event.sender.id) || !value || typeof value !== 'object' || Array.isArray(value)) return;
    const next = value as Record<string, unknown>;
    const bounds = { portrait_size: [160, 640], frame_width: [380, 900], frame_height: [320, 720], font_size: [14, 40], opacity: [0, 100], portrait_x: [-4096, 4096], portrait_y: [-4096, 4096], background_x: [0, 100], background_y: [0, 100], background_zoom: [100, 300] };
    if (Object.keys(next).some(key => !(key in defaults.companion_ui))) return;
    if (Object.entries(bounds).some(([key, [low, high]]) => key in next && (!Number.isInteger(next[key]) || Number(next[key]) < low || Number(next[key]) > high))) return;
    if (['show_subtitles', 'show_japanese', 'show_bubbles'].some(key => key in next && typeof next[key] !== 'boolean')) return;
    if ('portrait_range' in next && !['half', 'full'].includes(String(next.portrait_range))) return;
    if ('background_mode' in next && !['transparent', 'frosted', 'image', 'minimal', 'solid'].includes(String(next.background_mode))) return;
    if ('theme' in next && !['ink', 'paper', 'forest', 'sea', 'custom'].includes(String(next.theme))) return;
    if (['background_color', 'bubble_color'].some(key => key in next && (typeof next[key] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(String(next[key]))))) return;
    if ('background_image' in next && (typeof next.background_image !== 'string' || !/^(?:[0-9a-f]{64})?$/.test(next.background_image))) return;
    if ('portrait_side' in next && !['left', 'right'].includes(String(next.portrait_side))) return;
    if ('primary_language' in next && !['ja', 'zh', 'en'].includes(String(next.primary_language))) return;
    if ('translation_language' in next && !['none', 'ja', 'zh', 'en'].includes(String(next.translation_language))) return;
    designDraft = { ...designDraft, ...next };
    if (designWindow?.isVisible()) { designPreviewReverted = false; designPreview = { ...designDraft }; }
    placeCompanion();
    if ('portrait_side' in next) positionDesignWindow();
    notifyDesignPreview();
  });
  ipcMain.handle('ayana:companion-menu', event => {
    if (!chat || event.sender.id !== windowId(chat) || companionMenuOpen) return;
    companionMenuOpen = true; chat.setIgnoreMouseEvents(false);
    Menu.buildFromTemplate(companionMenuItems()).popup({ window: chat, callback: () => { companionMenuOpen = false; } });
  });
  ipcMain.handle('ayana:settings', (event, tab?: unknown) => {
    if (!trustedSender(event.sender.id)) return;
    openManagement(tab === 'history' || tab === 'model' ? tab : undefined);
  });
  ipcMain.handle('ayana:welcome-open', event => {
    if ([windowId(settingsWindow), windowId(chat)].includes(event.sender.id)) openWelcome(true);
  });
  ipcMain.handle('ayana:welcome-target', async event => {
    if (event.sender.id !== windowId(welcomeWindow) || !chat || !welcomeWindow) return null;
    const bounds = chat.getBounds();
    const origin = welcomeWindow.getBounds();
    try {
      const portrait = await chat.webContents.executeJavaScript(`(() => {
        const image = document.querySelector('.portrait-stage .character');
        if (!image) return null;
        const r = image.getBoundingClientRect();
        const scale = Math.min(r.width / image.naturalWidth, r.height / image.naturalHeight);
        const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
        return width > 0 && height > 0 ? { x: r.x + (r.width - width) / 2, y: r.y + (r.height - height) / 2,
          width, height, asset: new URL(image.src).hostname } : null;
      })()`);
      return portrait ? { ...portrait, x: bounds.x - origin.x + portrait.x, y: bounds.y - origin.y + portrait.y } : null;
    } catch { return null; }
  });
  ipcMain.handle('ayana:welcome-finish', async (event, configure?: unknown) => {
    if (event.sender.id !== windowId(welcomeWindow)) return { ok: false };
    if (Number(companionSettings.onboarding_version || 0) < 1 || !String(companionSettings.user_name || '').trim()) return { ok: false, error: '请先保存名字。' };
    if (welcomeLeaving || !chat || chat.isDestroyed() || !welcomeWindow) return { ok: false };
    welcomeLeaving = true;
    const introduction = welcomeWindow, companion = chat;
    try {
      // Both native windows remain composited throughout the handoff.
      companion.setOpacity(0);
      companion.showInactive();
      introduction.moveTop();
      focusAfterCapture = false;
      companionShown = true;
      runtimeSend({ type: 'session.start' });
      await new Promise<void>(resolve => {
        const started = performance.now();
        const timer = setInterval(() => {
          const t = Math.min(1, (performance.now() - started) / 650);
          const eased = t * t * (3 - 2 * t);
          if (!companion.isDestroyed()) companion.setOpacity(eased);
          if (!introduction.isDestroyed()) introduction.setOpacity(1 - eased);
          if (t >= 1 || companion.isDestroyed() || introduction.isDestroyed()) { clearInterval(timer); resolve(); }
        }, 16);
      });
      if (!introduction.isDestroyed()) introduction.hide();
    } finally {
      if (!companion.isDestroyed()) companion.setOpacity(1);
      if (!introduction.isDestroyed()) introduction.setOpacity(1);
      welcomeLeaving = false;
    }
    if (configure === true) openManagement('model');
    return { ok: true };
  });
  ipcMain.handle('ayana:welcome-close', event => {
    if (event.sender.id !== windowId(welcomeWindow)) return;
    if (welcomeReplay) { welcomeWindow?.hide(); summon(false); }
    else app.quit();
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
      const png = image.toPNG();
      const imageId = createHash('sha256').update(png).digest('hex');
      // Immutable assets keep an unsaved replacement from overwriting the saved background.
      writeFileSync(path.join(app.getPath('userData'), `companion-background-${imageId}.png`), png);
      broadcast({ protocol_version: 1, type: 'desktop.background-changed', revision: Date.now() }, false);
      return { ok: true, imageId };
    } catch { return { ok: false, error: '背景图片未保存，请重试。' }; }
  });
  ipcMain.handle('ayana:hide-settings', event => {
    if (event.sender.id === windowId(settingsWindow)) hideManagement();
  });
  ipcMain.handle('ayana:restart', (event) => event.sender.id === windowId(settingsWindow) ? restartRuntime() : undefined);
  ipcMain.handle('ayana:voice-pack', (event) =>
    trustedSender(event.sender.id) ? voicePackManager().getState() : null);
  ipcMain.handle('ayana:voice-pack-start', (event) => {
    if (!trustedSender(event.sender.id)) return null;
    const manager = voicePackManager();
    void manager.start();
    return manager.getState();
  });
  ipcMain.handle('ayana:voice-pack-cancel', (event) =>
    trustedSender(event.sender.id) ? (voicePack || voicePackManager()).cancel() : null);
  ipcMain.handle('ayana:voice-pack-import', async (event) => {
    if (!trustedSender(event.sender.id)) return null;
    const owner = event.sender.id === windowId(chat) ? chat : settingsWindow;
    if (!owner) return null;
    const result = await dialog.showOpenDialog(owner, {
      title: '导入 Ayana 语音资源包',
      properties: ['openFile'],
      filters: [{ name: '语音资源包', extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePaths[0]) return voicePackManager().getState();
    const manager = voicePackManager();
    void manager.importLocal(result.filePaths[0]);
    return manager.getState();
  });
  ipcMain.handle('ayana:app-restart', (event) => {
    if (!trustedSender(event.sender.id)) return;
    void restartApplication();
  });
  ipcMain.handle('ayana:state', (event) => {
    if (!trustedSender(event.sender.id)) return null;
    return { connected: socket?.readyState === WebSocket.OPEN, service, version: app.getVersion(), events: recentEvents, composerRequested, designPreview, designDraft, designOpen: designWindow?.isVisible() === true };
  });
}

function createWindow(kind: 'chat' | 'settings' | 'design' | 'welcome') {
  const overlay = kind !== 'settings';
  const { workArea } = screen.getPrimaryDisplay();
  const window = new BrowserWindow({
    ...(kind === 'welcome' ? { x: workArea.x, y: workArea.y } : {}),
    width: kind === 'welcome' ? workArea.width : kind === 'settings' ? Math.min(1160, workArea.width - 40) : kind === 'chat' ? companionSize(designPreview, workArea).width : 336,
    height: kind === 'welcome' ? workArea.height : kind === 'settings' ? Math.min(830, workArea.height - 40) : kind === 'chat' ? companionSize(designPreview, workArea).height : Math.min(600, workArea.height - 32),
    minWidth: kind === 'settings' ? 820 : kind === 'chat' ? Math.min(380, workArea.width - 32) : 40,
    minHeight: kind === 'settings' ? 480 : kind === 'chat' ? Math.min(320, workArea.height - 32) : undefined,
    show: false, frame: !overlay, transparent: overlay, backgroundColor: overlay ? '#00000000' : '#f5f7fb',
    alwaysOnTop: overlay, skipTaskbar: overlay && kind !== 'welcome',
    title: kind === 'welcome' ? 'Ayana · 初次见面' : kind === 'settings' ? 'Ayana · 设置与管理' : kind === 'design' ? '彩名 · 外观' : 'Ayana', autoHideMenuBar: true, hasShadow: !overlay,
    resizable: kind === 'settings' || kind === 'chat',
    movable: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  if (overlay) {
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
    // Keep the native border intact: a cropped region removes Windows' resize hit targets.
    window.on('resize', () => { queueCompanionPosition(); positionDesignWindow(); });
  }
  if (kind === 'design') window.on('close', event => { if (!quitting) { event.preventDefault(); closeDesign(); } });
  if (kind === 'settings') window.on('close', event => { if (!quitting) { event.preventDefault(); hideManagement(); } });
  if (kind === 'welcome') window.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    if (welcomeReplay) { window.hide(); summon(false); }
    else app.quit();
  });
  if (kind === 'welcome') window.on('hide', () => broadcast({ protocol_version: 1, type: 'desktop.welcome-hidden' }, false));
  window.on('closed', () => {
    if (window === chat) { endCompanionDrag(); chat = undefined; }
    if (window === settingsWindow) settingsWindow = undefined;
    if (window === designWindow) designWindow = undefined;
    if (window === welcomeWindow) welcomeWindow = undefined;
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
      if ([2, 3].includes(saved.version) && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        current = { ...chat.getBounds(), x: saved.x, y: saved.y };
        if (saved.version === 3 && Number.isFinite(saved.width) && saved.width >= 240 && Number.isFinite(saved.height) && saved.height >= 200) {
          current.width = saved.width; current.height = saved.height;
        }
      }
    } catch { /* First launch. */ }
  }
  const { workArea } = current ? screen.getDisplayMatching(current) : screen.getPrimaryDisplay();
  // Appearance preview and runtime snapshots must never undo a user's native resize.
  const size = current ? { width: Math.min(current.width, workArea.width - 32), height: Math.min(current.height, workArea.height - 32) }
    : companionSize(designPreview, workArea);
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
    const url = new URL(request.url);
    const imageId = url.searchParams.get('image') || '';
    if (url.hostname !== 'custom' || !/^(?:[0-9a-f]{64})?$/.test(imageId)) return new Response(null, { status: 404 });
    const file = path.join(app.getPath('userData'), imageId ? `companion-background-${imageId}.png` : 'companion-background.png');
    return existsSync(file) ? new Response(readFileSync(file), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } }) : new Response(null, { status: 404 });
  });
  voicePackManager();
  chat = createWindow('chat');
  settingsWindow = createWindow('settings');
  designWindow = createWindow('design');
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
  endTalking(true);
  endCompanionDrag(); persistCompanionPosition();
  globalShortcut.unregisterAll();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (focusTimer) clearTimeout(focusTimer);
  socket?.terminate();
  tray?.destroy();
  void stopRuntime().finally(() => {
    releasePortableRuntime(portableRuntime?.root);
    app.exit(0);
  });
});
