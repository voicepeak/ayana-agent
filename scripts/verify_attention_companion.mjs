/** Native visibility and conversation deletion, isolated from the user's profile. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const runtimeRoot = process.argv[2] || root;
const packagedExecutable = process.argv[3];
const { _electron } = require(require.resolve('playwright', { paths: [runtimeRoot] }));
const directory = path.join(root, '.runtime/benchmarks', `attention-companion-${Date.now()}`);
const profile = path.join(directory, 'profile');
mkdirSync(path.join(profile, 'config'), { recursive: true });
writeFileSync(path.join(profile, 'config/local.json'), JSON.stringify({ provider: 'local', save_history: true,
  send_screenshot: false, ambient_attention: false, voice: { voice_mode: 'silent' }, stt: { provider: 'disabled' },
  hotkey: 'Control+Alt+F6', cancel_hotkey: 'Control+Alt+F7' }));
execFileSync(path.join(root, '.venv/Scripts/python.exe'), ['-X', 'utf8', '-c', `
from pathlib import Path
from services.agent.storage import ConversationStore
import sys,time
s=ConversationStore(Path(sys.argv[1]))
for i,title in enumerate(['保留的对话','准备删除的对话']):
 cid='attention-chat-'+str(i)
 s.put_record('conversation',cid,dict(conversation_id=cid,title=title,auto_title=False,preview='这是测试消息',created=time.time(),updated=time.time()-i,repository_root=None))
 s.commit(dict(type='user.message',conversation_id=cid,text='DELETE-FIXTURE-SECRET' if i else 'KEEP-FIXTURE',turn_id='seed-'+str(i),generation_id=0))
s.put_record('conversation-state','active',dict(conversation_id='attention-chat-0'))
s.close()
`, path.join(profile, '.runtime/history.sqlite3')], { cwd: root, windowsHide: true });

let app;
let chat;
const report = { directory, checks: [] };
// Transparent windows can lose CDP pointer input when another app is topmost.
// Packaged checks exercise the same React handlers without relying on OS focus.
const activate = locator => packagedExecutable ? locator.dispatchEvent('click') : locator.click();
try {
  const environment = { ...process.env, AYANA_DATA_DIR: profile };
  if (packagedExecutable) {
    environment.AYANA_REPOSITORY_ROOT = path.join(path.dirname(packagedExecutable), 'resources/backend');
    environment.AYANA_PYTHON = path.join(path.dirname(packagedExecutable), 'resources/python/python.exe');
  } else {
    environment.AYANA_REPOSITORY_ROOT = root;
    environment.AYANA_PYTHON = path.join(root, '.venv/Scripts/python.exe');
  }
  app = await _electron.launch({ executablePath: packagedExecutable || path.join(root, 'apps/desktop/node_modules/electron/dist/electron.exe'),
    args: [...(packagedExecutable ? [] : [path.join(root, 'apps/desktop')]), `--user-data-dir=${profile}`, '--disable-gpu',
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
    env: environment, timeout: 60000 });
  await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.webContents.setBackgroundThrottling(false)));
  chat = (await app.windows()).find(page => page.url().includes('window=chat'));
  assert(chat);
  await chat.waitForFunction(() => window.ayana.getState().then(s => s.connected && s.events.some(e => e.type === 'conversations.ready')), null, { timeout: 30000 });
  assert.equal(await chat.getByRole('button', { name: '输入回复', exact: true }).count(), 0);
  report.checks.push('obsolete bubble button removed');
  const native = () => app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=chat'));
    return { visible: window.isVisible(), focused: window.isFocused(), top: window.isAlwaysOnTop() };
  });
  const toggle = () => chat.evaluate(() => window.ayana.summon());
  await chat.evaluate(() => window.ayana.openSettings());
  for (let i = 0; i < 30; i++) {
    const settingsFocused = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=settings')).isFocused());
    if (settingsFocused) break;
    await chat.waitForTimeout(100);
  }
  assert.equal((await native()).top, true);
  await toggle();
  await chat.waitForTimeout(200);
  assert.equal((await native()).visible, true);
  assert.equal((await native()).top, true);
  report.checks.push('background companion raised; management does not remove topmost');
  await toggle();
  await chat.waitForTimeout(150);
  assert.equal((await native()).visible, false);
  await toggle();
  await chat.waitForTimeout(200);
  assert.equal((await native()).visible, true);
  assert.equal((await native()).top, true);
  report.checks.push('second toggle hides even if Windows declines focus; next toggle restores topmost');
  await chat.evaluate(() => window.ayana.hideSettings());
  const hwnd = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=chat')).getNativeWindowHandle().readUInt32LE(0));
  execFileSync(path.join(root, '.venv/Scripts/python.exe'), ['-c', 'from native.windows.win32 import Win32; import sys; print(Win32().focus(int(sys.argv[1])))', String(hwnd)], { cwd: root, windowsHide: true });
  await chat.bringToFront();
  await chat.waitForTimeout(500);
  const captureNative = name => execFileSync(path.join(root, '.venv/Scripts/python.exe'), ['-c',
    'from native.windows.win32 import Win32; import sys; a=Win32(); a.image(a.identity(int(sys.argv[1]))).save(sys.argv[2])',
    String(hwnd), path.join(directory, name)], { cwd: root, windowsHide: true, timeout: 10000 });
  const capture = async name => {
    try {
      await chat.screenshot({ path: path.join(directory, name), omitBackground: true, timeout: 5000 });
      report.pixelCapture = 'Chromium screenshot';
    } catch {
      try { captureNative(name); report.pixelCapture = 'native window capture'; }
      catch { report.pixelCapture = 'transparent native capture unavailable'; }
    }
  };
  await activate(chat.getByRole('button', { name: '切换对话', exact: true }));
  const picker = chat.getByRole('dialog', { name: '切换对话' });
  await activate(picker.getByRole('button', { name: '删除对话：准备删除的对话', exact: true }));
  await capture('delete-confirm.png');
  await activate(picker.getByRole('group', { name: '确认删除对话' }).getByRole('button', { name: '删除', exact: true }));
  await picker.getByRole('button', { name: '删除对话：准备删除的对话', exact: true }).waitFor({ state: 'detached' });
  await activate(picker.getByRole('button', { name: '删除对话：保留的对话', exact: true }));
  await activate(picker.getByRole('group', { name: '确认删除对话' }).getByRole('button', { name: '删除', exact: true }));
  await picker.getByRole('button', { name: '删除对话：新话题', exact: true }).waitFor();
  await capture('after-delete.png');
  report.checks.push('delete inactive and active conversations, last deletion creates an empty conversation');
  const result = execFileSync(path.join(root, '.venv/Scripts/python.exe'), ['-X', 'utf8', '-c', `
from pathlib import Path
import sqlite3,sys,json
p=Path(sys.argv[1]);c=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True)
assert not c.execute("SELECT id FROM events WHERE json_extract(payload,'$.conversation_id') IN ('attention-chat-0','attention-chat-1')").fetchall()
assert not c.execute("SELECT key FROM capability_records WHERE kind='conversation' AND key IN ('attention-chat-0','attention-chat-1')").fetchall()
assert b'DELETE-FIXTURE-SECRET' not in p.read_bytes()
assert c.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
print(json.dumps({'removed':True,'database_integrity':'ok'}))
`, path.join(profile, '.runtime/history.sqlite3')], { cwd: root, windowsHide: true, encoding: 'utf8' });
  report.database = JSON.parse(result);
  report.checks.push('records removed from database and freed page content, database integrity checked');
} catch (error) {
  report.error = error.message;
  if (chat) {
    report.ui = await chat.evaluate(() => ({ visibility: document.visibilityState,
      expanded: document.querySelector('.conversation-switch-trigger')?.getAttribute('aria-expanded'),
      panel: document.querySelector('.conversation-switch-panel')?.textContent,
      buttons: [...document.querySelectorAll('.conversation-switch-delete')].map(button => button.getAttribute('aria-label')) }));
    report.records = await chat.evaluate(() => window.ayana.getState().then(s => s.events.findLast(e => ['conversations.ready', 'conversation.changed'].includes(e.type))?.conversations.map(c => c.title)));
    await chat.screenshot({ path: path.join(directory, 'failure.png'), timeout: 5000 }).catch(() => {});
  }
  console.log(JSON.stringify(report, null, 2));
  throw error;
} finally {
  writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  if (app) await app.close();
}
console.log(JSON.stringify(report, null, 2));
