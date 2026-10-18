import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as unzipper from 'unzipper';

export type VoicePackPhase =
  | 'idle' | 'detecting' | 'downloading' | 'paused' | 'verifying'
  | 'extracting' | 'configuring' | 'ready' | 'failed';

export interface GpuInfo {
  vendor: 'nvidia';
  name: string;
  driver: string;
  memory_mb: number;
  free_memory_mb: number;
  compute_capability?: string;
}

export interface VoicePackVariant {
  id: string;
  kind: 'cuda' | 'cpu';
  label?: string;
  url: string;
  size?: number;
  sha256: string;
  min_driver?: string;
  min_vram_mb?: number;
  compute_capabilities?: string[];
}

export interface VoicePackManifest {
  format: 1;
  pack_id: string;
  version: string;
  model_version?: string;
  variants: VoicePackVariant[];
}

export interface VoicePackPaths {
  python: string;
  engine_root: string;
  model_gpt: string;
  model_sovits: string;
  reference_audio: string;
  source_root?: string;
  nltk_data?: string;
}

export interface VoicePackMetadata {
  format: 1;
  pack_id: string;
  version: string;
  model_version?: string;
  reference_text?: string;
  runtime?: { kind?: 'cuda' | 'cpu' };
  paths: VoicePackPaths;
}

export interface VoicePackState {
  phase: VoicePackPhase;
  installed: boolean;
  manifest_configured: boolean;
  can_download: boolean;
  can_import: boolean;
  pack_id?: string;
  version?: string;
  variant?: string;
  kind?: 'cuda' | 'cpu';
  label?: string;
  gpu?: GpuInfo | null;
  total?: number;
  downloaded?: number;
  speed?: number;
  eta_seconds?: number;
  progress?: number;
  message?: string;
  error?: string;
  restart_required?: boolean;
}

interface InstalledRecord {
  format: 1;
  pack_id: string;
  version: string;
  variant: string;
  kind: 'cuda' | 'cpu';
  root: string;
  installed_at: string;
  configured?: boolean;
}

interface PendingDownload {
  pack_id: string;
  version: string;
  variant: string;
  kind: 'cuda' | 'cpu';
  sha256: string;
  total?: number;
}

interface InstallFile {
  format: 1;
  installed?: InstalledRecord;
  pending?: PendingDownload;
}

export interface VoicePackManagerOptions {
  voiceRoot: string;
  stateFile: string;
  downloadRoot?: string;
  manifestUrl?: string;
  manifestPath?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
  detectGpu?: () => Promise<GpuInfo | null>;
  applyVoice?: (voice: Record<string, unknown>) => Promise<void>;
  onState?: (state: VoicePackState) => void;
  parallelMinBytes?: number;
  parallelChunkBytes?: number;
}

const REQUIRED_PATH_KEYS = ['python', 'engine_root', 'model_gpt', 'model_sovits', 'reference_audio'] as const;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,100}$/i;
const PARALLEL_CONNECTIONS = 8;
const PARALLEL_MIN_BYTES = 64 * 1024 * 1024;

export function downloadCandidates(url: string): string[] {
  const candidates = [url];
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'huggingface.co' || parsed.hostname.endsWith('.huggingface.co')) {
      const mirror = new URL(url);
      mirror.hostname = 'hf-mirror.com';
      candidates.unshift(mirror.href);
    }
  } catch { /* Local paths are not URLs. */ }
  return [...new Set(candidates)];
}

