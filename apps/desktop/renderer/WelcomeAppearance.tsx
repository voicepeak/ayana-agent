import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { CompanionPortrait } from './CompanionPortrait';
import { catalogFor, characterAspect, characterOptions, costumesOf } from './avatarCatalogs';
import { outfitAsset } from './avatarOutfit';
import type { CompanionDesign } from './CompanionDesign';
import { Icon } from './components';

const wardrobeCostumes = ['校服', '内衣完整', '裸露'];
const wardrobeLabels: Record<string, string> = { 校服: '黑制服', 内衣完整: '内衣', 裸露: '裸露' };

export const wardrobeLooks = characterOptions().flatMap(character => costumesOf(catalogFor(character.id))
  .filter(costume => wardrobeCostumes.includes(costume))
  .map(costume => ({ id: `${character.id}:${costume}`, character: character.id, costume,
    label: wardrobeLabels[costume] || costume,
    asset: outfitAsset('neutral', costume, catalogFor(character.id)) })));
export type WardrobeLook = typeof wardrobeLooks[number];

export function WelcomeAppearance({ mode, look, design, disabled, readyCharacters, onLook, onDesign, onCommit, onReset }: {
  mode: 'outfit' | 'placement'; look: WardrobeLook; design: CompanionDesign; disabled: boolean;
  readyCharacters: { id: string; ready: boolean }[];
  onLook: (look: WardrobeLook) => void; onDesign: (patch: Partial<CompanionDesign>) => void;
  onCommit: (patch?: Partial<CompanionDesign>) => void; onReset: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1);
  const catalog = catalogFor(look.character);
  const scale = width / design.frame_width;
  const expression = outfitAsset('neutral', look.costume, catalog);
  useLayoutEffect(() => {
    const node = viewport.current!;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node); setWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);
  return <div className="mg-appearance" data-mode={mode} data-look={look.id} data-x={design.portrait_x} data-y={design.portrait_y} data-size={design.portrait_size}>
    <div className="mg-appearance-top" aria-hidden="true"><i/><i/><i/><span>✦</span></div>
    <div ref={viewport} className="mg-appearance-viewport" style={{ aspectRatio: `${design.frame_width}/${design.frame_height}` } as CSSProperties}>
      <div className="mg-appearance-native" style={{ width: design.frame_width, height: design.frame_height, transform: `scale(${scale})` }}>
        <div className="mg-position-grid" aria-hidden="true"><i/><i/><span>↔</span></div>
        <CompanionPortrait design={design} expression={expression} motion={mode === 'outfit'} connected={true} editable={mode === 'placement' && !disabled}
          interactionScale={scale} character={look.character} aspect={characterAspect(catalog)} onChange={onDesign} onCommit={onCommit} onClick={() => onCommit()} onSceneChange={() => {}}/>
      </div>
    </div>
    {mode === 'outfit' ? <div className="mg-wardrobe" aria-label="选择服装">
      {wardrobeLooks.map(item => <button key={item.id} type="button" disabled={disabled} aria-label={`试穿${item.label}`} aria-pressed={look.id === item.id} onClick={() => onLook(item)}>
        <span className="mg-outfit-thumb"><img src={`ayana-asset://${item.asset}/?character=${item.character}`} alt="" draggable={false}/></span>
        <b>{item.label}{readyCharacters.find(character => character.id === item.character)?.ready === false ? ' · 预览' : ''}</b><Icon name={look.id === item.id ? 'check' : 'sparkles'} size={17}/>
      </button>)}
    </div> : <div className="mg-placement-actions"><button type="button" disabled={disabled} onClick={onReset}><Icon name="refresh" size={17}/>重置位置和大小</button></div>}
  </div>;
}
