/** Reproduce queued IPC arriving after native window destruction. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name)+1] : undefined;
const require = createRequire(import.meta.url);
const { _electron } = require(require.resolve('playwright', { paths: [option('--playwright-root') || root] }));
const directory = path.join(root, '.runtime/benchmarks', `companion-lifecycle-${Date.now()}`), data = path.join(directory, 'profile');
mkdirSync(path.join(data, 'config'), { recursive: true });
writeFileSync(path.join(data,'config/local.json'), JSON.stringify({ provider:'local', voice:{ voice_mode:'silent' }, stt:{ provider:'disabled' }, hotkey:'Control+Alt+F6',cancel_hotkey:'Control+Alt+F7' }));
const report = { checks: [], errors: [] }; let app, child;
try {
  app = await _electron.launch({ executablePath: option('--packaged') || path.join(root,'apps/desktop/node_modules/electron/dist/electron.exe'),
    args: [...(option('--packaged') ? [] : [path.join(root,'apps/desktop')]),`--user-data-dir=${data}`],
    env:{...process.env,AYANA_DATA_DIR:data,AYANA_REPOSITORY_ROOT:option('--packaged')?'':root,AYANA_PYTHON:option('--packaged')?'':path.join(root,'.venv/Scripts/python.exe')},timeout:30000 });
  child = app.process(); child.stderr.on('data', data => { if (/Uncaught Exception|Object has been destroyed|TypeError:/.test(data.toString())) report.errors.push(data.toString()); });
  await app.evaluate(({ app }) => { app.__lifecycleErrors = []; process.on('uncaughtException', error => app.__lifecycleErrors.push(String(error))); });
  const page = (await app.windows()).find(w => w.url().includes('window=chat'));
  await page.waitForFunction(() => window.ayana.getState().then(s => s.connected), null, { timeout:30000 });
  const errors = await app.evaluate(async ({ app, BrowserWindow, ipcMain }) => {
    const chat = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=chat'));
    const sender = chat.webContents;
    BrowserWindow.getAllWindows().forEach(w => w.destroy());
    for (let i=0; i<100; i++) {
      ipcMain.emit('ayana:companion-interactive', { sender }, true);
      ipcMain.emit('ayana:companion-drag-start', { sender });
      ipcMain.emit('ayana:companion-drag-end', { sender });
      ipcMain.emit('ayana:companion-move', { sender },20,20);
      ipcMain.emit('ayana:playback', { sender },{});
      ipcMain.emit('ayana:design-preview', { sender },{});
    }
    await new Promise(resolve => setTimeout(resolve,300));
    return app.__lifecycleErrors;
  });
  assert.deepEqual(errors,[]);
  await app.close(); app=undefined;
  assert.equal(child.exitCode,0,'Destroyed windows still permit a clean process exit.');
  assert.deepEqual(report.errors,[]);
  report.checks.push('600 delayed IPC messages after destroying every real Electron window do not touch dead objects; main process exits cleanly');
  report.passed=true;
} catch(error) { report.passed=false;report.failure=String(error);process.exitCode=1; }
finally { if(app) await app.close(); writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,directory},null,2)); }
