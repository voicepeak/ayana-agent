import { useLayoutEffect, useRef, useState } from 'react';
import { CompanionSurface } from './CompanionSurface';
import { CompanionPortrait } from './CompanionPortrait';
import { CompanionWorkspace } from './CompanionWorkspace';
import { companionDesign, designStyle, designTone, DesignControls } from './CompanionDesign';
import { activeCatalog, characterAspect, costumesOf } from './avatarCatalogs';
import { captionLayout, type PortraitScene } from './captionLayout';
import { useImagePalette } from './imagePalette';
import { initialState, type ModelState, type Speech } from './state';
import { themes } from './companionThemes';
import { typed, type TourScene } from './welcomeTour';

const noop = () => {};
export const demoSource = { source_id: 'welcome-source', title: '雨后的味道', url: 'https://example.com/rain', conversation_id: 'welcome' };

export function welcomeDemoState(scene: TourScene, progress: number, settings: Record<string, unknown>): ModelState {
  const search = scene === 'search', observe = scene === 'observe', voice = scene === 'voice', style = scene === 'style';
  const prompt = search ? '为什么雨后，会有特别的味道？' : observe ? '彩名，看看当前屏幕。' : '今天路过的那家书店，还开着。';
  const sent = !voice && !style && progress >= (search ? .43 : observe ? .45 : .52);
  const replying = style || (!voice && !observe && sent && progress >= (search ? .57 : .62));
  const amount = style ? 1 : Math.max(0, Math.min(1, (progress - (search ? .57 : .62)) / .21));
  const speech: Speech = { id: 'welcome-response', order: 2,
    ja: style ? '今日の話、聞かせて。' : search ? '一緒に探そう。' : '少し、嬉しくなるね。',
    zh: style ? '今天的故事，讲给我听。' : search ? '一起找找。' : '这让人有一点开心呢。',
    en: style ? 'Tell me about your day.' : search ? 'Let’s look it up.' : 'That makes me a little happy.',
    generation: 1, state: amount >= 1 ? 'played' : 'playing', played: amount * 1000, total: 1000,
    intent: '', intensity: 0, affect: '', assetId: '', audioEnabled: true };
  return { ...initialState, connected: true, settingsLoaded: true, settings, generation: 1, attentionObserving: observe && progress >= .45,
    conversation: { conversation_id: 'welcome', title: sent ? prompt.slice(0, 24) : '新话题', preview: '', created: 0, updated: 0 },
    questions: sent ? [{ text: prompt, generation: 1, id: 'welcome-question', order: 1 }] : [],
    speeches: replying ? [speech] : [], current: replying ? speech.id : undefined, presented: replying ? speech.id : undefined,
    task: sent && !replying ? 'thinking' : 'idle',
    tools: sent && ((search && progress < .65) || observe)
      ? [{ protocol_version: 1, type: 'tool.started', generation_id: 1, call_id: 'welcome-tool', tool: search ? 'web.search' : 'desktop.observe' }]
      : [],
    sources: search && progress >= .65 ? [demoSource] : [],
  };
}

export function WelcomeDemo({ scene, progress, settings, expression, viewport, inspector }: {
  scene: TourScene; progress: number; settings: Record<string, unknown>; expression: string;
  viewport: { width: number; height: number }; inspector: { width: number; height: number; x: number; y: number };
}) {
  const container = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ width: 1, height: 1 });
  const [portraitScene, setPortraitScene] = useState<PortraitScene>();
  useLayoutEffect(() => {
    const node = container.current!;
    const measure = () => setArea({ width: node.clientWidth, height: node.clientHeight });
    const observer = new ResizeObserver(measure); observer.observe(node); measure();
    return () => observer.disconnect();
  }, []);
  const base = companionDesign(settings), changed = scene === 'style' && progress >= .54;
  const theme = themes.find(item => item.id === 'sea')!;
  const design = changed ? { ...base, theme: theme.id, background_mode: 'minimal' as const, background_color: theme.background, bubble_color: theme.bubble } : base;
  const state = welcomeDemoState(scene, progress, settings);
  const imageSample = useImagePalette(design.background_mode === 'image' && design.auto_palette, design.background_image, 0);
  const captionArea = portraitScene && captionLayout(portraitScene, design.font_size);
  const style = scene === 'style', voice = scene === 'voice';
  const text = voice ? typed('彩名，今天一起去散步吧。', progress, .80, .94)
    : scene === 'observe' ? (progress < .45 ? typed('彩名，看看当前屏幕。', progress, .15, .36) : '')
    : state.questions.length || style ? '' : typed(scene === 'search' ? '为什么雨后，会有特别的味道？' : '今天路过的那家书店，还开着。',
      progress, scene === 'search' ? .14 : .16, scene === 'search' ? .34 : .40);
  const talkStatus = voice ? progress >= .23 && progress < .72 ? 'recording' : progress >= .72 && progress < .8 ? 'transcribing' : 'idle' : 'idle';
  const minX = style ? Math.min(0, inspector.x) : 0, minY = style ? Math.min(0, inspector.y) : 0;
  const width = style ? Math.max(viewport.width, inspector.x + inspector.width) - minX : viewport.width;
  const height = style ? Math.max(viewport.height, inspector.y + inspector.height) - minY : viewport.height;
  const scale = Math.max(.01, Math.min(1, (area.width - 24) / width, (area.height - 24) / height));
  return <div ref={container} className="tour-demo" aria-hidden="true" data-kind={scene} data-playhead={progress.toFixed(4)}>
    <div className="tour-native-canvas" data-scale={scale} style={{ width, height, left: (area.width - width * scale) / 2, top: (area.height - height * scale) / 2, transform: `scale(${scale})` }}>
      <div className="tour-native-companion" style={{ left: -minX, top: -minY, width: viewport.width, height: viewport.height }}>
        <CompanionSurface state={state} design={design} style={designStyle(design, imageSample)} tone={designTone(design, imageSample)} passive designOpen={style && progress >= .18} speaking={!!state.presented}
          composer={{ text, onChange: noop, onSubmit: noop, onTalkPress: noop, onTalkRelease: noop, talkStatus }}>
          <CompanionPortrait design={design} expression={expression} motion={false} connected={true} editable={false}
            onChange={noop} onCommit={noop} onClick={noop} onSceneChange={setPortraitScene} aspect={characterAspect(activeCatalog(settings))}/>
          <CompanionWorkspace state={state} speech={state.speeches[0]} textOnly={false} show={design.show_subtitles}
            primaryLanguage={design.primary_language} translationLanguage={design.translation_language}
            layout={captionArea} onVisibilityChange={noop} passive/>
        </CompanionSurface>
      </div>
      {style && <div className="tour-native-inspector" data-shown={progress >= .18} style={{ left: inspector.x - minX, top: inspector.y - minY, width: inspector.width, height: inspector.height }}>
        <DesignControls value={design} onChange={noop} onPortraitEditing={noop} portraitEditing={false} onSave={noop} onClose={noop} onBackground={noop} onUndo={noop}
          costume={String(settings.avatar_costume || '校服')} costumes={costumesOf(activeCatalog(settings))} onCostume={noop} saving={false} dirty={changed} message="" previewTab={progress >= .36 ? 'frame' : 'portrait'}/>
      </div>}
    </div>
    {voice && <div className="tour-hotkey-guide" data-held={talkStatus === 'recording'}>
      {String(settings.talk_hotkey || 'Ctrl+Shift+Space').replace('CommandOrControl', 'Ctrl').replace('Control', 'Ctrl').split('+').map((key, i) => <kbd key={i}>{key}</kbd>)}
    </div>}
  </div>;
}
