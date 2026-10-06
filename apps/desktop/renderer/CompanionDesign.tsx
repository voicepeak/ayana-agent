import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { surfacePalette } from './companionPalette';
import defaults from '../../../config/default.json';
import { Icon } from './components';
import avatarCatalog from '../../../characters/ayana/avatar-map.json';
import { wheelZoom } from './designZoom';
import { themes, resolveTheme } from './companionThemes';

export interface CompanionDesign {
  portrait_range: 'half' | 'full'; portrait_size: number; frame_width: number; frame_height: number;
  font_size: number; opacity: number; show_subtitles: boolean; show_japanese: boolean;
  primary_language: 'ja' | 'zh' | 'en'; translation_language: 'none' | 'ja' | 'zh' | 'en';
  background_mode: 'transparent' | 'frosted' | 'image' | 'minimal' | 'solid';
  background_color: string; portrait_side: 'left' | 'right'; portrait_x: number; portrait_y: number;
  show_bubbles: boolean; bubble_color: string; background_x: number; background_y: number;
  background_image: string;
  theme: 'ink' | 'paper' | 'forest' | 'sea' | 'custom'; background_zoom: number;
}
export const defaultDesign = defaults.companion_ui as CompanionDesign;
export function companionDesign(settings: Record<string, unknown>): CompanionDesign {
  const stored = settings.companion_ui as Partial<CompanionDesign> || {};
  const primary = stored.primary_language || (settings.subtitles === false ? 'ja' : defaultDesign.primary_language);
  const translation = stored.translation_language || (stored.show_japanese && primary !== 'ja' ? 'ja' : 'none');
  const theme = resolveTheme(stored);
  return { ...defaultDesign, ...stored, theme, opacity: 100,
    background_mode: ['transparent', 'frosted'].includes(stored.background_mode || '') ? 'solid' : stored.background_mode || defaultDesign.background_mode,
    primary_language: primary, translation_language: translation === primary ? 'none' : translation };
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
  const bubble = surfacePalette(value.bubble_color);
  const chrome = surfacePalette(value.background_color);
  return { '--portrait-size': `${value.portrait_size}px`, '--portrait-scale': value.portrait_size / 320, '--frame-width': `${value.frame_width}px`,
    '--background-position': `${value.background_x}% ${value.background_y}%`, '--bubble-color': value.bubble_color,
    '--bubble-text': bubble.text, '--bubble-secondary': bubble.muted, '--bubble-border': bubble.border,
    '--chrome-surface': chrome.background, '--chrome-text': chrome.text, '--chrome-muted': chrome.muted,
    '--chrome-border': chrome.border, '--chrome-accent': chrome.accent,
    '--bare-text': chrome.text, '--bare-secondary': chrome.muted,
    '--note-color': value.background_color, '--portrait-x': `${value.portrait_x}px`, '--portrait-y': `${value.portrait_y}px`, '--dialogue-font': `${value.font_size}px`, '--frame-opacity': 1 } as CSSProperties;
}

export function designTone(value: CompanionDesign) {
  return surfacePalette(value.background_color).light ? 'light' : 'dark';
}

