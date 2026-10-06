import type { CSSProperties } from 'react';
import defaults from '../../../config/default.json';
import { Icon } from './components';

export interface CompanionDesign {
  portrait_range: 'half' | 'full'; portrait_size: number; frame_width: number;
  font_size: number; opacity: number; show_subtitles: boolean; show_japanese: boolean;
  background_mode: 'transparent' | 'frosted' | 'image';
}
export const defaultDesign = defaults.companion_ui as CompanionDesign;
export function companionDesign(settings: Record<string, unknown>): CompanionDesign {
  return { ...defaultDesign, ...(settings.companion_ui as Partial<CompanionDesign> || {}) };
}
export function designStyle(value: CompanionDesign): CSSProperties {
  return { '--portrait-size': `${value.portrait_size}px`, '--frame-width': `${value.frame_width}px`,
    '--dialogue-font': `${value.font_size}px`, '--frame-opacity': value.opacity / 100 } as CSSProperties;
}

export function DesignControls({ value, onChange, onSave, onClose, onBackground, saving, dirty, message }: {
  value: CompanionDesign; onChange: (patch: Partial<CompanionDesign>) => void;
  onSave: () => void; onClose: () => void; saving: boolean; dirty: boolean; message: string;
  onBackground: () => void;
}) {
  const range = (key: 'portrait_size' | 'frame_width' | 'font_size' | 'opacity', label: string, min: number, max: number, unit: string) =>
    <label className="design-range"><span>{label}<output>{value[key]}{unit}</output></span><input aria-label={label} type="range" min={min} max={max} step={1} value={value[key]} onChange={event => onChange({ [key]: Number(event.target.value) })}/></label>;
  return <aside className="design-controls" aria-label="设计控件" data-companion-interactive>
    <header><div><span>APPEARANCE</span><h2>设计控件</h2></div><div>
      <button type="button" aria-label="重置设计" title="恢复默认设计" onClick={() => onChange(defaultDesign)}><Icon name="refresh" size={15}/></button>
      <button type="button" aria-label="收起设计控件" onClick={onClose}><Icon name="close" size={15}/></button>
    </div></header>
    <fieldset disabled={saving}>
      <label className="design-select"><span>立绘范围</span><select aria-label="立绘范围" value={value.portrait_range} onChange={event => onChange({ portrait_range: event.target.value as CompanionDesign['portrait_range'] })}><option value="half">半身</option><option value="full">全身</option></select></label>
      {range('portrait_size', '立绘大小', 220, 380, 'px')}
      <div className="design-range-grid">{range('frame_width', '便签宽度', 380, 900, 'px')}{range('font_size', '字幕字号', 18, 26, 'px')}</div>
      <label className="design-select"><span>便签背景</span><select aria-label="便签背景" value={value.background_mode} onChange={event => onChange({ background_mode: event.target.value as CompanionDesign['background_mode'] })}><option value="transparent">透明</option><option value="frosted">磨砂</option><option value="image">自选图片</option></select></label>
      {value.background_mode === 'image' && <button type="button" className="design-background-button" onClick={onBackground}>选择 / 更换背景图片</button>}
      {range('opacity', '背景浓度', 0, 96, '%')}
      <label className="design-toggle"><span>说话时显示字幕</span><input type="checkbox" checked={value.show_subtitles} onChange={event => onChange({ show_subtitles: event.target.checked })}/></label>
      <label className="design-toggle"><span>同时显示日语</span><input type="checkbox" checked={value.show_japanese} disabled={!value.show_subtitles} onChange={event => onChange({ show_japanese: event.target.checked })}/></label>
    </fieldset>
    <footer><span role="status">{message || (dirty ? '正在预览 · 保存后保留' : '随时调整，慢慢试。')}</span><button type="button" disabled={saving || !dirty} onClick={onSave}>{saving ? '保存中' : '保存设计'}</button></footer>
  </aside>;
}
