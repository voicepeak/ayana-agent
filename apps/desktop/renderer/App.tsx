import { useEffect, useRef, useState } from 'react';
import { Button, Icon } from './components';
import { bridge, useRuntime, nextTextSpeech } from './state';
import { Settings, settingsSections, type SettingsSection } from './SettingsPanel';
import { ConversationManager } from './ConversationManager';
import { CompanionSurface } from './CompanionSurface';
import { CompanionWorkspace } from './CompanionWorkspace';
import { dialogueReadTime } from './cinematic';
import desktopPackage from '../package.json';
import { companionDesign, useCompanionDesign, designStyle, designTone, DesignControls, type CompanionDesign } from './CompanionDesign';
import { useImagePalette } from './imagePalette';
import { savePreferences } from './preferences';
import { CompanionPortrait } from './CompanionPortrait';
import { VoicePackBubble } from './VoicePack';
import { captionLayout, type PortraitScene } from './captionLayout';
import { usePortraitEditing } from './portraitEditing';
import { activeCatalog, characterAspect, costumesOf } from './avatarCatalogs';
import { useHoldToTalk } from './useHoldToTalk';

export default function App() {
  const kind = new URLSearchParams(location.search).get('window') || 'chat';
  const { state, dispatch, player } = useRuntime(kind === 'chat');
  const [tab, setTab] = useState<'chat' | 'history'>('chat');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('appearance');
  const [text, setText] = useState('');
  const [localError, setLocalError] = useState('');
  const [composerOpen, setComposerOpen] = useState(false);
  const [conversationsOpen, setConversationsOpen] = useState(false);
  const [designOpen, setDesignOpen] = useState(false);
  const { portraitEditing, changePortraitEditing } = usePortraitEditing(kind, designOpen);
  const { draft: design, setDraft: setDesign, patch: designPatch } = useCompanionDesign(state.settings);
  const [designSaving, setDesignSaving] = useState(false);
  const [costumeSaving, setCostumeSaving] = useState(false);
  const [designMessage, setDesignMessage] = useState('');
  const [captionVisible, setCaptionVisible] = useState(false);
  const [backgroundRevision, setBackgroundRevision] = useState(0);
  const imageSample = useImagePalette(kind === 'chat' && design.background_mode === 'image' && design.auto_palette, design.background_image, backgroundRevision);
  const [portraitScene, setPortraitScene] = useState<PortraitScene>();
  const captionArea = portraitScene && captionLayout(portraitScene, design.font_size);
  const designDirty = Object.keys(designPatch).length > 0;
  const companion = useRef<HTMLElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const conversationDrafts = useRef(new Map<string, string>());
  const talk = useHoldToTalk(kind === 'chat', state.conversation?.conversation_id, transcript => {
    changeText((text.trim() ? `${text.trim()} ` : '') + transcript);
    setComposerOpen(true);
    requestAnimationFrame(() => textarea.current?.focus({ preventScroll: true }));
  });
  const current = state.speeches.find(speech => speech.id === state.current);
  const captionsOccupyScene = design.show_subtitles && (captionVisible || state.questions.length > 0
    || state.history.some(record => record.role === 'user' || record.displayed === true || ['played', 'partial'].includes(String(record.status))));

  function openComposer() { setComposerOpen(true); textarea.current?.focus({ preventScroll: true }); }
  function changeText(value: string) {
    conversationDrafts.current.set(state.conversation?.conversation_id || 'initial', value);
    setText(value);
  }
  function changeDesign(patch: Partial<CompanionDesign>) {
    setDesign(value => ({ ...value, ...patch })); setDesignMessage('');
    if (kind === 'design' || kind === 'chat') bridge.previewDesign(patch);
  }
  async function changeCostume(costume: string) {
    setCostumeSaving(true); setDesignMessage('');
    try { await savePreferences({ avatar_costume: costume }); setDesignMessage('服装已更换'); }
    catch (error) { setDesignMessage(error instanceof Error ? error.message : '换装未完成，请重试。'); }
    finally { setCostumeSaving(false); }
  }
  useEffect(() => {
    if (kind !== 'chat' && kind !== 'design') return;
    const off = bridge.onEvent(event => {
      if (event.type === 'desktop.design-preview') setDesign(event.value as CompanionDesign);
      if (event.type === 'desktop.design-visibility') setDesignOpen(event.open === true);
      if (event.type === 'desktop.background-changed') setBackgroundRevision(Number(event.revision));
    });
    let active = true;
    void bridge.getState().then(snapshot => {
      if (!active) return;
      const initialDesign = kind === 'design' ? snapshot.designDraft || snapshot.designPreview : snapshot.designPreview;
      if (initialDesign) setDesign(initialDesign as unknown as CompanionDesign);
      setDesignOpen(snapshot.designOpen === true);
    });
    return () => { active = false; off(); };
  }, [kind]);
  async function saveDesign() {
    if (designSaving || !designDirty) return;
    setDesignSaving(true); setDesignMessage('');
    try { await savePreferences({ companion_ui: designPatch }); setDesignMessage('设计已保存'); }
    catch (error) {
      await bridge.revertDesignPreview();
      setDesignMessage(`${error instanceof Error ? error.message : '未保存，请重试'} 预览已撤销，修改已保留，可重新保存。`);
    }
    finally { setDesignSaving(false); }
  }
  async function chooseBackground() {
    try {
      const result = await bridge.chooseNoteBackground();
      if (result.ok && result.imageId) { setBackgroundRevision(Date.now()); changeDesign({ theme: 'custom', background_mode: 'image', background_image: result.imageId, background_x: 50, background_y: 50, background_zoom: 100 }); }
      else if (result.error) setDesignMessage(result.error);
    } catch (error) { setDesignMessage(error instanceof Error ? error.message : '背景图片未保存，请重试。'); }
  }
  useEffect(() => {
    if (!composerOpen) return;
    const frame = requestAnimationFrame(() => textarea.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [composerOpen]);
  useEffect(() => {
    if (!composerOpen) return;
    const node = textarea.current;
    if (node) { node.style.height = '24px'; node.style.height = `${Math.min(48, Math.max(24, node.scrollHeight))}px`; }
  }, [composerOpen, text]);
  useEffect(() => {
    if (kind !== 'chat') return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      if (conversationsOpen) setConversationsOpen(false);
      else if (designOpen) { void bridge.closeDesign(); textarea.current?.focus({ preventScroll: true }); }
      else if (composerOpen) {
        setComposerOpen(false);
        companion.current?.querySelector<HTMLButtonElement>('.portrait-stage')?.focus({ preventScroll: true });
      } else void bridge.hide();
    };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  }, [kind, composerOpen, designOpen, conversationsOpen]);

  useEffect(() => {
    if (kind !== 'chat') return;
    let pendingFocus = false;
    const focusInput = () => {
      setComposerOpen(true);
      textarea.current?.focus({ preventScroll: true });
      pendingFocus = !document.hasFocus();
    };
    const onWindowFocus = () => { if (pendingFocus) focusInput(); };
    const off = bridge.onEvent(event => {
      if (event.type === 'desktop.focus-input') focusInput();
      if (event.type === 'desktop.hidden') { pendingFocus = false; setComposerOpen(false); setDesignOpen(false); setConversationsOpen(false); }
      if (event.type === 'desktop.new-topic') { setComposerOpen(true); void send({ type: 'conversation.create' }); }
    });
    window.addEventListener('focus', onWindowFocus);
    // A startup summon can finish before this renderer subscribes to events.
    void bridge.getState().then(snapshot => { if (snapshot.composerRequested) focusInput(); });
    return () => { off(); window.removeEventListener('focus', onWindowFocus); };
  }, [kind]);

  useEffect(() => {
    if (kind !== 'chat' || !state.summonVersion || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // Separate from Character's sentence dip, so the two transforms never fight.
    const portrait = companion.current?.querySelector<HTMLElement>('.portrait-reveal')?.animate([
      { transform: 'translateY(26px) scale(.98)' },
      { transform: 'translateY(0) scale(1)' },
    ], { duration: 480, easing: 'cubic-bezier(.16,1,.3,1)' });
    return () => { portrait?.cancel(); };
  }, [kind, state.summonVersion]);

  useEffect(() => {
    document.documentElement.classList.toggle('overlay-root', kind !== 'settings');
    document.body.classList.toggle('overlay-body', kind !== 'settings');
  }, [kind]);
  useEffect(() => {
    const cid = state.conversation?.conversation_id;
    if (!cid) return;
    if (conversationDrafts.current.has('initial')) {
      conversationDrafts.current.set(cid, conversationDrafts.current.get('initial') || '');
      conversationDrafts.current.delete('initial');
    }
    setText(conversationDrafts.current.get(cid) || '');
  }, [state.conversation?.conversation_id]);
  useEffect(() => { player.current?.setVolume(Number(state.settings.volume ?? 1)); }, [state.settings.volume, player]);
  useEffect(() => bridge.onEvent(event => {
    if (event.type === 'conversation.deleted') conversationDrafts.current.delete(String(event.deleted_id));
    if (event.type === 'desktop.navigate' && event.tab === 'history') { setTab('history'); void send({ type: 'history.get' }); void send({ type: 'conversations.get' }); }
    if (event.type === 'desktop.navigate' && event.tab === 'settings') { setTab('chat'); setSettingsSection('appearance'); }
    if (event.type === 'desktop.navigate' && event.tab === 'model') { setTab('chat'); setSettingsSection('model'); }
  }), []);

  async function send(command: Record<string, unknown> & { type: string }) {
    const result = await bridge.send(command);
    if (!result.ok) setLocalError(result.error || '操作未完成。');
    else setLocalError('');
    return result.ok;
  }
  async function ask(question = text) {
    if (!question.trim()) { textarea.current?.focus(); return; }
    player.current?.cancel(state.generation);
    dispatch({ protocol_version: 1, type: 'desktop.cancelled', cancelled_generation_id: state.generation });
    await player.current?.unlock();
    if (await send({ type: 'turn.start', text: question.trim() })) {
      changeText(''); setTab('chat'); setComposerOpen(false);
    }
  }

  const presented = state.speeches.find(speech => speech.id === state.presented);
  const catalog = activeCatalog(state.settings);
  const voiceSettings = state.settings.voice as Record<string, unknown> | undefined;
  const textOnly = voiceSettings?.voice_mode === 'silent'
    || (voiceSettings?.voice_mode === 'sovits' && voiceSettings?.restart_pending === true)
    || state.voice === 'failed';
  const nextText = nextTextSpeech(state, textOnly);
  useEffect(() => {
    if (kind !== 'chat' || !nextText) return;
    const timer = setTimeout(() => {
      dispatch({ protocol_version: 1, type: 'desktop.present', utterance_id: nextText.id, generation_id: nextText.generation });
      void bridge.send({ type: 'utterance.displayed', utterance_id: nextText.id, generation_id: nextText.generation });
    }, !presented ? 0 : dialogueReadTime(presented.zh || presented.ja));
    return () => clearTimeout(timer);
  }, [kind, nextText?.id, nextText?.generation, state.presented, state.generation, dispatch]);

  if (kind === 'design') return <DesignControls backgroundRevision={backgroundRevision} value={design} onChange={changeDesign} portraitEditing={portraitEditing} onPortraitEditing={changePortraitEditing} onSave={() => void saveDesign()} onClose={() => void bridge.closeDesign()} onBackground={() => void chooseBackground()} onUndo={() => changeDesign(companionDesign(state.settings))} costume={String(state.settings.avatar_costume || '校服')} costumes={costumesOf(catalog)} onCostume={value => void changeCostume(value)} saving={designSaving || costumeSaving} dirty={designDirty} message={designMessage}/>;
  if (kind === 'chat') return <CompanionSurface state={state} design={design} style={designStyle(design, imageSample)} tone={designTone(design, imageSample)} backgroundRevision={backgroundRevision}
    surfaceRef={companion} designOpen={designOpen} portraitEditing={portraitEditing} speaking={captionVisible} conversationsOpen={conversationsOpen}
    onConversations={setConversationsOpen} onComposer={openComposer} onDesign={() => { if (designOpen) void bridge.closeDesign(); else void bridge.openDesign(); }}
    onMenu={() => void bridge.openCompanionMenu()} onHide={() => void bridge.hide()}
    composer={{ text, textarea, onChange: changeText, onSubmit: () => void ask(), onFocus: () => setComposerOpen(true),
      onBlur: event => { if (!companion.current?.contains(event.relatedTarget as Node | null)) setComposerOpen(false); },
      talkStatus: talk.status, onTalkPress: () => void talk.press(), onTalkRelease: talk.release }}
    extras={(localError || talk.error || state.error) && <div className="companion-error" role="alert" data-companion-interactive>{localError || talk.error || state.error}<button aria-label="关闭错误提示" onClick={() => { setLocalError(''); talk.dismissError(); dispatch({ protocol_version: 1, type: 'desktop.dismiss-error' }); }}><Icon name="close" size={14}/></button></div>}>
    <CompanionPortrait design={design} expression={state.expression} motion={state.settings.sentence_motion !== false}
      connected={state.connected} editable={portraitEditing} onChange={changeDesign} onClick={openComposer}
      onSceneChange={setPortraitScene} bottomInset={captionsOccupyScene ? captionArea?.portraitBottomInset : 0}
      aspect={characterAspect(catalog)} onCommit={changeDesign}/>
    <CompanionWorkspace state={state} speech={presented} textOnly={textOnly} show={design.show_subtitles} primaryLanguage={design.primary_language} translationLanguage={design.translation_language} onVisibilityChange={setCaptionVisible} layout={captionArea}/>
    <VoicePackBubble state={state}/>
  </CompanionSurface>;

  const statusText = current ? 'Ayana 正在说话' : state.task === 'thinking' ? '正在整理思路' : state.task === 'failed' ? '需要留意' : '空闲';

  return <div className="workshop workshop-focused settings-shell" data-settings-section={tab === 'history' ? 'history' : settingsSection}>
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Icon name="sparkles" size={25}/></div><div><strong>Ayana</strong></div></div>
      <div className={`connection ${state.connected ? 'online' : ''}`}><i/>{state.connected ? '本地服务已连接' : state.service === 'preview' ? '桌面界面预览' : '本地服务启动中'}</div>
      <nav aria-label="主导航">
        <span className="nav-group-label">偏好设置</span>
        {settingsSections.filter(item => item.id !== 'advanced').map(item => <button key={item.id} className={`nav-item ${tab === 'chat' && settingsSection === item.id ? 'active' : ''}`} aria-current={tab === 'chat' && settingsSection === item.id ? 'page' : undefined} onClick={() => { setSettingsSection(item.id); setTab('chat'); if (item.id === 'access') void send({ type: 'capabilities.get' }); }}><Icon name={item.icon}/>{item.title}</button>)}
        <span className="nav-group-label">管理</span>
        <button className={`nav-item ${tab === 'history' ? 'active' : ''}`} aria-current={tab === 'history' ? 'page' : undefined} onClick={() => { setTab('history'); void send({ type: 'history.get' }); void send({ type: 'conversations.get' }); }}><Icon name="history"/>对话与记忆</button>
      </nav>
      <div className="sidebar-bottom">
        <button className={`nav-item ${tab === 'chat' && settingsSection === 'advanced' ? 'active' : ''}`} aria-current={tab === 'chat' && settingsSection === 'advanced' ? 'page' : undefined} onClick={() => { setSettingsSection('advanced'); setTab('chat'); }}><Icon name="settings"/>高级设置</button>
        <button className="nav-item" onClick={() => void bridge.summon()}><Icon name="message"/>呼出 Ayana</button>
        <div className="build-label">AYANA DESKTOP <span>v{desktopPackage.version}</span></div>
      </div>
    </aside>

    <main className="main-panel">
      <header className="main-header"><div className="settings-page-title"><span className="settings-heading-icon"><Icon name={tab === 'chat' ? settingsSections.find(item => item.id === settingsSection)?.icon || 'settings' : 'history'} size={25}/></span><h1>{tab === 'chat' ? settingsSections.find(item => item.id === settingsSection)?.title : '对话与记忆'}</h1></div><Button variant="light" aria-label="关闭设置" onClick={() => void bridge.hideSettings()}><Icon name="close" size={18}/></Button></header>
      {(localError || state.error) && <div className="error-banner" role="alert"><span>{localError || state.error}</span><button aria-label="关闭错误提示" onClick={() => { setLocalError(''); dispatch({ protocol_version: 1, type: 'desktop.dismiss-error' }); }}>×</button></div>}
      <div className="settings-host" hidden={tab !== 'chat'}><Settings state={state} section={settingsSection}/></div>
      {tab === 'history' && <ConversationManager state={state} send={send}/>}
      <footer className="main-status"><span><i className={current ? 'pulsing' : ''}/>{statusText}</span></footer>
    </main>

  </div>;
}