function parseJson(text: string): unknown {
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

export function normalizeCapability(value: string): string {
  const [major, minor = '0'] = value.trim().split('.');
  return `${Number(major)}.${Number(minor)}`;
}

export function versionAtLeast(actual: string, minimum: string): boolean {
  const left = actual.split('.').map(value => Number(value) || 0);
  const right = minimum.split('.').map(value => Number(value) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const a = left[index] || 0;
    const b = right[index] || 0;
    if (a !== b) return a > b;
  }
  return true;
}

export function parseNvidiaSmi(output: string): GpuInfo | null {
  const line = output.split(/\r?\n/).map(value => value.trim()).find(Boolean);
  if (!line) return null;
  const [name, driver, memory, free, capability] = line.split(',').map(value => value.trim());
  const memoryMb = Number(memory);
  const freeMb = Number(free);
  if (!name || !driver || !Number.isFinite(memoryMb) || memoryMb <= 0) return null;
  return {
    vendor: 'nvidia', name, driver, memory_mb: memoryMb,
    free_memory_mb: Number.isFinite(freeMb) ? freeMb : memoryMb,
    compute_capability: capability && /^\d+\.\d+$/.test(capability) ? capability : undefined,
  };
}

export function detectNvidiaGpu(): Promise<GpuInfo | null> {
  return new Promise(resolve => {
    let output = '';
    let settled = false;
    const finish = (value: GpuInfo | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const child = spawn('nvidia-smi', [
      '--query-gpu=name,driver_version,memory.total,memory.free,compute_cap',
      '--format=csv,noheader,nounits',
    ], { windowsHide: true });
    const timer = setTimeout(() => { child.kill(); finish(null); }, 5000);
    child.stdout?.on('data', chunk => { output += chunk.toString(); });
    child.once('error', () => { clearTimeout(timer); finish(null); });
    child.once('close', code => {
      clearTimeout(timer);
      finish(code === 0 ? parseNvidiaSmi(output) : null);
    });
  });
}

export function validateManifest(value: unknown): VoicePackManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('语音包清单格式无效');
  const manifest = value as Record<string, unknown>;
  if (manifest.format !== 1) throw new Error('语音包清单版本不受支持');
  if (typeof manifest.pack_id !== 'string' || !SAFE_ID.test(manifest.pack_id)) throw new Error('语音包标识无效');
  if (typeof manifest.version !== 'string' || !SAFE_ID.test(manifest.version)) throw new Error('语音包版本无效');
  if (!Array.isArray(manifest.variants) || !manifest.variants.length) throw new Error('语音包清单没有可安装的版本');
  const variants = manifest.variants.map((item): VoicePackVariant => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('语音包变体无效');
    const variant = item as Record<string, unknown>;
    if (typeof variant.id !== 'string' || !SAFE_ID.test(variant.id)) throw new Error('语音包变体标识无效');
    if (variant.kind !== 'cuda' && variant.kind !== 'cpu') throw new Error('语音包变体类型无效');
    if (typeof variant.url !== 'string' || !variant.url.trim()) throw new Error('语音包下载地址缺失');
    if (typeof variant.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(variant.sha256)) throw new Error('语音包校验值无效');
    if (variant.size !== undefined && (typeof variant.size !== 'number' || !Number.isFinite(variant.size) || variant.size <= 0)) throw new Error('语音包大小无效');
    if (variant.min_driver !== undefined && typeof variant.min_driver !== 'string') throw new Error('语音包驱动要求无效');
    if (variant.min_vram_mb !== undefined && (typeof variant.min_vram_mb !== 'number' || variant.min_vram_mb <= 0)) throw new Error('语音包显存要求无效');
    if (variant.compute_capabilities !== undefined && (!Array.isArray(variant.compute_capabilities) || variant.compute_capabilities.some(capability => typeof capability !== 'string'))) throw new Error('语音包显卡要求无效');
    return {
      id: variant.id, kind: variant.kind, label: typeof variant.label === 'string' ? variant.label : undefined,
      url: variant.url, size: variant.size as number | undefined, sha256: variant.sha256.toLowerCase(),
      min_driver: variant.min_driver as string | undefined, min_vram_mb: variant.min_vram_mb as number | undefined,
      compute_capabilities: variant.compute_capabilities as string[] | undefined,
    };
  });
  return {
    format: 1, pack_id: manifest.pack_id, version: manifest.version,
    model_version: typeof manifest.model_version === 'string' ? manifest.model_version : undefined,
    variants,
  };
}

export function variantEligible(variant: VoicePackVariant, gpu: GpuInfo | null): boolean {
  if (variant.kind === 'cpu') return true;
  if (!gpu) return false;
  if (variant.min_driver && !versionAtLeast(gpu.driver, variant.min_driver)) return false;
  if (variant.min_vram_mb && gpu.memory_mb < variant.min_vram_mb) return false;
  if (variant.compute_capabilities?.length) {
    if (!gpu.compute_capability) return false;
    const capability = normalizeCapability(gpu.compute_capability);
    if (!variant.compute_capabilities.some(value => normalizeCapability(value) === capability)) return false;
  }
  return true;
}

export function selectVariant(manifest: VoicePackManifest, gpu: GpuInfo | null): VoicePackVariant {
  const cuda = manifest.variants.find(variant => variant.kind === 'cuda' && variantEligible(variant, gpu));
  if (cuda) return cuda;
  const cpu = manifest.variants.find(variant => variant.kind === 'cpu');
  if (cpu) return cpu;
  throw new Error(gpu ? '当前显卡没有匹配的语音包' : '没有适用于当前设备的语音包');
}

export function validatePackMetadata(value: unknown): VoicePackMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('语音包内容清单无效');
  const metadata = value as Record<string, unknown>;
  if (metadata.format !== 1) throw new Error('语音包内容版本不受支持');
  if (typeof metadata.pack_id !== 'string' || !SAFE_ID.test(metadata.pack_id)) throw new Error('语音包内容标识无效');
  if (typeof metadata.version !== 'string' || !SAFE_ID.test(metadata.version)) throw new Error('语音包内容版本无效');
  if (!metadata.paths || typeof metadata.paths !== 'object' || Array.isArray(metadata.paths)) throw new Error('语音包路径缺失');
  const paths = metadata.paths as Record<string, unknown>;
  for (const key of REQUIRED_PATH_KEYS) {
    if (typeof paths[key] !== 'string' || !paths[key]) throw new Error(`语音包路径缺失：${key}`);
  }
  for (const key of ['source_root', 'nltk_data'] as const) {
    if (paths[key] !== undefined && typeof paths[key] !== 'string') throw new Error(`语音包路径格式无效：${key}`);
  }
  const runtime = metadata.runtime && typeof metadata.runtime === 'object' && !Array.isArray(metadata.runtime)
    ? metadata.runtime as Record<string, unknown> : undefined;
  if (runtime?.kind !== undefined && runtime.kind !== 'cuda' && runtime.kind !== 'cpu') throw new Error('语音包运行设备无效');
  return {
    format: 1, pack_id: metadata.pack_id, version: metadata.version,
    model_version: typeof metadata.model_version === 'string' ? metadata.model_version : undefined,
    reference_text: typeof metadata.reference_text === 'string' ? metadata.reference_text : undefined,
    runtime: runtime?.kind ? { kind: runtime.kind } : undefined,
    paths: {
      python: paths.python as string, engine_root: paths.engine_root as string,
      model_gpt: paths.model_gpt as string, model_sovits: paths.model_sovits as string,
      reference_audio: paths.reference_audio as string,
      source_root: paths.source_root as string | undefined,
      nltk_data: paths.nltk_data as string | undefined,
    },
  };
}

