import type { VoicePackState } from '../electron/voicePack';
import type { ModelState } from './state';

const activePhases = new Set(['detecting', 'downloading', 'verifying', 'extracting', 'configuring']);

export function voiceModeOf(state: ModelState): string {
  const voice = (state.settings.voice || {}) as Record<string, unknown>;
  return String(voice.voice_mode || 'silent');
}

export function hasExternalVoice(state: ModelState): boolean {
  const voice = (state.settings.voice || {}) as Record<string, unknown>;
  return voiceModeOf(state) === 'sovits' || (voiceModeOf(state) === 'auto' && Boolean(voice.engine_root));
}

export function voicePackBubbleVisible(state: ModelState): boolean {
  if (!state.settingsLoaded || !state.voicePack) return false;
  const pack = state.voicePack;
  if (activePhases.has(pack.phase) || (pack.phase === 'ready' && pack.restart_required) || pack.phase === 'failed' || pack.phase === 'paused') return true;
  if (hasExternalVoice(state) || voiceModeOf(state) === 'system') return false;
  return !pack?.installed;
}

export function voicePackBusy(pack: VoicePackState | undefined): boolean {
  return Boolean(pack && activePhases.has(pack.phase));
}

export function voicePackPercent(pack: VoicePackState | undefined): number {
  if (!pack) return 0;
  if (typeof pack.progress === 'number' && Number.isFinite(pack.progress)) return Math.max(0, Math.min(1, pack.progress));
  if (pack.total && pack.downloaded) return Math.max(0, Math.min(1, pack.downloaded / pack.total));
  return 0;
}

export function formatBytes(value: number | undefined): string {
  if (!value || !Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

export function formatSpeed(value: number | undefined): string {
  if (!value || !Number.isFinite(value) || value <= 0) return '';
  return `${formatBytes(value)}/s`;
}

export function formatEta(seconds: number | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `约 ${Math.ceil(seconds)} 秒`;
  return `约 ${Math.ceil(seconds / 60)} 分钟`;
}

export function voicePackStage(pack: VoicePackState | undefined): { title: string; detail: string } {
  if (!pack) return { title: '彩名音色', detail: '文字聊天不受影响' };
  const progress = voicePackPercent(pack);
  if (pack.phase === 'detecting') return { title: '正在检查声音环境', detail: '马上开始下载' };
  if (pack.phase === 'downloading') {
    const size = pack.total ? `${formatBytes(pack.downloaded)} / ${formatBytes(pack.total)}` : formatBytes(pack.downloaded);
    return { title: `正在下载语音包 ${Math.round(progress * 100)}%`, detail: [size, formatSpeed(pack.speed), formatEta(pack.eta_seconds)].filter(Boolean).join(' · ') };
  }
  if (pack.phase === 'paused') return { title: '语音包下载已暂停', detail: pack.downloaded ? `已下载 ${formatBytes(pack.downloaded)}，可以继续` : '可以稍后继续' };
  if (pack.phase === 'verifying') return { title: '正在校验语音包', detail: pack.total ? `${formatBytes(pack.downloaded)} / ${formatBytes(pack.total)}` : '请稍候' };
  if (pack.phase === 'extracting') return { title: '正在解压语音包', detail: '这需要一点时间，聊天仍然可用' };
  if (pack.phase === 'configuring') return { title: '正在写入语音配置', detail: '完成后会提示重启应用' };
  if (pack.phase === 'ready') return { title: pack.restart_required ? '语音环境已配置' : '语音已就绪', detail: pack.restart_required ? '重启应用后生效' : '可以正常使用彩名的声音' };
  if (pack.phase === 'failed') return { title: '语音包安装失败', detail: pack.error || '请重试或导入本地语音包' };
  return { title: '想听彩名的声音吗？', detail: '下载语音包后可以用彩名音色说话，文字聊天不受影响' };
}

export function voicePackVariantLabel(pack: VoicePackState | undefined): string {
  if (!pack) return '';
  if (pack.label) return pack.label;
  return pack.kind === 'cuda' ? 'GPU 加速' : pack.kind === 'cpu' ? 'CPU 模式' : '';
}

export function dismissalExpired(value: string | null, now = Date.now()): boolean {
  if (!value) return true;
  const dismissed = Number(value);
  return !Number.isFinite(dismissed) || now - dismissed > 7 * 24 * 60 * 60 * 1000;
}
