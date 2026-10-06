import { useEffect, useRef, useState, type CSSProperties } from 'react';
import defaults from '../../../config/default.json';
import { Icon } from './components';
import avatarCatalog from '../../../characters/ayana/avatar-map.json';

export interface CompanionDesign {
  portrait_range: 'half' | 'full'; portrait_size: number; frame_width: number; frame_height: number;
  font_size: number; opacity: number; show_subtitles: boolean; show_japanese: boolean;
  primary_language: 'ja' | 'zh' | 'en'; translation_language: 'none' | 'ja' | 'zh' | 'en';
  background_mode: 'transparent' | 'frosted' | 'image' | 'minimal' | 'solid';
  background_color: string; portrait_side: 'left' | 'right'; portrait_x: number; portrait_y: number;
}
export const defaultDesign = defaults.companion_ui as CompanionDesign;
export function companionDesign(settings: Record<string, unknown>): CompanionDesign {
  const stored = settings.companion_ui as Partial<CompanionDesign> || {};
  const primary = stored.primary_language || (settings.subtitles === false ? 'ja' : defaultDesign.primary_language);
  const translation = stored.translation_language || (stored.show_japanese && primary !== 'ja' ? 'ja' : 'none');
  return { ...defaultDesign, ...stored, primary_language: primary, translation_language: translation === primary ? 'none' : translation };
}
export function designPatch(saved: CompanionDesign, draft: CompanionDesign): Partial<CompanionDesign> {
  return Object.fromEntries(Object.entries(draft).filter(([key, value]) => value !== saved[key as keyof CompanionDesign]));
}
export function useCompanionDesign(settings: Record<string, unknown>) {
  const saved = companionDesign(settings);
  const [draft, setDraft] = useState(saved);
  const baseline = useRef(saved);
  useEffect(() => {
    const previous = baseline.current;
    const next = companionDesign(settings);
    setDraft(current => ({ ...next, ...designPatch(previous, current) }));
    baseline.current = next;
  }, [settings.companion_ui]);
  return { draft, setDraft, patch: designPatch(saved, draft) };
}
export function designStyle(value: CompanionDesign): CSSProperties {
  return { '--portrait-size': `${value.portrait_size}px`, '--portrait-scale': value.portrait_size / 320, '--frame-width': `${value.frame_width}px`,
    '--note-color': value.background_color, '--portrait-x': `${value.portrait_x}px`, '--portrait-y': `${value.portrait_y}px`, '--dialogue-font': `${value.font_size}px`, '--frame-opacity': value.opacity / 100 } as CSSProperties;
}

export function designTone(value: CompanionDesign) {
  const rgb = value.background_color.slice(1).match(/../g)?.map(part => parseInt(part, 16)) || [0, 0, 0];
  return ['solid', 'minimal'].includes(value.background_mode) && value.opacity >= 70
    && rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114 > 160 ? 'light' : 'dark';
}

