import { useState } from 'react';
import { Button, Icon } from './components';
import { bridge, type ModelState } from './state';
import {
  dismissalExpired, formatBytes, formatEta, formatSpeed, voicePackBusy,
  voicePackBubbleVisible, voicePackPercent, voicePackStage, voicePackVariantLabel,
} from './voicePackView';

const DISMISS_KEY = 'ayana.voicePack.dismissedAt';

function Progress({ state }: { state: ModelState }) {
  const pack = state.voicePack;
  if (!pack || !['downloading', 'verifying'].includes(pack.phase)) return null;
  const percent = Math.round(voicePackPercent(pack) * 100);
  return <div className="voice-pack-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${percent}%` }}/></div>;
}

function GpuLine({ state }: { state: ModelState }) {
  const gpu = state.voicePack?.gpu;
  if (!gpu) return <span className="voice-pack-muted">未检测到 NVIDIA 显卡，将使用 CPU</span>;
  return <span className="voice-pack-muted">{gpu.name} · 驱动 {gpu.driver}</span>;
}

export function VoicePackBubble({ state }: { state: ModelState }) {
  const [dismissed, setDismissed] = useState(() => {
    try { return !dismissalExpired(localStorage.getItem(DISMISS_KEY)); } catch { return false; }
  });
  const pack = state.voicePack;
  const busy = voicePackBusy(pack);
  const restartNeeded = pack?.phase === 'ready' && pack.restart_required;
  if (!voicePackBubbleVisible(state) || (dismissed && !busy && !restartNeeded)) return null;
  const stage = voicePackStage(pack);
  const percent = Math.round(voicePackPercent(pack) * 100);
  const variant = voicePackVariantLabel(pack);
  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* private mode */ }
    setDismissed(true);
  };
  const start = () => { setDismissed(false); void bridge.voicePack.start(); };
  const cancel = () => { void bridge.voicePack.cancel(); };
  const importLocal = () => { setDismissed(false); void bridge.voicePack.importLocal(); };
  const restart = () => { void bridge.restartApp(); };
  const openSettings = () => { void bridge.openSettings(); };
  const showProgress = pack && ['downloading', 'verifying', 'extracting', 'configuring'].includes(pack.phase);
  const canDownload = pack?.can_download !== false;
  const failed = pack?.phase === 'failed';
  const paused = pack?.phase === 'paused';
  return <aside className="voice-pack-bubble" data-companion-interactive aria-label="Ayana 语音资源包">
    <header>
      <span className="voice-pack-icon"><Icon name="volume" size={15}/></span>
      <div><strong>{stage.title}</strong><small>{stage.detail}</small></div>
      {!busy && !restartNeeded && <button type="button" className="voice-pack-close" aria-label="暂时关闭" title="暂时关闭" onClick={dismiss}><Icon name="close" size={13}/></button>}
    </header>
    {pack?.gpu && !busy && <GpuLine state={state}/>}
    {variant && <span className="voice-pack-chip">{variant}</span>}
    <Progress state={state}/>
    {pack?.error && pack.phase !== 'failed' && <div className="voice-pack-error" role="alert">{pack.error}</div>}
    <div className="voice-pack-actions">
      {restartNeeded && <Button type="button" color="primary" variant="solid" onClick={restart}>立即重启 Ayana</Button>}
      {restartNeeded && <Button type="button" variant="light" onClick={dismiss}>稍后</Button>}
      {!restartNeeded && !busy && !failed && !paused && pack?.installed !== true && canDownload && <Button type="button" color="primary" variant="solid" onClick={start}>下载 Ayana 音色</Button>}
      {!restartNeeded && !busy && (failed || paused) && canDownload && <Button type="button" color="primary" variant="solid" onClick={start}>{paused ? '继续下载' : '重试'}</Button>}
      {pack?.phase === 'downloading' && <Button type="button" variant="light" onClick={cancel}>暂停</Button>}
      {busy && showProgress && <span className="voice-pack-percent">{percent}%</span>}
      {!busy && !restartNeeded && <Button type="button" variant="light" onClick={importLocal}>导入本地包</Button>}
      {!busy && !restartNeeded && <button type="button" className="voice-pack-text" onClick={openSettings}>设置</button>}
    </div>
    {!canDownload && !busy && <span className="voice-pack-muted">下载地址尚未配置，可以导入本地语音包。</span>}
  </aside>;
}

export function VoicePackSettings({ state }: { state: ModelState }) {
  const pack = state.voicePack;
  if (!pack) return null;
  const stage = voicePackStage(pack);
  const percent = Math.round(voicePackPercent(pack) * 100);
  const busy = voicePackBusy(pack);
  const restartNeeded = pack?.phase === 'ready' && pack.restart_required;
  const canDownload = pack?.can_download !== false;
  const start = () => { void bridge.voicePack.start(); };
  const cancel = () => { void bridge.voicePack.cancel(); };
  const importLocal = () => { void bridge.voicePack.importLocal(); };
  const restart = () => { void bridge.restartApp(); };
  return <div className="voice-pack-settings" aria-label="语音资源包">
    <div className="voice-pack-settings-head">
      <div className="voice-pack-settings-copy"><strong>{stage.title}</strong><span>{stage.detail}</span></div>
      <span className={`voice-pack-state ${pack?.phase || 'idle'}`}>{pack?.installed ? '已安装' : busy ? '进行中' : '未安装'}</span>
    </div>
    <GpuLine state={state}/>
    <div className="voice-pack-meta">
      {pack?.version && <span>版本 {pack.version}</span>}
      {voicePackVariantLabel(pack) && <span>{voicePackVariantLabel(pack)}</span>}
      {pack?.total && <span>{formatBytes(pack.total)}</span>}
    </div>
    <Progress state={state}/>
    {pack?.phase === 'downloading' && <div className="voice-pack-detail">{formatBytes(pack.downloaded)} / {formatBytes(pack.total)}{pack.speed ? ` · ${formatSpeed(pack.speed)}` : ''}{pack.eta_seconds ? ` · ${formatEta(pack.eta_seconds)}` : ''}</div>}
    {pack?.error && <div className="voice-pack-error" role="alert">{pack.error}</div>}
    <div className="voice-pack-actions">
      {pack?.phase === 'downloading' && <Button type="button" variant="light" onClick={cancel}>暂停</Button>}
      {!busy && canDownload && (!pack?.installed || pack.phase === 'paused' || pack.phase === 'failed') && <Button type="button" color="primary" variant="solid" onClick={start}>{pack?.phase === 'paused' ? '继续下载' : pack?.phase === 'failed' ? (pack.installed ? '重试配置' : '重试') : '下载语音包'}</Button>}
      {!busy && <Button type="button" variant="light" onClick={importLocal}>导入本地包</Button>}
      {restartNeeded && <Button type="button" color="primary" variant="solid" onClick={restart}>立即重启 Ayana</Button>}
    </div>
    {!canDownload && !busy && <p className="form-hint">下载暂未开放，可以导入本地语音包。</p>}
    <p className="form-hint">下载会自动选择镜像并使用多线程加速，可随时暂停后继续；安装期间也可以继续文字聊天。</p>
  </div>;
}