export function formatBytes(value: number | undefined): string {
  if (!value || !Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

export function formatEta(seconds: number | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `约 ${Math.ceil(seconds)} 秒`;
  return `约 ${Math.ceil(seconds / 60)} 分钟`;
}

export class VoicePackManager {
  private readonly voiceRoot: string;
  private readonly downloadRoot: string;
  private readonly stateFile: string;
  private readonly manifestUrl: string;
  private readonly manifestPath: string;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly detectGpu: () => Promise<GpuInfo | null>;
  private readonly applyVoice?: (voice: Record<string, unknown>) => Promise<void>;
  private readonly onState?: (state: VoicePackState) => void;
  private readonly parallelMinBytes: number;
  private readonly parallelChunkBytes: number;
  private state: VoicePackState;
  private installed?: InstalledRecord;
  private pending?: PendingDownload;
  private abort?: AbortController;
  private busy = false;
  private lastEmit = 0;

  constructor(options: VoicePackManagerOptions) {
    this.voiceRoot = options.voiceRoot;
    this.downloadRoot = options.downloadRoot || path.join(options.voiceRoot, '.downloads');
    this.stateFile = options.stateFile;
    this.manifestUrl = options.manifestUrl?.trim() || '';
    this.manifestPath = options.manifestPath?.trim() || '';
    this.now = options.now || Date.now;
    this.fetchImpl = options.fetchImpl || fetch;
    this.detectGpu = options.detectGpu || detectNvidiaGpu;
    this.applyVoice = options.applyVoice;
    this.onState = options.onState;
    this.parallelMinBytes = options.parallelMinBytes ?? PARALLEL_MIN_BYTES;
    this.parallelChunkBytes = options.parallelChunkBytes ?? 32 * 1024 * 1024;
    mkdirSync(this.voiceRoot, { recursive: true });
    mkdirSync(this.downloadRoot, { recursive: true });
    for (const entry of readdirSync(this.voiceRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('.staging-')) {
        rmSync(path.join(this.voiceRoot, entry.name), { recursive: true, force: true });
      }
    }
    const saved = this.readInstallFile();
    this.installed = saved.installed;
    this.pending = saved.pending;
    const installed = this.installed && this.isInstalledUsable(this.installed) ? this.installed : undefined;
    if (!installed) this.installed = undefined;
    const needsConfig = installed?.configured === false;
    const partial = this.pending ? this.pendingBytes(this.pending) : 0;
    this.state = {
      phase: needsConfig ? 'failed' : installed ? 'ready' : partial > 0 ? 'paused' : 'idle',
      installed: Boolean(installed),
      manifest_configured: Boolean(this.manifestUrl || this.manifestPath),
      can_download: Boolean(this.manifestUrl || this.manifestPath),
      can_import: true,
      pack_id: installed?.pack_id || this.pending?.pack_id,
      version: installed?.version || this.pending?.version,
      variant: installed?.variant || this.pending?.variant,
      kind: installed?.kind || this.pending?.kind,
      total: this.pending?.total,
      downloaded: partial || undefined,
      error: needsConfig ? '上次语音配置未完成，请重试' : undefined,
      message: needsConfig ? '语音资源包已安装，等待写入配置' : installed ? '语音资源包已安装' : this.pending ? '语音资源包下载未完成' : undefined,
    };
  }

  getState(): VoicePackState {
    return { ...this.state, gpu: this.state.gpu ? { ...this.state.gpu } : this.state.gpu };
  }

  async init(): Promise<void> {
    const gpu = await this.detectGpu();
    this.state.gpu = gpu;
    this.state.phase = this.state.phase === 'idle' && this.pending ? 'paused' : this.state.phase;
    this.emit(true);
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.installed) {
        if (this.installed.configured === false) await this.reconfigureInstalled();
      } else {
        // Downloads land at a fixed location. Adopt a finished pack there
        // without asking the user to find and import the archive again.
        const before = this.state;
        if (!(await this.adoptDiscovered())) this.state = before;
      }
    } catch (error) {
      this.state = { ...this.state, phase: 'failed', installed: true, error: message(error), message: '语音配置写入失败' };
    } finally {
      this.busy = false;
    }
    this.emit(true);
  }

  async start(): Promise<VoicePackState> {
    if (this.busy) return this.getState();
    if (this.installed && this.isInstalledUsable(this.installed)) {
      if (this.installed.configured === false) {
        this.busy = true;
        try {
          await this.reconfigureInstalled();
          return this.getState();
        } catch (error) {
          this.state = { ...this.state, phase: 'failed', installed: true, error: message(error), message: '语音配置写入失败' };
          this.emit(true);
          return this.getState();
        } finally {
          this.busy = false;
        }
      }
      this.state = { ...this.state, phase: 'ready', installed: true, pack_id: this.installed.pack_id, version: this.installed.version, variant: this.installed.variant, kind: this.installed.kind, message: '语音资源包已安装', error: undefined };
      this.emit(true);
      return this.getState();
    }
    this.busy = true;
    this.abort = new AbortController();
    try {
      if (await this.adoptDiscovered()) return this.getState();
      this.state = { ...this.state, phase: 'detecting', error: undefined, message: '正在检查语音资源包', progress: 0, downloaded: undefined, total: undefined, speed: undefined, eta_seconds: undefined, restart_required: false };
      this.emit(true);
      if (!this.state.gpu) this.state.gpu = await this.detectGpu();
      const manifest = await this.loadManifest();
      const variant = selectVariant(manifest, this.state.gpu || null);
      const pending: PendingDownload = { pack_id: manifest.pack_id, version: manifest.version, variant: variant.id, kind: variant.kind, sha256: variant.sha256, total: variant.size };
      this.pending = pending;
      this.writeInstallFile({ format: 1, installed: this.installed, pending });
      this.state = {
        ...this.state, phase: 'downloading', pack_id: manifest.pack_id, version: manifest.version,
        variant: variant.id, kind: variant.kind, label: variant.label || (variant.kind === 'cuda' ? 'GPU 加速' : 'CPU'),
        total: variant.size, downloaded: this.pendingBytes(pending), progress: 0, speed: undefined, eta_seconds: undefined,
        message: variant.kind === 'cuda' ? '正在下载 GPU 语音资源包'
          : this.state.gpu ? '当前显卡暂不满足加速条件，将使用 CPU 语音' : '正在下载语音资源包',
      };
      this.emit(true);
      const archive = await this.download(manifest, variant, pending);
      await this.verify(archive, variant.sha256, variant.size);
      const root = await this.extractAndInstall(archive, manifest, variant);
      await this.applyInstalled(root, manifest, variant);
      return this.getState();
    } catch (error) {
      if (this.abort?.signal.aborted) {
        this.state = { ...this.state, phase: 'paused', message: '下载已暂停，可以稍后继续', speed: undefined, eta_seconds: undefined };
      } else {
        this.state = { ...this.state, phase: 'failed', error: message(error), message: '语音资源包安装失败' };
      }
      this.emit(true);
      return this.getState();
    } finally {
      this.busy = false;
      this.abort = undefined;
    }
  }

  cancel(): VoicePackState {
    this.abort?.abort();
    return this.getState();
  }

  async importLocal(target: string): Promise<VoicePackState> {
    if (this.busy) return this.getState();
    this.busy = true;
    this.abort = new AbortController();
    try {
      this.state = { ...this.state, phase: 'extracting', error: undefined, message: '正在检查本地语音资源包', progress: undefined, total: undefined, downloaded: undefined, speed: undefined, eta_seconds: undefined, restart_required: false };
      this.emit(true);
      const stat = statSync(target);
      let root: string;
      let metadata: VoicePackMetadata;
      if (stat.isDirectory()) {
        root = target;
        metadata = this.readPackMetadata(root);
        this.validatePackRoot(root, metadata);
      } else {
        const unpacked = await this.unpackArchive(target, `local-${this.now()}`);
        metadata = this.readPackMetadata(unpacked.root);
        this.validatePackRoot(unpacked.root, metadata);
        const final = path.join(this.voiceRoot, `${metadata.pack_id}-${metadata.version}-local-${this.now()}`);
        await fs.rename(unpacked.root, final);
        await fs.rm(unpacked.staging, { recursive: true, force: true });
        root = final;
      }
      const variant: VoicePackVariant = {
        id: 'local', kind: metadata.runtime?.kind === 'cuda' ? 'cuda' : 'cpu', url: target,
        sha256: '', label: '本地导入',
      };
      const manifest: VoicePackManifest = { format: 1, pack_id: metadata.pack_id, version: metadata.version, variants: [variant] };
      await this.applyInstalled(root, manifest, variant);
      return this.getState();
    } catch (error) {
      this.state = { ...this.state, phase: 'failed', error: message(error), message: '本地语音资源包导入失败' };
      this.emit(true);
      return this.getState();
    } finally {
      this.busy = false;
      this.abort = undefined;
    }
  }

  private emit(force = false) {
    const at = this.now();
    if (!force && at - this.lastEmit < 250) return;
    this.lastEmit = at;
    this.onState?.(this.getState());
  }

  private readInstallFile(): InstallFile {
    try {
      const parsed = parseJson(readFileSync(this.stateFile, 'utf8')) as InstallFile;
      if (parsed?.format !== 1) return { format: 1 };
      return parsed;
    } catch {
      return { format: 1 };
    }
  }

  private writeInstallFile(value: InstallFile) {
    mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
    try { renameSync(temporary, this.stateFile); }
    catch {
      rmSync(this.stateFile, { force: true });
      renameSync(temporary, this.stateFile);
    }
  }

  private isInstalledUsable(record: InstalledRecord): boolean {
    try {
      const metadata = this.readPackMetadata(record.root);
      this.validatePackRoot(record.root, metadata);
      return metadata.pack_id === record.pack_id && metadata.version === record.version;
    } catch { return false; }
  }

  private async loadManifest(): Promise<VoicePackManifest> {
    if (this.manifestPath) {
      return validateManifest(parseJson(await fs.readFile(this.manifestPath, 'utf8')));
    }
    if (!this.manifestUrl) throw new Error('语音资源包下载地址尚未配置');
    let lastError: unknown;
    for (const url of downloadCandidates(this.manifestUrl)) {
      try {
        const response = await this.fetchImpl(url, { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`无法获取语音资源包清单（HTTP ${response.status}）`);
        return validateManifest(parseJson(await response.text()));
      } catch (error) { lastError = error; }
    }
    throw lastError instanceof Error ? lastError : new Error('无法获取语音资源包清单');
  }

  private resolveUrl(url: string): string {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
    if (this.manifestUrl) return new URL(url, this.manifestUrl).href;
    if (this.manifestPath) return path.resolve(path.dirname(this.manifestPath), url);
    return url;
  }

  private partFile(pending: PendingDownload): string {
    return path.join(this.downloadRoot, `${pending.pack_id}-${pending.version}-${pending.variant}.zip.part`);
  }

  private archiveFile(pending: PendingDownload): string {
    return path.join(this.downloadRoot, `${pending.pack_id}-${pending.version}-${pending.variant}.zip`);
  }

  private segmentDirectory(pending: PendingDownload): string {
    return `${this.partFile(pending)}.segments`;
  }

  private pendingBytes(pending: PendingDownload): number {
    const directory = this.segmentDirectory(pending);
    if (existsSync(directory)) {
      try {
        return readdirSync(directory, { withFileTypes: true })
          .filter(entry => entry.isFile())
          .reduce((sum, entry) => sum + statSync(path.join(directory, entry.name)).size, 0);
      } catch { /* Fall back to the plain part file. */ }
    }
    const part = this.partFile(pending);
    return existsSync(part) ? statSync(part).size : 0;
  }

  private async download(manifest: VoicePackManifest, variant: VoicePackVariant, pending: PendingDownload): Promise<string> {
    const part = this.partFile(pending);
    const archive = this.archiveFile(pending);
    const url = this.resolveUrl(variant.url);
    const offset = this.pendingBytes(pending);
    this.state.downloaded = offset;
    if (!/^https?:/i.test(url)) {
      const source = url.startsWith('file:') ? fileURLToPath(url) : url;
      const size = statSync(source).size;
      if (offset >= size) {
        await fs.rm(archive, { force: true });
        await fs.rename(part, archive);
        this.state = { ...this.state, downloaded: size, total: size, progress: 1 };
        this.emit(true);
        return archive;
      }
      const input = createReadStream(source, { start: offset });
      const output = createWriteStream(part, { flags: offset ? 'a' : 'w' });
      await this.pipeWithProgress(input, output, offset, size, pending);
    } else {
      let lastError: unknown;
      for (const endpoint of downloadCandidates(url)) {
        try {
          return await this.downloadRemote(endpoint, part, archive, variant, pending);
        } catch (error) {
          if (this.abort?.signal.aborted) throw error;
          if (this.pendingBytes(pending) === 0) {
            await fs.rm(this.segmentDirectory(pending), { recursive: true, force: true });
          }
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : new Error('语音资源包下载失败');
    }
    if (!existsSync(part)) throw new Error('语音资源包下载未完成');
    await fs.rm(archive, { force: true });
    await fs.rename(part, archive);
    return archive;
  }

  private async downloadRemote(url: string, part: string, archive: string, variant: VoicePackVariant, pending: PendingDownload): Promise<string> {
    const total = variant.size || await this.remoteSize(url);
    const segments = this.segmentDirectory(pending);
    const canSplit = Boolean(total && total >= this.parallelMinBytes
      && (existsSync(segments) || (!existsSync(part) && await this.rangeSupported(url))));
    if (canSplit) {
      await this.downloadParallel(url, part, archive, pending, total!);
      return archive;
    }
    let offset = existsSync(part) ? statSync(part).size : 0;
    const headers: Record<string, string> = {};
    if (offset > 0) headers.Range = `bytes=${offset}-`;
    const response = await this.fetchImpl(url, { headers, signal: this.abort?.signal });
    if (response.status === 416 && offset > 0) {
      await fs.rm(archive, { force: true });
      await fs.rename(part, archive);
      this.state = { ...this.state, downloaded: offset, total: offset, progress: 1 };
      this.emit(true);
      return archive;
    }
    if (!response.ok) throw new Error(`语音资源包下载失败（HTTP ${response.status}）`);
    if (offset > 0 && response.status !== 206) {
      offset = 0;
      await fs.rm(part, { force: true });
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    const size = variant.size || (contentLength > 0 ? offset + contentLength : undefined);
    this.state = { ...this.state, total: size, downloaded: offset };
    const input = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
    const output = createWriteStream(part, { flags: offset ? 'a' : 'w' });
    await this.pipeWithProgress(input, output, offset, size, pending);
    if (!existsSync(part)) throw new Error('语音资源包下载未完成');
    await fs.rm(archive, { force: true });
    await fs.rename(part, archive);
    return archive;
  }

  private async remoteSize(url: string): Promise<number | undefined> {
    try {
      const response = await this.fetchImpl(url, { method: 'HEAD', signal: this.abort?.signal });
      const size = Number(response.headers.get('content-length') || 0);
      return Number.isFinite(size) && size > 0 ? size : undefined;
    } catch { return undefined; }
  }

  private async rangeSupported(url: string): Promise<boolean> {
    try {
      const response = await this.fetchImpl(url, { headers: { Range: 'bytes=0-0' }, signal: this.abort?.signal });
      const supported = response.status === 206;
      await response.body?.cancel().catch(() => {});
      return supported;
    } catch { return false; }
  }

  private async downloadParallel(url: string, part: string, archive: string, pending: PendingDownload, total: number): Promise<void> {
    const directory = this.segmentDirectory(pending);
    mkdirSync(directory, { recursive: true });
    const count = Math.max(1, Math.min(PARALLEL_CONNECTIONS, Math.ceil(total / this.parallelChunkBytes)));
    const ranges = Array.from({ length: count }, (_, index) => {
      const start = Math.floor(total * index / count);
      const end = Math.floor(total * (index + 1) / count) - 1;
      return { start, end, file: path.join(directory, `${index}.segment`) };
    });
    let downloaded = ranges.reduce((sum, range) => {
      const size = existsSync(range.file) ? statSync(range.file).size : 0;
      return sum + Math.min(size, range.end - range.start + 1);
    }, 0);
    this.state = { ...this.state, total, downloaded, progress: total ? downloaded / total : undefined };
    this.emit(true);
    let last = this.now();
    let lastBytes = downloaded;
    const note = (bytes: number) => {
      downloaded += bytes;
      const at = this.now();
      if (at - last < 250) return;
      const seconds = Math.max(0.001, (at - last) / 1000);
      const speed = Math.max(0, (downloaded - lastBytes) / seconds);
      this.state = {
        ...this.state, downloaded, total, speed,
        eta_seconds: speed > 0 ? Math.max(0, (total - downloaded) / speed) : undefined,
        progress: total ? Math.min(1, downloaded / total) : undefined,
      };
      this.pending = { ...pending, total };
      this.emit();
      last = at;
      lastBytes = downloaded;
    };
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    this.abort?.signal.addEventListener('abort', forwardAbort, { once: true });
    let failure: unknown;
    try {
      const results = await Promise.allSettled(ranges.map(async range => {
        try {
          let have = existsSync(range.file) ? statSync(range.file).size : 0;
          if (have >= range.end - range.start + 1) return;
          const response = await this.fetchImpl(url, {
            headers: { Range: `bytes=${range.start + have}-${range.end}` }, signal: controller.signal,
          });
          if (response.status !== 206 || !response.body) {
            throw new Error(response.status === 200 ? '下载服务器不支持分段下载，正在改用单线程' : `语音资源包下载失败（HTTP ${response.status}）`);
          }
          const input = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
          const output = createWriteStream(range.file, { flags: have ? 'a' : 'w' });
          await new Promise<void>((resolve, reject) => {
            input.on('data', chunk => note(Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk))));
            input.on('error', reject);
            output.on('error', reject);
            output.on('finish', resolve);
            input.pipe(output);
          });
        } catch (error) {
          controller.abort();
          throw error;
        }
      }));
      failure = results.find(result => result.status === 'rejected')?.reason;
    } finally {
      this.abort?.signal.removeEventListener('abort', forwardAbort);
    }
    if (failure) {
      controller.abort();
      throw failure;
    }
    const completed = ranges.reduce((sum, range) => sum + (existsSync(range.file) ? statSync(range.file).size : 0), 0);
    if (completed !== total) throw new Error('语音资源包下载不完整，请重试');
    await fs.rm(part, { force: true });
    const handle = await fs.open(part, 'w');
    let position = 0;
    try {
      for (const range of ranges) {
        const input = createReadStream(range.file);
        for await (const chunk of input) {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          let offset = 0;
          while (offset < data.length) {
            const { bytesWritten } = await handle.write(data, offset, data.length - offset, position);
            offset += bytesWritten;
            position += bytesWritten;
          }
        }
      }
    } finally { await handle.close(); }
    await fs.rm(directory, { recursive: true, force: true });
    this.state = { ...this.state, downloaded: total, total, progress: 1, speed: undefined, eta_seconds: undefined };
    this.emit(true);
    await fs.rm(archive, { force: true });
    await fs.rename(part, archive);
  }

  private async pipeWithProgress(
    input: NodeJS.ReadableStream, output: NodeJS.WritableStream,
    offset: number, total: number | undefined, pending: PendingDownload,
  ): Promise<void> {
    let downloaded = offset;
    let last = this.now();
    let lastBytes = downloaded;
    await new Promise<void>((resolve, reject) => {
      input.on('data', chunk => {
        downloaded += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
        const at = this.now();
        if (at - last >= 250) {
          const seconds = Math.max(0.001, (at - last) / 1000);
          const speed = Math.max(0, (downloaded - lastBytes) / seconds);
          this.state = {
            ...this.state, downloaded, total, speed,
            eta_seconds: total && speed > 0 ? Math.max(0, (total - downloaded) / speed) : undefined,
            progress: total ? Math.min(1, downloaded / total) : undefined,
          };
          this.pending = { ...pending, total };
          this.emit();
          last = at;
          lastBytes = downloaded;
        }
      });
      input.on('error', reject);
      output.on('error', reject);
      output.on('finish', () => {
        this.state = { ...this.state, downloaded, total, progress: total ? Math.min(1, downloaded / total) : undefined };
        this.pending = { ...pending, total };
        this.emit(true);
        resolve();
      });
      input.pipe(output);
    });
  }

  private async verify(archive: string, expected: string, size?: number): Promise<void> {
    this.state = { ...this.state, phase: 'verifying', message: '正在校验语音资源包', progress: 0, speed: undefined, eta_seconds: undefined, downloaded: 0, total: size || statSync(archive).size };
    this.emit(true);
    const hash = createHash('sha256');
    let read = 0;
    const total = this.state.total || 0;
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(archive);
      stream.on('data', chunk => {
        hash.update(chunk);
        read += chunk.length;
        if (total && read % (16 * 1024 * 1024) < chunk.length) {
          this.state = { ...this.state, downloaded: read, progress: Math.min(1, read / total) };
          this.emit();
        }
      });
      stream.on('error', reject);
      stream.on('end', resolve);
    });
    const actual = hash.digest('hex');
    if (actual !== expected.toLowerCase()) {
      await fs.rm(archive, { force: true });
      throw new Error('语音资源包校验失败，请重新下载');
    }
    this.state = { ...this.state, downloaded: total, progress: 1 };
    this.emit(true);
  }

  private async extractAndInstall(archive: string, manifest: VoicePackManifest, variant: VoicePackVariant): Promise<string> {
    this.state = { ...this.state, phase: 'extracting', message: '正在解压语音资源包', progress: undefined };
    this.emit(true);
    let final = path.join(this.voiceRoot, `${manifest.pack_id}-${manifest.version}-${variant.id}`);
    if (existsSync(final)) final = `${final}-${this.now()}`;
    const staging = path.join(this.voiceRoot, `.staging-${manifest.pack_id}-${this.now()}`);
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(staging, { recursive: true });
    const directory = await unzipper.Open.file(archive);
    await directory.extract({ path: staging });
    const root = this.findPackRoot(staging);
    const metadata = this.readPackMetadata(root);
    this.validatePackRoot(root, metadata);
    if (metadata.pack_id !== manifest.pack_id || metadata.version !== manifest.version) throw new Error('语音包内容与清单不一致');
    await fs.rename(root, final);
    await fs.rm(staging, { recursive: true, force: true });
    await fs.rm(archive, { force: true });
    await fs.rm(path.join(this.downloadRoot, `${manifest.pack_id}-${manifest.version}-${variant.id}.zip.part`), { force: true });
    await fs.rm(path.join(this.downloadRoot, `${manifest.pack_id}-${manifest.version}-${variant.id}.zip.part.segments`), { recursive: true, force: true });
    return final;
  }

  private async unpackArchive(archive: string, name: string): Promise<{ staging: string; root: string }> {
    const staging = path.join(this.voiceRoot, `.staging-${name}`);
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(staging, { recursive: true });
    const directory = await unzipper.Open.file(archive);
    await directory.extract({ path: staging });
    return { staging, root: this.findPackRoot(staging) };
  }

  private discoveredCandidates(): { kind: 'pack' | 'archive'; path: string; at: number }[] {
    const candidates: { kind: 'pack' | 'archive'; path: string; at: number }[] = [];
    try {
      for (const entry of readdirSync(this.voiceRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const root = this.findPackRoot(path.join(this.voiceRoot, entry.name));
        if (!existsSync(path.join(root, 'voice-pack.json'))) continue;
        try { candidates.push({ kind: 'pack', path: root, at: statSync(root).mtimeMs }); } catch { /* Unreadable entry. */ }
      }
    } catch { /* The voice folder is created in the constructor. */ }
    try {
      for (const entry of readdirSync(this.downloadRoot, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.zip')) continue;
        const archive = path.join(this.downloadRoot, entry.name);
        try {
          if (statSync(archive).size > 0) candidates.push({ kind: 'archive', path: archive, at: statSync(archive).mtimeMs });
        } catch { /* Unreadable archive. */ }
      }
    } catch { /* The download folder is created in the constructor. */ }
    return candidates.sort((left, right) => right.at - left.at);
  }

  private discoveredManifest(metadata: VoicePackMetadata, variant: VoicePackVariant): VoicePackManifest {
    return { format: 1, pack_id: metadata.pack_id, version: metadata.version, variants: [variant] };
  }

  private discoveredVariant(metadata: VoicePackMetadata): VoicePackVariant {
    return {
      id: 'discovered', kind: metadata.runtime?.kind === 'cuda' ? 'cuda' : 'cpu',
      url: '', sha256: '', label: '已下载',
    };
  }

  /** Import a finished download or extracted pack from the fixed voice folder. */
  private async adoptDiscovered(): Promise<boolean> {
    for (const candidate of this.discoveredCandidates()) {
      if (candidate.kind === 'pack') {
        let metadata: VoicePackMetadata;
        try {
          metadata = this.readPackMetadata(candidate.path);
          this.validatePackRoot(candidate.path, metadata);
        } catch { continue; /* An incomplete folder must not block the next candidate. */ }
        this.state = { ...this.state, phase: 'configuring', message: '正在导入已下载的语音包', progress: undefined, downloaded: undefined, total: undefined, speed: undefined, eta_seconds: undefined, error: undefined };
        this.emit(true);
        const variant = this.discoveredVariant(metadata);
        await this.applyInstalled(candidate.path, this.discoveredManifest(metadata, variant), variant);
        return true;
      }
      let staging: string | undefined;
      let metadata: VoicePackMetadata | undefined;
      let final = '';
      try {
        this.state = { ...this.state, phase: 'extracting', message: '正在导入已下载的语音包', progress: undefined, downloaded: undefined, total: undefined, speed: undefined, eta_seconds: undefined, error: undefined };
        this.emit(true);
        const unpacked = await this.unpackArchive(candidate.path, `discovered-${this.now()}`);
        staging = unpacked.staging;
        metadata = this.readPackMetadata(unpacked.root);
        this.validatePackRoot(unpacked.root, metadata);
        final = path.join(this.voiceRoot, `${metadata.pack_id}-${metadata.version}-discovered`);
        if (existsSync(final)) final = `${final}-${this.now()}`;
        await fs.rename(unpacked.root, final);
        await fs.rm(staging, { recursive: true, force: true });
        staging = undefined;
        await fs.rm(candidate.path, { force: true });
      } catch {
        if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      this.state = { ...this.state, phase: 'configuring', message: '正在导入已下载的语音包' };
      this.emit(true);
      const variant = this.discoveredVariant(metadata);
      await this.applyInstalled(final, this.discoveredManifest(metadata, variant), variant);
      return true;
    }
    return false;
  }

  private async reconfigureInstalled(): Promise<void> {
    const record = this.installed!;
    const variant: VoicePackVariant = { id: record.variant, kind: record.kind, url: '', sha256: '' };
    const manifest: VoicePackManifest = { format: 1, pack_id: record.pack_id, version: record.version, variants: [variant] };
    await this.applyInstalled(record.root, manifest, variant);
  }

  private findPackRoot(root: string): string {
    if (existsSync(path.join(root, 'voice-pack.json'))) return root;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(path.join(root, entry.name, 'voice-pack.json'))) return path.join(root, entry.name);
    }
    return root;
  }

  private readPackMetadata(root: string): VoicePackMetadata {
    const value = parseJson(readFileSync(path.join(root, 'voice-pack.json'), 'utf8'));
    return validatePackMetadata(value);
  }

  private validatePackRoot(root: string, metadata: VoicePackMetadata) {
    const resolve = (value: string) => {
      const target = path.resolve(root, value);
      const relative = path.relative(root, target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('语音包路径越界');
      return target;
    };
    for (const [key, value] of Object.entries(metadata.paths)) {
      if (!value) continue;
      const target = resolve(value);
      if (key === 'engine_root' || key === 'source_root' || key === 'nltk_data') {
        if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`语音包资源缺失：${key}`);
      } else if (!existsSync(target) || !statSync(target).isFile()) {
        throw new Error(`语音包资源缺失：${key}`);
      }
    }
    if (!existsSync(path.join(resolve(metadata.paths.engine_root), 'GPT_SoVITS', 'inference_webui.py'))) throw new Error('语音包中的 GPT-SoVITS 引擎不完整');
  }

  private async applyInstalled(root: string, manifest: VoicePackManifest, variant: VoicePackVariant) {
    this.state = { ...this.state, phase: 'configuring', message: '正在写入语音配置', progress: undefined };
    this.emit(true);
    const metadata = this.readPackMetadata(root);
    const absolute = (value: string | undefined) => value ? path.resolve(root, value) : undefined;
    const gpu = this.state.gpu;
    const voice: Record<string, unknown> = {
      voice_mode: 'sovits',
      restart_pending: true,
      python: absolute(metadata.paths.python),
      engine_root: absolute(metadata.paths.engine_root),
      model_gpt: absolute(metadata.paths.model_gpt),
      model_sovits: absolute(metadata.paths.model_sovits),
      reference_audio: absolute(metadata.paths.reference_audio),
      device: variant.kind === 'cuda' && gpu ? 'cuda' : 'cpu',
      precision: variant.kind === 'cuda' && gpu ? 'fp16' : 'fp32',
      gpu_index: 0,
      max_chars: 24,
      cpu_threads: 8,
    };
    if (metadata.reference_text) voice.reference_text = metadata.reference_text;
    if (metadata.paths.source_root) voice.source_root = absolute(metadata.paths.source_root);
    if (metadata.paths.nltk_data) voice.nltk_data = absolute(metadata.paths.nltk_data);
    const installed: InstalledRecord = {
      format: 1, pack_id: manifest.pack_id, version: manifest.version,
      variant: variant.id, kind: variant.kind, root, installed_at: new Date(this.now()).toISOString(),
      configured: false,
    };
    this.installed = installed;
    this.pending = undefined;
    this.writeInstallFile({ format: 1, installed });
    if (this.applyVoice) await this.applyVoice(voice);
    installed.configured = true;
    this.writeInstallFile({ format: 1, installed });
    this.state = {
      ...this.state, phase: 'ready', installed: true, restart_required: true,
      pack_id: manifest.pack_id, version: manifest.version, variant: variant.id,
      kind: variant.kind, label: variant.label || (variant.kind === 'cuda' ? 'GPU 加速' : 'CPU'),
      message: '语音环境已配置，重启应用后生效', progress: 1, speed: undefined, eta_seconds: undefined, error: undefined,
    };
    this.emit(true);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
