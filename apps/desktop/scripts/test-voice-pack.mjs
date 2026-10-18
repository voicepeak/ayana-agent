import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);

async function loadModule(entry) {
  const compiled = await build({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['unzipper', '@aws-sdk/client-s3', 'react'],
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', compiled.outputFiles[0].text)(
    module, module.exports, name => {
      if (name === '@aws-sdk/client-s3') throw new Error('S3 paths are not used');
      return require(name);
    });
  return module.exports;
}

const voicePack = await loadModule('electron/voicePack.ts');
const view = await loadModule('renderer/voicePackView.ts');

assert.equal(voicePack.parseNvidiaSmi('NVIDIA GeForce RTX 4060, 560.94, 8188, 7000, 8.9').compute_capability, '8.9');
assert.equal(voicePack.parseNvidiaSmi('NVIDIA GeForce RTX 4060, 560.94, 8188, 7000, 8.9').memory_mb, 8188);
assert.equal(voicePack.parseNvidiaSmi('not a gpu'), null);

const variants = [
  { id: 'cu124', kind: 'cuda', url: 'cu124.zip', sha256: 'a'.repeat(64), min_driver: '551.61', min_vram_mb: 6144, compute_capabilities: ['7.5', '8.0', '8.6', '8.9'] },
  { id: 'cu128', kind: 'cuda', url: 'cu128.zip', sha256: 'b'.repeat(64), min_driver: '570.00', min_vram_mb: 6144, compute_capabilities: ['12.0'] },
  { id: 'cpu', kind: 'cpu', url: 'cpu.zip', sha256: 'c'.repeat(64) },
];
const manifest = { format: 1, pack_id: 'ayana', version: '1.0.0', variants };
const rtx4060 = { vendor: 'nvidia', name: 'RTX 4060', driver: '560.94', memory_mb: 8188, free_memory_mb: 7000, compute_capability: '8.9' };
const rtx5090 = { vendor: 'nvidia', name: 'RTX 5090', driver: '580.00', memory_mb: 32768, free_memory_mb: 30000, compute_capability: '12.0' };
assert.equal(voicePack.selectVariant(manifest, rtx4060).id, 'cu124');
assert.equal(voicePack.selectVariant(manifest, rtx5090).id, 'cu128');
assert.equal(voicePack.selectVariant(manifest, { ...rtx4060, driver: '540.00' }).id, 'cpu');
assert.equal(voicePack.selectVariant(manifest, { ...rtx4060, memory_mb: 4096 }).id, 'cpu');
assert.equal(voicePack.selectVariant(manifest, null).id, 'cpu');
assert.throws(() => voicePack.validateManifest({ ...manifest, variants: [{ ...variants[0], sha256: 'bad' }] }), /校验值/);
assert.deepEqual(voicePack.downloadCandidates('https://huggingface.co/Vociepeak/ayana-voice/resolve/main/voice-pack.json'), [
  'https://hf-mirror.com/Vociepeak/ayana-voice/resolve/main/voice-pack.json',
  'https://huggingface.co/Vociepeak/ayana-voice/resolve/main/voice-pack.json',
]);
assert.deepEqual(voicePack.downloadCandidates('https://example.com/pack.zip'), ['https://example.com/pack.zip']);

const silent = {
  settingsLoaded: true, settings: { voice: { voice_mode: 'silent' } },
  voicePack: { phase: 'idle', installed: false },
};
assert.equal(view.voicePackBubbleVisible(silent), true);
assert.equal(view.voicePackBubbleVisible({ ...silent, settings: { voice: { voice_mode: 'sovits' } } }), false);
assert.equal(view.voicePackBubbleVisible({ ...silent, voicePack: { phase: 'downloading', installed: false } }), true);
assert.equal(view.voicePackBubbleVisible({ ...silent, voicePack: { phase: 'ready', installed: true, restart_required: true } }), true);
assert.equal(view.voicePackBubbleVisible({ ...silent, settings: { voice: { voice_mode: 'sovits' } }, voicePack: { phase: 'ready', installed: true } }), false);
assert.equal(view.voicePackBubbleVisible({ ...silent, settingsLoaded: false }), false);
assert.equal(view.voicePackBubbleVisible({ ...silent, voicePack: undefined }), false);
assert.equal(view.voicePackStage({ phase: 'downloading', installed: false, downloaded: 1024 ** 3, total: 2 * 1024 ** 3, speed: 1024 ** 2, eta_seconds: 1000 }).title, '正在下载语音包 50%');
assert.equal(view.formatBytes(1024 ** 3), '1.00 GB');
assert.equal(view.formatEta(90), '约 2 分钟');
assert.equal(view.dismissalExpired(null), true);
assert.equal(view.dismissalExpired(String(Date.now() - 8 * 24 * 60 * 60 * 1000)), true);
assert.equal(view.dismissalExpired(String(Date.now())), false);

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ayana-voice-pack-'));
try {
  const pack = path.join(workspace, 'pack');
  const files = {
    'runtime/python.exe': 'python',
    'engine/GPT-SoVITS/GPT_SoVITS/inference_webui.py': 'engine',
    'models/ayana-gpt.ckpt': 'gpt',
    'models/ayana-sovits.pth': 'sovits',
    'refs/ref.wav': 'wave',
    'refs/ref.txt': 'こんにちは。',
    'nltk_data/readme.txt': 'nltk',
  };
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(pack, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const metadata = {
    format: 1, pack_id: 'ayana-test', version: '1.0.0', reference_text: 'こんにちは。',
    runtime: { kind: 'cpu' },
    paths: {
      python: 'runtime/python.exe', engine_root: 'engine/GPT-SoVITS',
      model_gpt: 'models/ayana-gpt.ckpt', model_sovits: 'models/ayana-sovits.pth',
      reference_audio: 'refs/ref.wav', nltk_data: 'nltk_data',
    },
  };
  fs.writeFileSync(path.join(pack, 'voice-pack.json'), '\uFEFF' + JSON.stringify(metadata));
  const archive = path.join(workspace, 'pack.zip');
  const zipped = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `Compress-Archive -Path '${pack}\\*' -DestinationPath '${archive}' -Force`], { encoding: 'utf8' });
  assert.equal(zipped.status, 0, zipped.stderr);
  const sha256 = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  const manifestPath = path.join(workspace, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    format: 1, pack_id: 'ayana-test', version: '1.0.0',
    variants: [{ id: 'cpu', kind: 'cpu', url: archive, sha256, size: fs.statSync(archive).size }],
  }));
  let applied;
  const manager = new voicePack.VoicePackManager({
    voiceRoot: path.join(workspace, 'voice'),
    stateFile: path.join(workspace, 'state.json'),
    manifestPath,
    detectGpu: async () => null,
    applyVoice: async voice => { applied = voice; },
  });
  await manager.init();
  assert.equal(manager.getState().phase, 'idle');
  assert.equal(manager.getState().gpu, null);
  await manager.start();
  const state = manager.getState();
  assert.equal(state.phase, 'ready');
  assert.equal(state.installed, true);
  assert.equal(state.restart_required, true);
  assert.equal(state.pack_id, 'ayana-test');
  assert.equal(applied.voice_mode, 'sovits');
  assert.equal(applied.restart_pending, true);
  assert.equal(applied.device, 'cpu');
  assert.equal(applied.reference_text, 'こんにちは。');
  assert.ok(fs.existsSync(path.join(workspace, 'voice', 'ayana-test-1.0.0-cpu', 'voice-pack.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(workspace, 'state.json'), 'utf8')).installed.pack_id, 'ayana-test');

  const http = await import('node:http');
  const payload = fs.readFileSync(archive);
  let rangeRequests = 0;
  const server = http.createServer((request, response) => {
    const match = /bytes=(\d+)-(\d*)/.exec(String(request.headers.range || ''));
    if (!match) {
      response.writeHead(200, { 'content-length': payload.length, 'accept-ranges': 'bytes' });
      response.end(payload);
      return;
    }
    rangeRequests++;
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : payload.length - 1;
    if (start >= payload.length) { response.writeHead(416); response.end(); return; }
    response.writeHead(206, {
      'content-length': end - start + 1, 'accept-ranges': 'bytes',
      'content-range': `bytes ${start}-${end}/${payload.length}`,
    });
    response.end(payload.subarray(start, end + 1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const remoteManifest = path.join(workspace, 'manifest-http.json');
  fs.writeFileSync(remoteManifest, JSON.stringify({
    format: 1, pack_id: 'ayana-test', version: '1.0.0',
    variants: [{ id: 'cpu', kind: 'cpu', url: `http://127.0.0.1:${server.address().port}/pack.zip`, sha256, size: payload.length }],
  }));
  let remoteApplied;
  const remote = new voicePack.VoicePackManager({
    voiceRoot: path.join(workspace, 'voice-http'),
    stateFile: path.join(workspace, 'state-http.json'),
    manifestPath: remoteManifest,
    detectGpu: async () => null,
    applyVoice: async voice => { remoteApplied = voice; },
    parallelMinBytes: 1,
    parallelChunkBytes: 256,
  });
  await remote.start();
  assert.equal(remote.getState().phase, 'ready', JSON.stringify(remote.getState()));
  assert.equal(remoteApplied.voice_mode, 'sovits');
  assert(rangeRequests >= 2, 'large remote packs download through multiple range connections');
  assert.equal(fs.existsSync(path.join(workspace, 'voice-http', '.downloads', 'ayana-test-1.0.0-cpu.zip.part.segments')), false);
  await new Promise(resolve => server.close(resolve));

  let imported;
  const local = new voicePack.VoicePackManager({
    voiceRoot: path.join(workspace, 'voice-local'),
    stateFile: path.join(workspace, 'state-local.json'),
    detectGpu: async () => null,
    applyVoice: async voice => { imported = voice; },
  });
  await local.importLocal(archive);
  assert.equal(local.getState().phase, 'ready');
  assert.equal(local.getState().installed, true);
  assert.equal(imported.voice_mode, 'sovits');
  assert.equal(imported.restart_pending, true);

  let adopted;
  const fixed = new voicePack.VoicePackManager({
    voiceRoot: path.join(workspace, 'voice-fixed'),
    stateFile: path.join(workspace, 'state-fixed.json'),
    detectGpu: async () => null,
    applyVoice: async voice => { adopted = voice; },
  });
  fs.mkdirSync(path.join(workspace, 'voice-fixed', '.downloads'), { recursive: true });
  fs.copyFileSync(archive, path.join(workspace, 'voice-fixed', '.downloads', 'finished-download.zip'));
  await fixed.init();
  assert.equal(fixed.getState().phase, 'ready');
  assert.equal(fixed.getState().installed, true);
  assert.equal(fixed.getState().restart_required, true);
  assert.equal(adopted.voice_mode, 'sovits');
  assert.equal(fs.existsSync(path.join(workspace, 'voice-fixed', '.downloads', 'finished-download.zip')), false);

  let reused;
  const reuse = new voicePack.VoicePackManager({
    voiceRoot: path.join(workspace, 'voice-reuse'),
    stateFile: path.join(workspace, 'state-reuse.json'),
    detectGpu: async () => null,
    applyVoice: async voice => { reused = voice; },
  });
  const reuseRoot = path.join(workspace, 'voice-reuse', 'ayana-test-1.0.0-local');
  fs.mkdirSync(reuseRoot, { recursive: true });
  await (await require('unzipper').Open.file(archive)).extract({ path: reuseRoot });
  await reuse.start();
  assert.equal(reuse.getState().phase, 'ready');
  assert.equal(reuse.getState().installed, true);
  assert.equal(reused.voice_mode, 'sovits');

  const broken = new voicePack.VoicePackManager({
    voiceRoot: path.join(workspace, 'voice-broken'),
    stateFile: path.join(workspace, 'state-broken.json'),
    detectGpu: async () => null,
    applyVoice: async () => { throw new Error('should not configure'); },
  });
  fs.mkdirSync(path.join(workspace, 'voice-broken', '.downloads'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'voice-broken', '.downloads', 'broken.zip'), 'not a zip');
  await broken.init();
  assert.equal(broken.getState().phase, 'idle');
  assert.equal(broken.getState().installed, false);
  console.log('PASS: GPU variant selection, manifest validation, renderer visibility, local download/verify/extract, offline import and voice configuration.');
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