function BackgroundPosition({ value, onChange, revision }: { value: CompanionDesign; onChange: (patch: Partial<CompanionDesign>) => void; revision: number }) {
  const image = useRef<HTMLImageElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const [imageSize, setImageSize] = useState({ width: 1, height: 1 });
  const [previewSize, setPreviewSize] = useState({ width: 1, height: 1 });
  const latest = useRef({ value, onChange }); latest.current = { value, onChange };
  useEffect(() => {
    const node = preview.current!;
    const resize = () => setPreviewSize({ width: node.clientWidth, height: node.clientHeight });
    const observer = new ResizeObserver(resize); observer.observe(node); resize();
    const zoom = (event: WheelEvent) => {
      event.preventDefault(); event.stopPropagation();
      const current = latest.current, background_zoom = wheelZoom(current.value.background_zoom, event.deltaY, event.deltaMode, 100, 300);
      latest.current = { ...current, value: { ...current.value, background_zoom } };
      current.onChange({ background_zoom });
    };
    node.addEventListener('wheel', zoom, { passive: false });
    return () => { observer.disconnect(); node.removeEventListener('wheel', zoom); };
  }, []);
  const imageScale = Math.max(previewSize.width / imageSize.width, previewSize.height / imageSize.height) * value.background_zoom / 100;
  const gesture = useRef<{ id: number; x: number; y: number; startX: number; startY: number; overflowX: number; overflowY: number } | null>(null);
  const stop = () => { gesture.current = null; };
  return <div className="design-background-position">
    <div ref={preview} className="design-background-preview" role="slider" tabIndex={0} aria-label="拖动调整背景图片位置" aria-valuemin={100} aria-valuemax={300} aria-valuenow={value.background_zoom} aria-valuetext={`缩放 ${value.background_zoom}%，水平 ${value.background_x}%，垂直 ${value.background_y}%`}
      style={{ aspectRatio: `${value.frame_width} / ${value.frame_height}`, backgroundSize: `${imageSize.width * imageScale}px ${imageSize.height * imageScale}px`, backgroundPosition: `${value.background_x}% ${value.background_y}%`, backgroundImage: `url("ayana-background://custom/?image=${value.background_image}&v=${revision}")` }}
      onPointerDown={event => {
        if (event.button !== 0 || !image.current?.naturalWidth) return;
        const rect = event.currentTarget.getBoundingClientRect(), img = image.current;
        const scale = Math.max(rect.width / img.naturalWidth, rect.height / img.naturalHeight) * value.background_zoom / 100;
        gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: value.background_x, startY: value.background_y, overflowX: img.naturalWidth * scale - rect.width, overflowY: img.naturalHeight * scale - rect.height };
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const drag = gesture.current;
        if (!drag || drag.id !== event.pointerId) return;
        const position = (start: number, delta: number, overflow: number) => overflow > 1 ? Math.round(Math.max(0, Math.min(100, start - delta / overflow * 100))) : start;
        onChange({ background_x: position(drag.startX, event.clientX - drag.x, drag.overflowX), background_y: position(drag.startY, event.clientY - drag.y, drag.overflowY) });
      }} onPointerUp={event => { stop(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={stop} onLostPointerCapture={stop} onBlur={stop}
      onKeyDown={event => {
        const deltas: Record<string, [number, number]> = { ArrowLeft: [-2, 0], ArrowRight: [2, 0], ArrowUp: [0, -2], ArrowDown: [0, 2] };
        const delta = deltas[event.key]; if (!delta) return; event.preventDefault();
        onChange({ background_x: Math.max(0, Math.min(100, value.background_x + delta[0])), background_y: Math.max(0, Math.min(100, value.background_y + delta[1])) });
      }}>
      <img ref={image} onLoad={event => setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} src={`ayana-background://custom/?image=${value.background_image}&v=${revision}`} alt="" hidden/><span>拖动取景 · 滚轮缩放</span>
    </div>
    <label className="design-range"><span>图片缩放<output>{value.background_zoom}%</output></span><input type="range" aria-label="背景图片缩放" min={100} max={300} value={value.background_zoom} onChange={event => onChange({ background_zoom: Number(event.target.value) })}/></label>
    <button type="button" className="design-background-button" onClick={() => onChange({ background_x: 50, background_y: 50, background_zoom: 100 })}>恢复取景</button>
  </div>;
}

export function DesignControls({ value, onChange, portraitEditing, onPortraitEditing, onSave, onClose, onBackground, onUndo, costume, onCostume, saving, dirty, message, backgroundRevision = 0 }: {
  value: CompanionDesign; onChange: (patch: Partial<CompanionDesign>) => void;
  portraitEditing: boolean; onPortraitEditing: (value: boolean) => void;
  onSave: () => void; onClose: () => void; saving: boolean; dirty: boolean; message: string;
  onBackground: () => void;
  onUndo: () => void; costume: string; onCostume: (value: string) => void;
  backgroundRevision?: number;
}) {
  const [tab, setTab] = useState<'portrait' | 'dialogue' | 'frame'>('portrait');
  const costumes = [...new Set(Object.values(avatarCatalog.assets).map(item => item.costume))];
  const range = (key: 'portrait_size' | 'font_size', label: string, min: number, max: number, unit: string) =>
    <label className="design-range"><span>{label}<output>{key === 'portrait_size' ? Math.round(value[key] / 320 * 100) : value[key]}{unit}</output></span><input aria-label={label} type="range" min={min} max={max} step={1} value={value[key]} onChange={event => onChange({ [key]: Number(event.target.value) })}/></label>;
  return <aside className="design-controls design-inspector" aria-label="设计控件" data-companion-interactive onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } }}>
    <header><div><h2>彩名的外观</h2></div><div>
      <button type="button" disabled={saving} aria-label="重置设计" title="恢复默认设计" onClick={() => onChange(defaultDesign)}><Icon name="refresh" size={15}/></button>
      <button type="button" aria-label="收起设计控件" onClick={onClose}><Icon name="close" size={15}/></button>
    </div></header>
    <p className="design-intro">调整仅为预览，保存成功后生效。收起设置会恢复已保存的外观。</p>
    <nav className="design-tabs" role="tablist" aria-label="外观分类">{([['portrait', '立绘'], ['dialogue', '对白'], ['frame', '便签']] as const).map(([id, label]) => <button key={id} id={`design-tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`design-pane-${id}`} onClick={() => setTab(id)}>{label}</button>)}</nav>
    <fieldset disabled={saving} className="design-fields" role="tabpanel" id={`design-pane-${tab}`} aria-labelledby={`design-tab-${tab}`}>
      {tab === 'portrait' && <>
      <label className="design-select"><span>服装</span><select aria-label="服装" value={costume} onChange={event => onCostume(event.target.value)}>{costumes.map(item => <option key={item}>{item}</option>)}</select></label>
      {range('portrait_size', '立绘大小', 160, 640, '%')}
      <label className="design-select"><span>站位</span><select aria-label="立绘站位" value={value.portrait_side} onChange={event => onChange({ portrait_side: event.target.value as 'left' | 'right' })}><option value="right">右侧</option><option value="left">左侧</option></select></label>
      <label className="design-toggle"><span>调整立绘位置</span><input type="checkbox" checked={portraitEditing} onChange={event => onPortraitEditing(event.target.checked)}/></label>
      <p className="design-field-note" role="status">{portraitEditing ? '拖动彩名调整位置，滚轮缩放。点击「保存设计」保留调整。' : '开启后，可在便签里拖动和滚轮缩放彩名。'}</p>
      <button type="button" className="design-background-button" onClick={() => onChange({ portrait_x: 0, portrait_y: 0 })}>位置归中</button>
      <p className="design-field-note">滑条调整大小。使用完整全身立绘，默认显示到膝盖；超出窗口的部分会被裁切。</p>
      </>}
      {tab === 'dialogue' && <>
      <label className="design-toggle"><span>显示对话气泡</span><input type="checkbox" checked={value.show_bubbles} onChange={event => onChange({ show_bubbles: event.target.checked })}/></label>
      <label className="design-select"><span>气泡颜色</span><input type="color" aria-label="气泡颜色" disabled={!value.show_bubbles} value={value.bubble_color} onChange={event => onChange({ bubble_color: event.target.value })}/></label>
      {range('font_size', '字幕字号', 14, 40, 'px')}
      <label className="design-toggle"><span>说话时显示字幕</span><input type="checkbox" checked={value.show_subtitles} onChange={event => onChange({ show_subtitles: event.target.checked })}/></label>
      <label className="design-select"><span>主语言</span><select aria-label="对白主语言" value={value.primary_language} disabled={!value.show_subtitles} onChange={event => { const primary_language = event.target.value as CompanionDesign['primary_language']; onChange({ primary_language, ...(value.translation_language === primary_language ? { translation_language: 'none' } : {}) }); }}><option value="ja">日语</option><option value="zh">中文</option><option value="en">英文</option></select></label>
      <label className="design-select"><span>翻译语言</span><select aria-label="对白翻译语言" value={value.translation_language} disabled={!value.show_subtitles} onChange={event => onChange({ translation_language: event.target.value as CompanionDesign['translation_language'] })}><option value="none">关闭 · 只显示主语言</option>{([['ja', '日语'], ['zh', '中文'], ['en', '英文']] as const).filter(([id]) => id !== value.primary_language).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <p className="design-field-note">关闭气泡后仍显示对白。文字明暗随气泡颜色调整；主语言为大字，翻译在下方。滚动时只突出一条台词。</p>
      </>}
      {tab === 'frame' && <>
      <div className="design-themes"><div>{themes.map(theme => <button key={theme.id} type="button" aria-pressed={value.theme === theme.id} onClick={() => onChange({ theme: theme.id, background_mode: 'minimal', background_color: theme.background, bubble_color: theme.bubble, opacity: 100 })}><i data-theme={theme.id} style={{ background: theme.background }}><b style={{ background: theme.bubble }}/></i><span>{theme.name}</span></button>)}
        <button type="button" className="design-custom-theme" aria-pressed={value.theme === 'custom'} onClick={() => onChange({ theme: 'custom', background_mode: value.background_mode === 'image' ? 'image' : 'solid', opacity: 100 })}><Icon name="settings" size={18}/><span>自定义</span></button>
      </div></div>
      {value.theme === 'custom' && <div className="design-custom-fields">
        <div className="design-custom-tabs" role="group" aria-label="自定义背景类型"><button type="button" aria-pressed={value.background_mode !== 'image'} onClick={() => onChange({ background_mode: 'solid' })}>纯色</button><button type="button" aria-pressed={value.background_mode === 'image'} onClick={() => onChange({ background_mode: 'image' })}>图片</button></div>
        <label className="design-select"><span>{value.background_mode === 'image' ? '底色与文字明暗' : '背景颜色'}</span><input type="color" aria-label="自选背景颜色" value={value.background_color} onChange={event => onChange({ background_color: event.target.value })}/></label>
        {value.background_mode === 'image' && <><button type="button" className="design-background-button" onClick={onBackground}>选择 / 更换背景图片</button>{value.background_image && <BackgroundPosition value={value} onChange={onChange} revision={backgroundRevision}/>}</>}
      </div>}
      </>}
    </fieldset>
    <footer><span role="status">{message || (dirty ? '仅预览 · 有未保存的调整' : '当前外观已保存')}</span><div><button type="button" className="design-undo" disabled={saving || !dirty} onClick={onUndo}>撤销预览</button><button type="button" disabled={saving || !dirty} onClick={onSave}>{saving ? '保存中' : '保存设计'}</button></div></footer>
  </aside>;
}
