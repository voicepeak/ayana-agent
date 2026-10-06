import { useEffect, useRef, useState } from 'react';
import { Button, Character, Icon, Input } from './components';
import { bridge, useRuntime, nextTextSpeech } from './state';
import { Settings, settingsSections, type SettingsSection } from './SettingsPanel';
import { TaskPanel } from './TaskPanel';
import { ConversationHistory } from './Conversations';
import { CompanionWorkspace } from './CompanionWorkspace';
import { dialogueReadTime } from './cinematic';
import desktopPackage from '../package.json';
import { companionDesign, useCompanionDesign, designStyle, designTone, DesignControls, type CompanionDesign } from './CompanionDesign';
import { savePreferences } from './preferences';
import { CompanionPortrait } from './CompanionPortrait';
import { captionLayout, type PortraitScene } from './captionLayout';
import { usePortraitEditing } from './portraitEditing';

const taskLabels: Record<string, string> = { idle: '空闲', observing: '正在观察目标', thinking: '正在整理思路', acting: '正在执行这一步', failed: '需要留意', speaking: 'Ayana 正在说话' };

export default function App() {
  const kind = new URLSearchParams(location.search).get('window') || 'chat';
  const { state, dispatch, player } = useRuntime(kind === 'chat');
  const [tab, setTab] = useState<'chat' | 'history' | 'tasks'>('chat');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('appearance');
  const [targetOpen, setTargetOpen] = useState(false);
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'teach' | 'execute'>('teach');
  const [selectedPoint, setSelectedPoint] = useState<{ x: number; y: number }>();
  const [actionKind, setActionKind] = useState('highlight');
  const [actionText, setActionText] = useState('');
  const [actionKey, setActionKey] = useState('enter');
  const [localError, setLocalError] = useState('');
  const [composerOpen, setComposerOpen] = useState(false);
  const [designOpen, setDesignOpen] = useState(false);
  const { portraitEditing, changePortraitEditing } = usePortraitEditing(kind, designOpen);
  const { draft: design, setDraft: setDesign, patch: designPatch } = useCompanionDesign(state.settings);
  const [designSaving, setDesignSaving] = useState(false);
  const [costumeSaving, setCostumeSaving] = useState(false);
  const [designMessage, setDesignMessage] = useState('');
  const [captionVisible, setCaptionVisible] = useState(false);
  const [backgroundRevision, setBackgroundRevision] = useState(0);
  const [portraitScene, setPortraitScene] = useState<PortraitScene>();
  const captionArea = portraitScene && captionLayout(portraitScene, design.font_size);
  const designDirty = Object.keys(designPatch).length > 0;
  const companion = useRef<HTMLElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const targetDialog = useRef<HTMLDialogElement>(null);
  const current = state.speeches.find(speech => speech.id === state.current);
  const captionsOccupyScene = design.show_subtitles && (captionVisible || state.questions.length > 0
    || state.history.some(record => record.role === 'user' || record.displayed === true || ['played', 'partial'].includes(String(record.status))));

  function openComposer() { setComposerOpen(true); textarea.current?.focus({ preventScroll: true }); }
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
      if (designOpen) { void bridge.closeDesign(); textarea.current?.focus({ preventScroll: true }); }
      else if (composerOpen) {
        setComposerOpen(false);
        companion.current?.querySelector<HTMLButtonElement>('.portrait-stage')?.focus({ preventScroll: true });
      } else void bridge.hide();
    };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  }, [kind, composerOpen, designOpen]);

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
      if (event.type === 'desktop.hidden') { pendingFocus = false; setComposerOpen(false); setDesignOpen(false); }
      if (event.type === 'desktop.new-topic') { setComposerOpen(true); void send({ type: 'conversation.create', keep_materials: false }); }
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
  useEffect(() => { setText(''); }, [state.conversation?.conversation_id]);
  useEffect(() => { player.current?.setVolume(Number(state.settings.volume ?? 1)); }, [state.settings.volume, player]);
  useEffect(() => { setMode(state.mode); }, [state.mode]);
  useEffect(() => { if (targetOpen) targetDialog.current?.showModal(); else targetDialog.current?.close(); }, [targetOpen]);
  useEffect(() => { setSelectedPoint(undefined); }, [state.snapshot?.snapshot_id]);
  useEffect(() => bridge.onEvent(event => {
    if (event.type === 'desktop.navigate' && event.tab === 'tasks') { setTab('tasks'); void send({ type: 'capabilities.get' }); }
    if (event.type === 'desktop.navigate' && event.tab === 'history') { setTab('history'); void send({ type: 'history.get' }); void send({ type: 'conversations.get' }); }
    if (event.type === 'desktop.navigate' && event.tab === 'settings') { setTab('chat'); setSettingsSection('appearance'); }
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
    if (await send({ type: 'turn.start', text: question.trim(), repository_root: state.repository?.root || undefined, mode })) {
      setText(''); setTab('chat'); setComposerOpen(false);
    }
  }
  async function setTaskMode(next: 'teach' | 'execute') {
    const previous = mode;
    setMode(next);
    if (!await send({ type: 'mode.set', mode: next })) setMode(previous);
  }
  async function executeManual() {
    if (!state.snapshot?.snapshot_id) return;
    const action: Record<string, unknown> = { kind: actionKind, point: selectedPoint, generation_id: state.generation, expected_result: `用户确认的${actionKind}单步操作` };
    if (actionKind === 'type') action.text = actionText;
    if (actionKind === 'key') action.key = actionKey;
    if (actionKind === 'scroll') action.delta = -3;
    if (actionKind === 'highlight' && selectedPoint) action.rect = { x: Math.max(0, selectedPoint.x - 45), y: Math.max(0, selectedPoint.y - 20), width: 90, height: 40 };
    await send({ type: 'tool.execute', snapshot_id: state.snapshot.snapshot_id, action });
  }

  const presented = state.speeches.find(speech => speech.id === state.presented);
  const textOnly = (state.settings.voice as Record<string, unknown> | undefined)?.voice_mode === 'silent' || state.voice === 'failed';
  const nextText = nextTextSpeech(state, textOnly);
  useEffect(() => {
    if (kind !== 'chat' || !nextText) return;
    const timer = setTimeout(() => {
      dispatch({ protocol_version: 1, type: 'desktop.present', utterance_id: nextText.id, generation_id: nextText.generation });
      void bridge.send({ type: 'utterance.displayed', utterance_id: nextText.id, generation_id: nextText.generation });
    }, !presented ? 0 : dialogueReadTime(presented.zh || presented.ja));
    return () => clearTimeout(timer);
  }, [kind, nextText?.id, nextText?.generation, state.presented, state.generation, dispatch]);

  if (kind === 'highlight') return state.targetCue?.variant === 'summon'
    ? <div key={String(state.targetCue.cue_id)} className="target-aura" aria-label="Ayana 正在观察这个窗口"><i/><b/><em/><span/></div>
    : <div className="highlight-frame"><span>Ayana · 看这里</span></div>;
  if (kind === 'design') return <DesignControls backgroundRevision={backgroundRevision} value={design} onChange={changeDesign} portraitEditing={portraitEditing} onPortraitEditing={changePortraitEditing} onSave={() => void saveDesign()} onClose={() => void bridge.closeDesign()} onBackground={() => void chooseBackground()} onUndo={() => changeDesign(companionDesign(state.settings))} costume={String(state.settings.avatar_costume || '校服')} onCostume={value => void changeCostume(value)} saving={designSaving || costumeSaving} dirty={designDirty} message={designMessage}/>;
  if (kind === 'chat') return <main ref={companion} className="companion-shell companion-framed" data-design-open={designOpen} data-portrait-editing={portraitEditing} style={designStyle(design)} onContextMenu={event => { event.preventDefault(); void bridge.openCompanionMenu(); }}>
    <section className="companion-frame companion-note is-visible" data-theme={design.theme} data-tone={designTone(design)} data-bubbles={design.show_bubbles} data-background={design.background_mode} data-portrait-side={design.portrait_side} data-speaking={captionVisible} aria-label="彩名便签" data-companion-interactive>
    {['minimal', 'solid'].includes(design.background_mode) && <div className="note-surface" aria-hidden="true"/>}
    {design.background_mode === 'image' && <div className="note-background-image" aria-hidden="true"><img alt="" src={`ayana-background://custom/?image=${design.background_image}&v=${backgroundRevision}`} style={{ objectPosition: `${design.background_x}% ${design.background_y}%`, transform: `scale(${design.background_zoom / 100})`, transformOrigin: `${design.background_x}% ${design.background_y}%` }}/></div>}
    <header className="companion-frame-heading" title="拖动标题栏移动窗口"><div className="companion-heading-start"><div className="companion-signature"><strong>彩名</strong></div><button className="companion-appearance-button" type="button" aria-label="打开设计控件" aria-expanded={designOpen} title="调整外观" onClick={() => { if (designOpen) void bridge.closeDesign(); else void bridge.openDesign(); }}><Icon name="settings" size={14}/></button></div><span className="companion-title-drag-area" aria-hidden="true"/><div className="companion-frame-actions">
      <button type="button" aria-label="输入回复" title="输入回复" onMouseDown={event => event.preventDefault()} onClick={openComposer}><Icon name="message" size={15}/></button>
      <button type="button" aria-label="更多操作" title="话题、任务与设置" onClick={() => void bridge.openCompanionMenu()}>···</button>
      <button type="button" aria-label="隐藏彩名" title="隐藏彩名" onClick={() => void bridge.hide()}><Icon name="close" size={14}/></button>
    </div></header>
    <CompanionPortrait design={design} expression={state.expression} motion={state.settings.sentence_motion !== false}
      connected={state.connected} editable={portraitEditing} onChange={changeDesign} onClick={openComposer}
      onSceneChange={setPortraitScene} bottomInset={captionsOccupyScene ? captionArea?.portraitBottomInset : 0}
      onCommit={changeDesign}/>
    <CompanionWorkspace state={state} speech={presented} textOnly={textOnly} show={design.show_subtitles} primaryLanguage={design.primary_language} translationLanguage={design.translation_language} onVisibilityChange={setCaptionVisible} layout={captionArea}/>
    <form className="floating-input" data-companion-interactive onSubmit={event => { event.preventDefault(); void ask(); }} onBlur={event => {
      if (!companion.current?.contains(event.relatedTarget as Node | null)) setComposerOpen(false);
    }}>
      <textarea ref={textarea} value={text} maxLength={4000} rows={1} onFocus={() => setComposerOpen(true)} onChange={event => setText(event.target.value)} placeholder="写下一句话…" aria-label="输入问题" onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(); } }}/>
      <button type="submit" aria-label="发送" title="发送 · Enter" disabled={!text.trim() || !state.connected}><Icon name="arrow" size={19}/></button>
    </form>
    </section>
    {(localError || state.error) && <div className="companion-error" role="alert" data-companion-interactive>{localError || state.error}<button aria-label="关闭错误提示" onClick={() => { setLocalError(''); dispatch({ protocol_version: 1, type: 'desktop.dismiss-error' }); }}><Icon name="close" size={14}/></button></div>}
    {state.approvals.length > 0 && <button className="companion-approval" data-companion-interactive onClick={() => void bridge.openSettings('tasks')}>有一步需要你确认 <Icon name="arrow" size={14}/></button>}
  </main>;

  const targetName = state.target?.title || '还未选择窗口';
  const statusText = current ? 'Ayana 正在说话' : taskLabels[state.task] || state.task;

  return <div className="workshop workshop-focused">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Icon name="sparkles" size={25}/></div><div><strong>Ayana</strong><span>你的桌面同伴</span></div></div>
      <div className={`connection ${state.connected ? 'online' : ''}`}><i/>{state.connected ? '本地服务已连接' : state.service === 'preview' ? '桌面界面预览' : '本地服务启动中'}</div>
      <nav aria-label="主导航">
        <span className="nav-group-label">偏好设置</span>
        {settingsSections.filter(item => item.id !== 'advanced').map(item => <button key={item.id} className={`nav-item ${tab === 'chat' && settingsSection === item.id ? 'active' : ''}`} aria-current={tab === 'chat' && settingsSection === item.id ? 'page' : undefined} onClick={() => { setSettingsSection(item.id); setTab('chat'); if (item.id === 'access') void send({ type: 'capabilities.get' }); }}><Icon name={item.icon}/>{item.title}</button>)}
        <span className="nav-group-label">管理</span>
        {([['tasks', 'file', '任务与结果'], ['history', 'history', '对话记录']] as const).map(([id, icon, label]) => <button key={id} className={`nav-item ${tab === id ? 'active' : ''}`} aria-current={tab === id ? 'page' : undefined} onClick={() => { setTab(id); if (id === 'history') { void send({ type: 'history.get' }); void send({ type: 'conversations.get' }); } else void send({ type: 'capabilities.get' }); }}><Icon name={icon}/>{label}</button>)}
      </nav>
      <div className="sidebar-bottom">
        <button className={`nav-item ${tab === 'chat' && settingsSection === 'advanced' ? 'active' : ''}`} aria-current={tab === 'chat' && settingsSection === 'advanced' ? 'page' : undefined} onClick={() => { setSettingsSection('advanced'); setTab('chat'); }}><Icon name="settings"/>高级设置</button>
        <button className="nav-item" onClick={() => void bridge.summon()}><Icon name="message"/>呼出 Ayana</button>
        <div className="build-label">AYANA DESKTOP <span>v{desktopPackage.version}</span></div>
      </div>
    </aside>

    <main className="main-panel">
      <header className="main-header"><h1>{tab === 'chat' ? settingsSections.find(item => item.id === settingsSection)?.title : tab === 'tasks' ? '任务与结果' : '对话记录'}</h1><Button variant="light" aria-label="关闭设置" onClick={() => void bridge.hideSettings()}><Icon name="close" size={18}/></Button></header>
      {(localError || state.error) && <div className="error-banner" role="alert"><span>{localError || state.error}</span><button aria-label="关闭错误提示" onClick={() => { setLocalError(''); dispatch({ protocol_version: 1, type: 'desktop.dismiss-error' }); }}>×</button></div>}
      <div className="settings-host" hidden={tab !== 'chat'}><Settings state={state} section={settingsSection}/></div>
      {tab === 'tasks' && <>
        {state.actions.map(event => { const action = event.action as Record<string, unknown>; return <div className="proposed-action" key={String(action.action_id)}><p>{String(event.label || action.expected_result)}</p><Button color="primary" disabled={mode !== 'execute' && state.settings.full_access !== true && action.kind !== 'highlight'} onClick={() => void send({ type: 'tool.execute', action_id: action.action_id, snapshot_id: action.snapshot_id })}>确认并执行一步</Button></div>; })}
        <TaskPanel state={state} send={send} controls={<>{state.settings.full_access !== true && <div className="mode-strip"><div className="segmented"><button className={mode === 'teach' ? 'selected' : ''} disabled={!state.connected} onClick={() => void setTaskMode('teach')}>对话与观察</button><button className={mode === 'execute' ? 'selected' : ''} disabled={!state.connected} onClick={() => void setTaskMode('execute')}>执行任务</button></div></div>}<div className="target-card"><div className="target-title"><span className="window-icon"><Icon name="monitor" size={17}/></span><div><small>当前目标窗口</small><strong title={targetName}>{targetName}</strong></div></div><div className="target-actions"><Button variant="light" onClick={() => { void send({ type: 'windows.list' }); setTargetOpen(true); }}>选择窗口</Button><Button variant="light" onClick={() => void send({ type: 'target.capture' })} disabled={!state.target}><Icon name="refresh" size={14}/>刷新</Button></div>
        {state.snapshot?.png_base64 ? <div className="snapshot-wrap"><img className="snapshot" src={`data:image/png;base64,${String(state.snapshot.png_base64)}`} alt="所绑定目标窗口的当前截图" onClick={event => {
          const rect = event.currentTarget.getBoundingClientRect();
          const x = Math.floor((event.clientX - rect.left) / rect.width * event.currentTarget.naturalWidth);
          const y = Math.floor((event.clientY - rect.top) / rect.height * event.currentTarget.naturalHeight);
          setSelectedPoint({ x, y });
        }}/><small>点击截图选择操作位置</small></div> : null}
      </div>
      {selectedPoint && <div className="step-card"><div className="step-heading"><span>选择的位置</span><code>{selectedPoint.x}, {selectedPoint.y}</code></div><select value={actionKind} onChange={event => setActionKind(event.target.value)} aria-label="单步操作类型"><option value="highlight">高亮这里</option><option value="click">点击这里</option><option value="type">在这里输入</option><option value="scroll">向下滚动 3 格</option><option value="key">发送一个按键</option></select>{actionKind === 'type' && <Input value={actionText} onChange={event => setActionText(event.target.value)} placeholder="要输入到目标窗口的文字"/>}{actionKind === 'key' && <select value={actionKey} onChange={event => setActionKey(event.target.value)} aria-label="发送的按键">{['enter', 'tab', 'escape', 'backspace', 'left', 'up', 'right', 'down', 'home', 'end', 'pageup', 'pagedown'].map(key => <option value={key} key={key}>{key}</option>)}</select>}{actionKind !== 'highlight' && <small>此操作会改变目标窗口。</small>}<Button color="primary" variant="solid" disabled={(mode !== 'execute' && state.settings.full_access !== true && actionKind !== 'highlight') || (actionKind === 'type' && !actionText)} onClick={() => void executeManual()}>{actionKind === 'highlight' ? '显示高亮' : '确认并执行一步'}</Button></div>}

      </>}/>
      </>}
      {tab === 'history' && <ConversationHistory state={state} send={send}/>}
      <footer className="main-status"><span><i className={current ? 'pulsing' : ''}/>{statusText}</span>{tab === 'tasks' && state.target && <span>{state.target.title}</span>}</footer>
    </main>

    <dialog ref={targetDialog} className="kun-dialog" onCancel={() => setTargetOpen(false)}><div className="dialog-heading"><h2>选择窗口</h2><Button variant="light" aria-label="关闭窗口选择" onClick={() => setTargetOpen(false)}><Icon name="close"/></Button></div><p className="dialog-note">绑定后会获取新截图；新目标会停止之前的语音与操作。</p><div className="windows-list">{state.windows.map(window => <button key={window.hwnd} onClick={() => { void send({ type: 'target.bind', hwnd: window.hwnd }); setTargetOpen(false); }}><Icon name="monitor"/><div><strong>{window.title || '未命名窗口'}</strong><small>进程 {window.process_id} · HWND {window.hwnd}</small></div><Icon name="arrow"/></button>)}</div><Button onClick={() => void send({ type: 'windows.list' })}><Icon name="refresh" size={15}/>刷新窗口列表</Button></dialog>

  </div>;
}
