/** Regression for the real NSIS portable launcher, personal profile and audio.
 * Run: node scripts/verify_portable_demo.mjs --playwright-root <node_modules>
 * Add --cleanup-only to check profile/quit without repeating model or audio work.
 * The temporary inspector/CDP flags apply only to owned QA launches.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const cleanupOnly = args.includes('--cleanup-only');
const isolatedCompanion = args.includes('--isolated-companion');
const executable = path.resolve(option('--exe') || path.join(root, 'apps/desktop/release/Ayana-0.2.3-win-x64.exe'));
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [option('--playwright-root') || root] }));
const WebSocket = require(path.join(root, 'apps/desktop/node_modules/ws'));
const directory = path.join(root, '.runtime/benchmarks', isolatedCompanion ? 'portable-companion' : 'portable-launcher');
mkdirSync(directory, { recursive: true });
const isolatedProfile = path.join(directory, 'profile');
if (isolatedCompanion) {
  mkdirSync(path.join(isolatedProfile, 'config'), { recursive: true });
  writeFileSync(path.join(isolatedProfile, 'config/local.json'), JSON.stringify({ provider: 'local', voice: { voice_mode: 'silent' }, send_screenshot: false }));
}
const statePath = path.join(directory, 'target.json');
if (!cleanupOnly && existsSync(statePath)) unlinkSync(statePath);
const reportPath = path.join(directory, cleanupOnly ? 'cleanup-report.json' : 'report.json');
const report = { checks: {}, launches: [], playback: [], errors: [], scope: 'Actual NSIS EXE and Worklet sample-consumption receipts; excludes acoustic judgment.' };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(test, timeout = 30000, label = 'condition') {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await test(); if (value) return value; } catch (error) { last = error; }
    await wait(250);
  }
  throw new Error(`Timed out waiting for ${label}${last ? ': ' + last.message : ''}`);
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer().once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}
function python(code, parameters = []) {
  const result = spawnSync(path.join(root, '.venv/Scripts/python.exe'), ['-X', 'utf8', '-c', code, ...parameters], { cwd: root, windowsHide: true, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `Python helper exited ${result.status}`);
  return result.stdout.trim();
}
function powershell(code) {
  const encoded = Buffer.from('[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ' + code, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], { windowsHide: true, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `Process helper exited ${result.status}`);
  return result.stdout.trim();
}
function processes(parentPid) {
  const raw = powershell(`@(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${Number(parentPid)}" | Select-Object ProcessId,ExecutablePath,CommandLine,CreationDate) | ConvertTo-Json -Compress`);
  if (!raw) return [];
  const value = JSON.parse(raw); return Array.isArray(value) ? value : [value];
}
function alive(pid) { return powershell(`if (Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue) { 'yes' }`) === 'yes'; }
async function inspector(port) {
  const targets = await eventually(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
    return response.ok && await response.json();
  }, 90000, 'main inspector');
  const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let sequence = 0;
  const pending = new Map();
  socket.on('message', raw => { const message = JSON.parse(raw); if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); } });
  return {
    close: () => socket.close(),
    evaluate: async expression => {
      const id = ++sequence;
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Inspector evaluation timed out.')); }, 10000);
        pending.set(id, message => { clearTimeout(timer); resolve(message); });
      });
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      const message = await response;
      if (message.error || message.result.exceptionDetails) throw new Error(JSON.stringify(message.error || message.result.exceptionDetails));
      return message.result.result.value;
    },
  };
}

const basePython = python('import sys; print(sys._base_executable)');
const target = cleanupOnly ? undefined : spawn(basePython, ['-X', 'utf8', '-m', 'native.windows.demo_target', '--state', statePath, '--auto-close', '600'], { cwd: root, windowsHide: true, stdio: 'ignore' });
let active;
let second;

async function launch(label) {
  const attach = label === 'initial' && option('--attach-cdp');
  const cdp = attach ? Number(option('--attach-cdp')) : await freePort();
  const inspect = attach ? Number(option('--attach-inspector')) : await freePort();
  const environment = { ...process.env };
  for (const key of ['AYANA_DATA_DIR', 'AYANA_REPOSITORY_ROOT', 'AYANA_PYTHON', 'AYANA_RENDERER_URL', 'ELECTRON_RUN_AS_NODE']) delete environment[key];
  const wrapper = attach ? { pid: Number(option('--attach-wrapper')) }
    : spawn(executable, [`--remote-debugging-port=${cdp}`, '--remote-debugging-address=127.0.0.1', `--inspect=127.0.0.1:${inspect}`, ...(isolatedCompanion ? [`--user-data-dir=${isolatedProfile}`] : [])], { cwd: path.dirname(executable), windowsHide: true, stdio: 'ignore', env: environment });
  const instance = { label, wrapper };
  active = instance;
  instance.inspector = await inspector(inspect);
  instance.runtime = await instance.inspector.evaluate("(()=>{const {app}=process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app.asar/package.json')('electron'); return {pid:process.pid,packaged:app.isPackaged,resources:process.resourcesPath,data:app.getPath('userData'),logs:app.getPath('logs')};})()");
  assert(instance.runtime.packaged);
  instance.backend = await eventually(() => processes(instance.runtime.pid).find(p => /resources[\\/]python[\\/]python\.exe$/i.test(p.ExecutablePath || '')), 15000, 'owned embedded agent');
  await eventually(async () => { const result = await fetch(`http://127.0.0.1:${cdp}/json/version`, { signal: AbortSignal.timeout(1000) }); return result.ok; }, 15000, 'renderer CDP');
  instance.browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdp}`);
  instance.page = await eventually(() => instance.browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('window=chat')), 15000, 'chat renderer');
  const page = instance.page;
  page.on('pageerror', error => report.errors.push(`${label}: ${error.message}`));
  await page.waitForSelector('.companion-shell', { timeout: 15000 });
  await page.waitForFunction(() => window.ayana?.getState().then(state => state.connected), null, { timeout: 20000 });
  await page.evaluate(() => {
    window.__portableEvents = [];
    window.ayana.onEvent(event => {
      const { pcm_base64, png_base64, ...safe } = event;
      window.__portableEvents.push({ ...safe, received_ms: performance.now() });
    });
  });
  await page.evaluate(() => window.ayana.send({ type: 'settings.get' }));
  await page.waitForFunction(() => window.__portableEvents.some(event => event.type === 'settings.ready'), null, { timeout: 10000 });
  const settings = await page.evaluate(() => window.__portableEvents.find(event => event.type === 'settings.ready'));
  if (isolatedCompanion) {
    assert.equal(settings.settings.provider, 'local');
    assert.equal(settings.settings.voice.voice_mode, 'silent');
    assert.equal(path.normalize(instance.runtime.data).toLowerCase(), isolatedProfile.toLowerCase());
  } else {
  assert.equal(settings.settings.provider, 'openai');
  assert.equal(settings.settings.model, 'deepseek-flash');
  assert.equal(settings.settings.voice.voice_mode, 'sovits');
  assert.equal(settings.api_key_configured, true, 'The actual runtime must load the personal credential.');
  assert.equal(path.normalize(instance.runtime.data).toLowerCase(), path.join(process.env.APPDATA, 'Ayana').toLowerCase());
  }
  const logPath = path.join(instance.runtime.logs, 'ayana-runtime.log');
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8').split(/\r?\n/).filter(line => /Runtime start:|Runtime config:/.test(line)).slice(-4) : [];
  report.launches.push({ label, ...instance.runtime, backend_pid: instance.backend.ProcessId, settings: { provider: settings.settings.provider, model: settings.settings.model, voice_mode: settings.settings.voice.voice_mode, api_key_configured: settings.api_key_configured }, startup_log: log });
  console.log(JSON.stringify({ phase: 'startup', ...report.launches.at(-1), voice_events: await page.evaluate(() => window.ayana.getState().then(state => state.events.filter(event => event.type === 'service.state').slice(-3))) }));
  return instance;
}
function resourceFiles(instance) {
  return ['backend/services/tts/worker.py', 'backend/characters/ayana/persona.md', 'python/python311._pth'].map(relative => ({ relative, path: path.join(instance.runtime.resources, relative) }));
}
function assertResources(instance) {
  for (const file of resourceFiles(instance)) assert(existsSync(file.path), `Portable runtime resource disappeared: ${file.relative}`);
}
async function playback(instance, label) {
  const page = instance.page;
  const targetState = JSON.parse(readFileSync(statePath, 'utf8'));
  const previous = await page.evaluate(() => window.__portableEvents.length);
  await page.evaluate(hwnd => window.ayana.send({ type: 'target.bind', hwnd }), targetState.hwnd);
  await page.waitForFunction(({ hwnd, previous }) => window.__portableEvents.slice(previous).some(event => event.type === 'snapshot.ready' && event.target?.hwnd === hwnd), { hwnd: targetState.hwnd, previous }, { timeout: 15000 });
  await page.getByRole('textbox', { name: '输入问题' }).fill('这是一项语音回归检查。只回答一句极短日语「こんにちは。」并配中文「你好」。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(start => window.__portableEvents.slice(start).some(event => event.type === 'playback.ended' && !Number.isFinite(event.seq) && event.output_sample_rate > 0 && event.played_samples > 1000), previous, { timeout: 120000 });
  const events = await page.evaluate(start => window.__portableEvents.slice(start), previous);
  const audio = events.find(event => event.type === 'audio.ready');
  const consumed = events.find(event => event.type === 'playback.ended' && !Number.isFinite(event.seq) && event.output_sample_rate);
  assert.equal(audio?.engine, 'gpt-sovits-ayana');
  assert.equal(consumed.played_samples, consumed.total_samples);
  assert(!events.some(event => event.type === 'error'), JSON.stringify(events.filter(event => event.type === 'error')));
  report.playback.push({ label, engine: audio.engine, ...consumed });
  console.log(JSON.stringify({ phase: 'playback', label, engine: audio.engine, sample_rate: consumed.sample_rate, output_sample_rate: consumed.output_sample_rate, played_samples: consumed.played_samples, total_samples: consumed.total_samples }));
  await page.screenshot({ path: path.join(directory, `${label}.png`) });
  await page.evaluate(() => window.ayana.send({ type: 'generation.cancel' }));
}

async function close(instance) {
  if (!instance) return;
  // Main's own quit path waits for authenticated backend shutdown and worker
  // cleanup. Delay the call so the inspector returns before disconnecting.
  try {
    await instance.inspector?.evaluate("(()=>{const {app}=process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app.asar/package.json')('electron'); setTimeout(()=>app.quit(),100); return true;})()");
    // Node can defer process exit until its debugger disconnects. Detach now,
    // before waiting, so the app's own bounded backend cleanup can finish.
    instance.inspector?.close();
    await eventually(() => !alive(instance.runtime.pid) && !alive(instance.backend.ProcessId), 20000, 'graceful owned app shutdown');
  } catch (error) {
    report.errors.push(`Graceful cleanup: ${error.message}`);
    // Only our exact main/child PIDs, still matching their executable paths,
    // are eligible for a fallback. No broad process-name or tree termination.
    if (instance.runtime && instance.backend && !alive(instance.backend.ProcessId)) {
      const expected = path.join(path.dirname(instance.runtime.resources), 'Ayana.exe').replaceAll("'", "''");
      powershell(`$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${instance.runtime.pid}"; if ($p -and $p.ExecutablePath -eq '${expected}') { Stop-Process -Id $p.ProcessId }`);
    }
  } finally {
    instance.inspector?.close();
    await instance.browser?.close().catch(() => {});
  }
  await eventually(() => !alive(instance.wrapper.pid), 20000, 'portable wrapper cleanup');
  if (active === instance) active = undefined;
}

try {
  if (cleanupOnly) {
    const instance = await launch('initial');
    if (isolatedCompanion) {
      await instance.page.waitForFunction(() => document.querySelector('.character')?.naturalWidth === 472);
      assert.equal(await instance.page.locator('.workshop').count(), 0);
      assert.equal(await instance.page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), 'rgba(0, 0, 0, 0)');
      await instance.page.screenshot({ path: path.join(directory, 'companion.png'), omitBackground: true });
      report.checks.transparent_companion = true;
      await instance.page.evaluate(() => window.ayana.openSettings());
      const controls = await eventually(() => instance.browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('window=settings')));
      await controls.waitForSelector('.settings-form');
      report.checks.independent_settings = true;
    }
    await instance.page.evaluate(() => window.ayana.send({ type: 'generation.cancel' }));
    await close(instance);
    report.checks.personal_profile_loaded = true;
    report.checks.graceful_shutdown = report.errors.length === 0;
    report.passed = true;
  } else {
  await eventually(() => existsSync(statePath), 10000, 'owned safe demo target');
  const first = await launch('initial');
  assertResources(first);
  await playback(first, 'initial');
  report.checks.initial_actual_audio = true;
  // The second wrapper must clean only its own extraction directory.
  const targetHwnd = JSON.parse(readFileSync(statePath, 'utf8')).hwnd;
  python('from native.windows.win32 import Win32; import sys; assert Win32().focus(int(sys.argv[1]))', [String(targetHwnd)]);
  second = spawn(executable, [], { cwd: path.dirname(executable), windowsHide: true, stdio: 'ignore' });
  await eventually(() => second.exitCode !== null || second.signalCode !== null, 90000, 'second portable launcher exit');
  assert.equal(second.exitCode, 0);
  assert(alive(first.runtime.pid));
  assert(alive(first.backend.ProcessId));
  assertResources(first);
  assert(await first.page.evaluate(() => window.ayana.getState().then(state => state.connected)));
  report.checks.second_launch_preserved_first_runtime = true;
  await playback(first, 'after-second-launch');
  report.checks.audio_after_second_launch = true;
  await close(first);
  const restarted = await launch('restarted');
  assertResources(restarted);
  assert.notEqual(restarted.runtime.resources, first.runtime.resources);
  await playback(restarted, 'after-clean-restart');
  report.checks.audio_after_clean_restart = true;
  report.passed = true;
  }
} catch (error) {
  report.errors.push(error.stack || String(error));
  report.passed = false;
  process.exitCode = 1;
} finally {
  if (active?.page && !active.page.isClosed()) {
    report.events = await active.page.evaluate(() => window.__portableEvents || []).catch(() => []);
  }
  await close(active).catch(error => { report.errors.push(`Cleanup: ${error.message}`); report.passed = false; process.exitCode = 1; });
  try {
    if (existsSync(statePath)) python('import ctypes,sys; ctypes.windll.user32.PostMessageW(int(sys.argv[1]),16,0,0)', [String(JSON.parse(readFileSync(statePath, 'utf8')).hwnd)]);
    if (target) await eventually(() => target.exitCode !== null || target.signalCode !== null, 3000, 'owned target cleanup');
  } catch { if (target?.exitCode === null) target.kill(); }
}
report.passed = report.passed && report.errors.length === 0;
if (!report.passed) process.exitCode = 1;
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: report.passed, checks: report.checks, errors: report.errors, report: reportPath }));
