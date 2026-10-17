/** Open a disposable first-run profile so the real user profile is untouched. */
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(root, 'apps/desktop');
const executable = path.join(desktop, 'node_modules/electron/dist/electron.exe');
if (!existsSync(path.join(desktop, 'dist/index.html')) || !existsSync(executable)) {
  throw new Error('请先安装桌面依赖并执行 npm --prefix apps/desktop run build。');
}
const profile = path.join(root, '.runtime/welcome-preview', String(Date.now()));
mkdirSync(path.join(profile, 'config'), { recursive: true });
writeFileSync(path.join(profile, 'config/local.json'), JSON.stringify({ user_name: '', onboarding_version: 0,
  provider: 'local', voice: { voice_mode: 'silent' }, volume: 1, send_screenshot: false,
  stt: { provider: 'local', model: 'tiny', ...(existsSync(path.join(root, '.runtime/models/stt/tiny/model.bin')) ? { model_path: path.join(root, '.runtime/models/stt/tiny'), local_files_only: true } : {}) },
  ambient_attention: false, hotkey: 'Control+Alt+F10', cancel_hotkey: 'Control+Alt+F11' }));
const log = openSync(path.join(profile, 'preview.log'), 'a');
const child = spawn(executable, [desktop, `--user-data-dir=${profile}`], {
  cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log, log],
  env: { ...process.env, AYANA_DATA_DIR: profile, AYANA_REPOSITORY_ROOT: root, AYANA_PYTHON: path.join(root, '.venv/Scripts/python.exe') },
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.unref(); closeSync(log);
console.log(`已打开初次见面预览。独立配置：${profile}`);