export function DesignControls({ value, onChange, onSave, onClose, onBackground, onUndo, costume, onCostume, saving, dirty, message }: {
  value: CompanionDesign; onChange: (patch: Partial<CompanionDesign>) => void;
  onSave: () => void; onClose: () => void; saving: boolean; dirty: boolean; message: string;
  onBackground: () => void;
  onUndo: () => void; costume: string; onCostume: (value: string) => void;
}) {
  const [tab, setTab] = useState<'portrait' | 'dialogue' | 'frame'>('portrait');
  const costumes = [...new Set(Object.values(avatarCatalog.assets).map(item => item.costume))];
  const range = (key: 'portrait_size' | 'font_size' | 'opacity', label: string, min: number, max: number, unit: string) =>
    <label className="design-range"><span>{label}<output>{key === 'portrait_size' ? Math.round(value[key] / 320 * 100) : value[key]}{unit}</output></span><input aria-label={label} type="range" min={min} max={max} step={1} value={value[key]} onChange={event => onChange({ [key]: Number(event.target.value) })}/></label>;
  return <aside className="design-controls design-inspector" aria-label="设计控件" data-companion-interactive onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } }}>
    <header><div><span>AYANA / APPEARANCE</span><h2>彩名的外观</h2></div><div>
      <button type="button" disabled={saving} aria-label="重置设计" title="恢复默认设计" onClick={() => onChange(defaultDesign)}><Icon name="refresh" size={15}/></button>
      <button type="button" aria-label="收起设计控件" onClick={onClose}><Icon name="close" size={15}/></button>
    </div></header>
    <p className="design-intro">调整时，彩名会同步预览。</p>
    <nav className="design-tabs" role="tablist" aria-label="外观分类">{([['portrait', '立绘'], ['dialogue', '对白'], ['frame', '便签']] as const).map(([id, label]) => <button key={id} id={`design-tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`design-pane-${id}`} onClick={() => setTab(id)}>{label}</button>)}</nav>
    <fieldset disabled={saving} className="design-fields" role="tabpanel" id={`design-pane-${tab}`} aria-labelledby={`design-tab-${tab}`}>
      {tab === 'portrait' && <>
      <label className="design-select"><span>服装</span><select aria-label="服装" value={costume} onChange={event => onCostume(event.target.value)}>{costumes.map(item => <option key={item}>{item}</option>)}</select></label>
      {range('portrait_size', '立绘大小', 160, 640, '%')}
      <label className="design-select"><span>站位</span><select aria-label="立绘站位" value={value.portrait_side} onChange={event => onChange({ portrait_side: event.target.value as 'left' | 'right' })}><option value="right">右侧</option><option value="left">左侧</option></select></label>
      <button type="button" className="design-background-button" onClick={() => onChange({ portrait_x: 0, portrait_y: 0 })}>位置归中</button>
      <p className="design-field-note">直接拖动画面里的彩名调整位置，滑条调整大小。使用完整全身立绘，默认显示到膝盖；超出窗口的部分会被裁切。</p>
      </>}
      {tab === 'dialogue' && <>
      {range('font_size', '字幕字号', 18, 26, 'px')}
      <label className="design-toggle"><span>说话时显示字幕</span><input type="checkbox" checked={value.show_subtitles} onChange={event => onChange({ show_subtitles: event.target.checked })}/></label>
      <label className="design-select"><span>主语言</span><select aria-label="对白主语言" value={value.primary_language} disabled={!value.show_subtitles} onChange={event => { const primary_language = event.target.value as CompanionDesign['primary_language']; onChange({ primary_language, ...(value.translation_language === primary_language ? { translation_language: 'none' } : {}) }); }}><option value="ja">日语</option><option value="zh">中文</option><option value="en">英文</option></select></label>
      <label className="design-select"><span>翻译语言</span><select aria-label="对白翻译语言" value={value.translation_language} disabled={!value.show_subtitles} onChange={event => onChange({ translation_language: event.target.value as CompanionDesign['translation_language'] })}><option value="none">关闭 · 只显示主语言</option>{([['ja', '日语'], ['zh', '中文'], ['en', '英文']] as const).filter(([id]) => id !== value.primary_language).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <p className="design-field-note">主语言显示为大字，翻译显示在下方。滚动时，视觉中心的句子会更清晰。这里只调整字幕语言。</p>
      </>}
      {tab === 'frame' && <>
      <p className="design-window-hint">拖动窗口边缘或四角调整大小，拖动顶部标题栏移动窗口。大小和位置会自动记住。</p>
      <label className="design-select"><span>便签背景</span><select aria-label="便签背景" value={value.background_mode} onChange={event => onChange({ background_mode: event.target.value as CompanionDesign['background_mode'] })}><option value="minimal">简约 · 光影</option><option value="solid">纯色</option><option value="transparent">透明</option><option value="frosted">磨砂</option><option value="image">自选图片</option></select></label>
      {value.background_mode === 'image' && <button type="button" className="design-background-button" onClick={onBackground}>选择 / 更换背景图片</button>}
      {(value.background_mode === 'solid' || value.background_mode === 'minimal') && <div className="design-colors"><span>背景颜色</span><div className="design-swatches">{['#25282d', '#293831', '#343044', '#43342b', '#1c3042'].map(color => <button key={color} type="button" aria-label={`背景色 ${color}`} aria-pressed={value.background_color === color} style={{ background: color }} onClick={() => onChange({ background_color: color })}/>)}</div><label className="design-select"><span>自选纯色</span><input type="color" aria-label="自选背景颜色" value={value.background_color} onChange={event => onChange({ background_color: event.target.value })}/></label></div>}
      {range('opacity', '背景不透明度', 0, 100, '%')}
      <p className="design-field-note">立绘随窗口重新适配，位置保持在框内。</p>
      </>}
    </fieldset>
    <footer><span role="status">{message || (dirty ? '有未保存的调整' : '当前外观已保存')}</span><div><button type="button" className="design-undo" disabled={saving || !dirty} onClick={onUndo}>撤销预览</button><button type="button" disabled={saving || !dirty} onClick={onSave}>{saving ? '保存中' : '保存设计'}</button></div></footer>
  </aside>;
}
