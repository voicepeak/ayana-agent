import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Character, Icon, Input } from './components';
import { bridge, useRuntime, type ModelState, type Speech } from './state';
import avatarCatalog from '../../../characters/ayana/avatar-map.json';
import { TaskPanel, taskLabels as agentTaskLabels } from './TaskPanel';
import { ConversationControls, ConversationHistory } from './Conversations';

const taskLabels: Record<string, string> = { idle: '可以开始啦', observing: '正在观察目标', thinking: '正在整理思路', acting: '正在执行这一步', failed: '需要留意', speaking: 'Ayana 正在说话' };
const reception: Record<string, string> = { generated: '文字已生成', playing: '正在播放', played: '已播放', partial: '已打断', cancelled: '未播放' };

export default function App() {
  const kind = new URLSearchParams(location.search).get('window') || 'chat';
  const { state, dispatch, player } = useRuntime(kind === 'chat');
  const [tab, setTab] = useState<'chat' | 'files' | 'history' | 'tasks'>('chat');
  const [targetOpen, setTargetOpen] = useState(false);
  const [text, setText] = useState('');
  const [root, setRoot] = useState('');
  const [mode, setMode] = useState<'teach' | 'execute'>('teach');
  const [selectedPoint, setSelectedPoint] = useState<{ x: number; y: number }>();
  const [actionKind, setActionKind] = useState('highlight');
  const [actionText, setActionText] = useState('');
  const [actionKey, setActionKey] = useState('enter');
  const [fileFilter, setFileFilter] = useState('');
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<Record<string, unknown>[]>([]);
  const [localError, setLocalError] = useState('');
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [recording, setRecording] = useState(false);
  const [speechReview, setSpeechReview] = useState(false);
  const [workspaceHint, setWorkspaceHint] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const microphone = useRef<MediaStream | null>(null);
  const recordRequested = useRef(false);
  const discardRecording = useRef(false);
  const recordingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const portraitReveal = useRef<HTMLDivElement>(null);
  const dialogue = useRef<HTMLElement>(null);
  const targetDialog = useRef<HTMLDialogElement>(null);
  const current = state.speeches.find(speech => speech.id === state.current);
  const busy = state.task === 'thinking' || state.task === 'observing' || state.inputState === 'transcribing' || Boolean(current);

  useEffect(() => {
    if (kind !== 'chat') return;
    let pendingFocus = false;
    const focusInput = () => {
      textarea.current?.focus({ preventScroll: true });
      pendingFocus = !document.hasFocus();
    };
    const onWindowFocus = () => { if (pendingFocus) focusInput(); };
    const off = bridge.onEvent(event => {
      if (event.type === 'desktop.focus-input') focusInput();
      if (event.type === 'desktop.hidden') pendingFocus = false;
    });
    window.addEventListener('focus', onWindowFocus);
    // A startup summon can finish before this renderer subscribes to events.
    if (document.hasFocus()) focusInput();
    return () => { off(); window.removeEventListener('focus', onWindowFocus); };
  }, [kind]);

  useEffect(() => {
    if (kind !== 'chat' || !state.summonVersion || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // Separate from Character's sentence dip, so the two transforms never fight.
    const portrait = portraitReveal.current?.animate([
      { transform: 'translateY(26px) scale(.98)' },
      { transform: 'translateY(0) scale(1)' },
    ], { duration: 480, easing: 'cubic-bezier(.16,1,.3,1)' });
    const box = dialogue.current?.animate([
      { opacity: 0, transform: 'translateY(14px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: 360, delay: 100, fill: 'backwards', easing: 'cubic-bezier(.16,1,.3,1)' });
    return () => { portrait?.cancel(); box?.cancel(); };
  }, [kind, state.summonVersion]);

  useEffect(() => {
    if (kind !== 'chat' || !state.workspaceHintAt) return;
    const parts = [state.target?.title, state.repository?.name].filter(Boolean);
    setWorkspaceHint(parts.length ? `当前工作区 · ${parts.join(' · ')}` : '还没有选择窗口或仓库');
    const timer = setTimeout(() => setWorkspaceHint(''), 1600);
    return () => clearTimeout(timer);
  }, [kind, state.workspaceHintAt]);

  useEffect(() => {
    document.documentElement.classList.toggle('overlay-root', kind !== 'settings');
    document.body.classList.toggle('overlay-body', kind !== 'settings');
    void bridge.getState().then(s => setRoot(s.repositoryRoot));
  }, [kind]);
  useEffect(() => { setRoot(state.repository?.root || ''); }, [state.repository?.root, state.conversation?.conversation_id]);
  useEffect(() => { setText(''); setSpeechReview(false); setSearchResults([]); setWorkspaceHint(''); }, [state.conversation?.conversation_id]);
  useEffect(() => { player.current?.setVolume(Number(state.settings.volume ?? 1)); }, [state.settings.volume, player]);
  useEffect(() => { setMode(state.mode); }, [state.mode]);
  useEffect(() => { if (targetOpen) targetDialog.current?.showModal(); else targetDialog.current?.close(); }, [targetOpen]);
  useEffect(() => { setSelectedPoint(undefined); }, [state.snapshot?.snapshot_id]);
  useEffect(() => bridge.onEvent(event => {
    if (event.type === 'desktop.navigate' && event.tab === 'tasks') { setTab('tasks'); void send({ type: 'capabilities.get' }); }
    if (event.type === 'desktop.navigate' && event.tab === 'history') { setTab('history'); void send({ type: 'history.get' }); void send({ type: 'conversations.get' }); }
    if (event.type === 'repository.searched') setSearchResults((event.results ?? []) as Record<string, unknown>[]);
    if (event.type === 'settings.ready') setSettingsSaved(false);
    if (event.type === 'input.transcribed') {
      setText(String(event.text || ''));
      setTab('chat');
      setSpeechReview(true);
      setTimeout(() => textarea.current?.focus(), 0);
    }
    if (event.type === 'desktop.cancelled' && recorder.current?.state === 'recording') {
      discardRecording.current = true;
      recorder.current.stop();
    }
  }), []);
  useEffect(() => () => {
    discardRecording.current = true;
    recordRequested.current = false;
    if (recordingTimer.current) clearTimeout(recordingTimer.current);
    recorder.current?.state === 'recording' && recorder.current.stop();
    microphone.current?.getTracks().forEach(track => track.stop());
  }, []);

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
      setText(''); setSpeechReview(false); setTab('chat');
    }
  }
  async function stop() {
    player.current?.cancel(state.generation);
    dispatch({ protocol_version: 1, type: 'desktop.cancelled', cancelled_generation_id: state.generation });
    await send({ type: 'generation.cancel' });
  }
  async function selectRepository() {
    const directory = await bridge.chooseRepository();
    if (directory) { setRoot(directory); await send({ type: 'repository.inspect', root: directory }); }
  }
  async function setTaskMode(next: 'teach' | 'execute') {
    const previous = mode;
    setMode(next);
    if (!await send({ type: 'mode.set', mode: next })) setMode(previous);
  }
  async function startMicrophone() {
    if (recordRequested.current || recorder.current?.state === 'recording' || !state.connected) return;
    recordRequested.current = true;
    discardRecording.current = false;
    setSpeechReview(false);
    await stop();
    await send({ type: 'mode.set', mode });
    if (root && !state.repository) await send({ type: 'repository.inspect', root });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (!recordRequested.current) { stream.getTracks().forEach(track => track.stop()); return; }
      microphone.current = stream;
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      const instance = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 64000 });
      recorder.current = instance;
      const chunks: Blob[] = [];
      instance.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      instance.onstop = async () => {
        recordRequested.current = false;
        setRecording(false);
        if (recordingTimer.current) clearTimeout(recordingTimer.current);
        stream.getTracks().forEach(track => track.stop());
        microphone.current = null;
        recorder.current = null;
        dispatch({ protocol_version: 1, type: 'input.state', state: 'idle' });
        if (discardRecording.current || !chunks.length) return;
        const blob = new Blob(chunks, { type: mime });
        if (blob.size > 1_200_000) { setLocalError('录音过大，请用更短的问题再试一次。'); return; }
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        await send({ type: 'input.audio', audio_base64: dataUrl.split(',')[1], mime_type: mime });
      };
      instance.start(100);
      setRecording(true);
      dispatch({ protocol_version: 1, type: 'input.state', state: 'listening' });
      recordingTimer.current = setTimeout(endMicrophone, 15000);
    } catch (error) {
      recordRequested.current = false;
      microphone.current?.getTracks().forEach(track => track.stop());
      setLocalError(`麦克风无法开始录音：${String(error)}`);
    }
  }
  function endMicrophone() {
    recordRequested.current = false;
    if (recorder.current?.state === 'recording') recorder.current.stop();
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
  useEffect(() => {
    if (kind !== 'chat' || !textOnly) return;
    const candidates = state.speeches.filter(speech => speech.generation === state.generation && speech.state !== 'cancelled' && speech.state !== 'partial');
    const index = candidates.findIndex(speech => speech.id === state.presented);
    const next = candidates[index + 1];
    if (!next) return;
    const timer = setTimeout(() => {
      dispatch({ protocol_version: 1, type: 'desktop.present', utterance_id: next.id, generation_id: next.generation });
      void bridge.send({ type: 'utterance.displayed', utterance_id: next.id, generation_id: next.generation });
    }, index < 0 ? 0 : Math.max(1800, (candidates[index]?.ja.length || 20) * 90));
    return () => clearTimeout(timer);
  }, [kind, textOnly, state.speeches.length, state.presented, state.generation, dispatch]);

  if (kind === 'highlight') return state.targetCue?.variant === 'summon'
    ? <div key={String(state.targetCue.cue_id)} className="target-aura" aria-label="Ayana 正在观察这个窗口"><i/><b/><em/><span/></div>
    : <div className="highlight-frame"><span>Ayana · 看这里</span></div>;
  if (kind === 'chat') return <main className="companion-shell">
    {workspaceHint && <div className="workspace-hint" role="status" aria-live="polite">{workspaceHint}</div>}
    <div className="portrait-stage">
      <div className="portrait-reveal" ref={portraitReveal}>
      <Character key={String(state.connected)} expression={state.expression} motion={state.settings.sentence_motion !== false} />
      </div>
    </div>
    <section ref={dialogue} className="gal-dialogue" aria-label="Ayana 对话">
      <header className="gal-heading"><strong>Ayana <small>あやな</small></strong><div>
        <button aria-label="打开设置" title="设置与管理" onClick={() => void bridge.openSettings()}><Icon name="settings" size={16}/></button>
        <button aria-label="收起 Ayana" title="收起" onClick={() => void bridge.hide()}><Icon name="close" size={16}/></button>
      </div></header>
      <ConversationControls state={state} send={send} disabled={recording || state.inputState === 'transcribing'} onHistory={() => void bridge.openSettings('history')}>
      <div className="gal-lines" aria-live="polite">
        <p lang="ja">{presented?.ja || (busy ? '…' : 'ここにいるよ。')}</p>
        {state.settings.subtitles !== false && <p className="gal-translation">{presented ? presented.zh || '翻译正在补齐…' : recording ? '正在聆听，松开后识别。' : state.inputState === 'transcribing' ? '正在识别语音…' : busy ? '让我想一想…' : '我在这里。想聊什么？'}</p>}
      </div>
      </ConversationControls>
      {(localError || state.error) && <div className="gal-error" role="alert">{localError || state.error}<button aria-label="关闭错误提示" onClick={() => { setLocalError(''); dispatch({ protocol_version: 1, type: 'desktop.dismiss-error' }); }}>×</button></div>}
      {(state.activeTask || state.artifacts.length > 0) && <button className="action-notice" onClick={() => void bridge.openSettings('tasks')}>{state.approvals.length ? '有待确认的步骤' : agentTaskLabels[String(state.activeTask?.state)] || '查看保存的文件'} · 打开任务与结果</button>}
      {state.settings.full_access === true ? <button className="action-notice" onClick={() => void bridge.openSettings('tasks')}>Full access 已开启 · 管理访问权限</button> : <label className="agent-mode"><input type="checkbox" checked={mode === 'execute'} onChange={event => void setTaskMode(event.target.checked ? 'execute' : 'teach')}/>允许本次任务生成文件与提出操作</label>}
      {mode === 'execute' && state.computerUse && !state.computerUse.available && <p className="computer-not-ready" role="status">桌面执行未就绪：{String(state.computerUse.detail || '需要安装或配置桌面执行组件。')}</p>}
          <form className="composer" onSubmit={event => { event.preventDefault(); void ask(); }}>
            <textarea ref={textarea} value={text} maxLength={4000} rows={2} onChange={event => setText(event.target.value)} placeholder="想说什么，都可以…" aria-label="输入问题" onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(); } }}/>
            <div className="composer-footer"><div><Button type="button" className={`mic-button ${recording ? 'recording' : ''}`} color={recording ? 'danger' : 'default'} variant="light" disabled={!state.connected || state.inputState === 'transcribing'} aria-label="按住说话，松开识别，最长15秒" title="按住说话，松开后识别（最长15秒）" onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); void startMicrophone(); }} onPointerUp={endMicrophone} onPointerCancel={() => { discardRecording.current = true; endMicrophone(); }} onKeyDown={event => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); void startMicrophone(); } }} onKeyUp={event => { if (event.key === ' ' || event.key === 'Enter') endMicrophone(); }}><Icon name="mic" size={15}/>{recording ? '录音中' : '按住说话'}</Button><Button color="danger" variant="light" onClick={() => void stop()} type="button" disabled={!busy && !recording}><Icon name="stop" size={14}/>打断</Button><Button color="primary" variant="solid" type="submit" disabled={!text.trim() || !state.connected || recording}>发送<Icon name="arrow" size={16}/></Button></div></div>
          </form>
          <div className="composer-hint">{speechReview ? '语音已识别，可修改后发送。' : 'Enter 发送 · Shift + Enter 换行'} <span>Ctrl + Alt + Space 立即停止语音</span></div>
    </section>
  </main>;

  const files = state.repository?.files.filter(file => file.toLowerCase().includes(fileFilter.toLowerCase())) || [];
  const targetName = state.target?.title || '还未选择窗口';
  const statusText = recording ? '正在聆听 · 松开后识别' : state.inputState === 'transcribing' ? '正在识别语音' : current ? 'Ayana 正在说话' : taskLabels[state.task] || state.task;
  const latestTool = state.tools.at(-1);

  return <div className="workshop">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Icon name="sparkles" size={25}/></div><div><strong>Ayana</strong><span>你的桌面同伴</span></div></div>
      <div className={`connection ${state.connected ? 'online' : ''}`}><i/>{state.connected ? '本地服务已连接' : state.service === 'preview' ? '桌面界面预览' : '本地服务启动中'}</div>
      <nav aria-label="主导航">
        {([['chat', 'settings', '对话设置'], ['tasks', 'file', '任务与结果'], ['files', 'folder', '仓库文件'], ['history', 'history', '话题与记录']] as const).map(([id, icon, label]) => <button key={id} className={`nav-item ${tab === id ? 'active' : ''}`} onClick={() => { setTab(id); if (id === 'history') { void send({ type: 'history.get' }); void send({ type: 'conversations.get' }); } if (id === 'tasks') void send({ type: 'capabilities.get' }); }}><Icon name={icon}/>{label}{id === 'files' && state.repository && <small>{state.repository.files.length}</small>}</button>)}
      </nav>
      <div className="workspace-label">可选的仓库上下文</div>
      <button className="repository-card" onClick={selectRepository}><span className="folder-tile"><Icon name="folder" size={21}/></span><strong>{state.repository?.name || '选择一个仓库'}</strong><small>{state.repository ? '已读取真实文件证据' : '需要读代码时再选择'}</small><Icon name="arrow" size={16}/></button>
      <label className="root-label" htmlFor="repository-root">也可以粘贴本地目录</label>
      <Input id="repository-root" value={root} onChange={event => setRoot(event.target.value)} placeholder="D:\\your-project" onKeyDown={event => { if (event.key === 'Enter' && root) void send({ type: 'repository.inspect', root }); }} />
      <Button className="inspect-button" disabled={!root || !state.connected} onClick={() => void send({ type: 'repository.inspect', root })}><Icon name="eye" size={15}/>读取仓库</Button>
      <div className="sidebar-bottom">
        <div className="shortcut-note"><Icon name="keyboard" size={17}/><div><span>随时呼出</span><kbd>Ctrl + Alt + A</kbd></div></div>
        <button className="nav-item" onClick={() => void bridge.summon()}><Icon name="message"/>呼出 Ayana</button>
        <div className="build-label">AYANA DESKTOP <span>v0.3.3</span></div>
      </div>
    </aside>

    <main className="main-panel">
      <header className="main-header"><div><div className="eyebrow">AYANA PREFERENCES</div><h1>{tab === 'chat' ? '按你的习惯，相处。' : tab === 'tasks' ? '一起，把事情做好。' : tab === 'files' ? '每个解释，都有出处。' : '我们走过的每一步。'}</h1></div><Button variant="bordered" onClick={() => void bridge.hideSettings()}><Icon name="close" size={16}/>关闭设置</Button></header>
      {tab === 'tasks' && <TaskPanel state={state} send={send}/>}
      {(localError || state.error) && <div className="error-banner" role="alert"><span>{localError || state.error}</span><button aria-label="关闭错误提示" onClick={() => { setLocalError(''); dispatch({ protocol_version: 1, type: 'desktop.dismiss-error' }); }}>×</button></div>}
      {tab === 'chat' && <section className="preferences-view">
        <p className="preferences-intro">日常呼出只显示立绘与对话。这里管理声音、显示习惯，以及可选的工具上下文。</p>
        <SettingsForm key={JSON.stringify(state.settings)} state={state} onSave={async settings => { const success = await send({ type: 'settings.update', settings }); setSettingsSaved(success); }} />
        <div className="settings-bottom"><span>{settingsSaved ? '设置已提交。' : '设置保存在本机。'}</span><Button onClick={() => void bridge.restart()}><Icon name="refresh" size={15}/>重启服务</Button></div>
        <div className="mode-strip">{state.settings.full_access === true ? <button className="action-notice" onClick={() => { setTab('tasks'); void send({ type: 'capabilities.get' }); }}>Full access 已开启 · 任务可直接执行</button> : <div className="segmented"><button className={mode === 'teach' ? 'selected' : ''} onClick={() => void setTaskMode('teach')}>对话与观察</button><button className={mode === 'execute' ? 'selected' : ''} onClick={() => void setTaskMode('execute')}>执行任务</button></div>}</div>
        {state.actions.map(event => { const action = event.action as Record<string, unknown>; return <div className="proposed-action" key={String(action.action_id)}><p>{String(event.label || action.expected_result)}</p><Button color="primary" disabled={mode !== 'execute' && action.kind !== 'highlight'} onClick={() => void send({ type: 'tool.execute', action_id: action.action_id, snapshot_id: action.snapshot_id })}>确认并执行一步</Button></div>; })}
      </section>}
      {tab === 'files' && <section className="files-view">
        <div className="section-intro"><Icon name="folder" size={22}/><div><h2>{state.repository?.name || '还没有学习空间'}</h2><p>{state.repository ? `${state.repository.files.length} 个源码与文本文件 · 内容限制在所选仓库内` : '选择左侧仓库，查看文件与经过读取的证据。'}</p></div></div>
        <Input value={fileFilter} onChange={event => setFileFilter(event.target.value)} placeholder="筛选文件名…" aria-label="筛选文件"/>
        <form className="search-bar" onSubmit={event => { event.preventDefault(); if (search && root) void send({ type: 'repository.search', root, query: search }); }}><Input value={search} onChange={event => setSearch(event.target.value)} placeholder="在源码里搜索关键词" aria-label="源码关键词"/><Button color="primary" type="submit" disabled={!root || !search}>搜索</Button></form>
        {searchResults.length > 0 && <div className="search-results">{searchResults.map((result, index) => <button key={index} onClick={() => void send({ type: 'repository.read', root, path: result.path, start_line: result.line })}><b>{String(result.path)}:{String(result.line)}</b><code>{String(result.text)}</code></button>)}</div>}
        <div className="file-list">{files.map(file => <button key={file} onClick={() => void send({ type: 'repository.read', root, path: file })}><Icon name="file" size={16}/><span>{file}</span><Icon name="arrow" size={13}/></button>)}</div>
        <EvidenceCards state={state}/>
      </section>}
      {tab === 'history' && <ConversationHistory state={state} send={send}/>}
      <footer className="main-status"><span><i className={current ? 'pulsing' : ''}/>{statusText}</span><span>{state.target ? '目标窗口已绑定' : '等待选择目标窗口'}</span></footer>
    </main>

    <aside className="context-panel">
      <div className="context-heading"><span>眼前的上下文</span><Icon name="eye" size={17}/></div>
      <div className="target-card"><div className="target-title"><span className="window-icon"><Icon name="monitor" size={17}/></span><div><small>当前目标窗口</small><strong title={targetName}>{targetName}</strong></div></div><div className="target-actions"><Button variant="light" onClick={() => { void send({ type: 'windows.list' }); setTargetOpen(true); }}>选择窗口</Button><Button variant="light" onClick={() => void send({ type: 'target.capture' })} disabled={!state.target}><Icon name="refresh" size={14}/>刷新</Button></div>
        {state.snapshot?.png_base64 ? <div className="snapshot-wrap"><img className="snapshot" src={`data:image/png;base64,${String(state.snapshot.png_base64)}`} alt="所绑定目标窗口的当前截图" onClick={event => {
          const rect = event.currentTarget.getBoundingClientRect();
          const x = Math.floor((event.clientX - rect.left) / rect.width * event.currentTarget.naturalWidth);
          const y = Math.floor((event.clientY - rect.top) / rect.height * event.currentTarget.naturalHeight);
          setSelectedPoint({ x, y });
        }}/><small>点击截图选择教学位置</small></div> : <div className="snapshot-empty"><Icon name="monitor" size={34}/><p>先打开你想看的窗口</p><small>按 Ctrl + Alt + A 重新呼出</small></div>}
      </div>
      {selectedPoint && <div className="step-card"><div className="step-heading"><span>选择的位置</span><code>{selectedPoint.x}, {selectedPoint.y}</code></div><select value={actionKind} onChange={event => setActionKind(event.target.value)} aria-label="单步操作类型"><option value="highlight">高亮这里</option><option value="click">点击这里</option><option value="type">在这里输入</option><option value="scroll">向下滚动 3 格</option><option value="key">发送一个按键</option></select>{actionKind === 'type' && <Input value={actionText} onChange={event => setActionText(event.target.value)} placeholder="要输入到目标窗口的文字"/>}{actionKind === 'key' && <select value={actionKey} onChange={event => setActionKey(event.target.value)} aria-label="发送的按键">{['enter', 'tab', 'escape', 'backspace', 'left', 'up', 'right', 'down', 'home', 'end', 'pageup', 'pagedown'].map(key => <option value={key} key={key}>{key}</option>)}</select>}<small>将使用当前截图校验目标。{actionKind !== 'highlight' ? '此操作会改变目标窗口。' : '高亮不会阻挡你的鼠标。'}</small><Button color="primary" variant="solid" disabled={(mode !== 'execute' && actionKind !== 'highlight') || (actionKind === 'type' && !actionText)} onClick={() => void executeManual()}>{actionKind === 'highlight' ? '显示高亮' : '确认并执行一步'}</Button></div>}
<div className="catalog-note"><strong>完整角色素材</strong><p>234 张立绘 · 26 种表情</p><small>保存新服装后，Ayana 会主动回应，并伴随闪光换装。表情与动作按每句语境选择。</small></div>
      <div className="evidence-summary"><div className="context-heading"><span>文件证据</span><span className="count-badge">{state.evidence.length}</span></div>{state.evidence.length ? state.evidence.slice(-3).map(e => <button key={e.path} onClick={() => setTab('files')}><Icon name="file" size={15}/><span>{e.path}</span><small>L{e.start_line || e.line || 1}</small></button>) : <p>读取仓库后，相关文件会在这里出现。</p>}</div>
      {latestTool && <div className={`tool-result ${latestTool.type === 'tool.failed' ? 'failed' : ''}`}><Icon name={latestTool.type === 'tool.failed' ? 'close' : 'check'} size={14}/><span>{latestTool.type === 'tool.completed' ? '操作已返回真实结果' : latestTool.type === 'tool.started' ? '正在观察或执行' : String(latestTool.message)}</span></div>}
    </aside>

    <dialog ref={targetDialog} className="kun-dialog" onCancel={() => setTargetOpen(false)}><div className="dialog-heading"><div><span className="eyebrow">TARGET WINDOW</span><h2>选择 Ayana 要看的窗口</h2></div><Button variant="light" aria-label="关闭窗口选择" onClick={() => setTargetOpen(false)}><Icon name="close"/></Button></div><p className="dialog-note">绑定后会获取新截图；新目标会停止之前的语音与操作。</p><div className="windows-list">{state.windows.map(window => <button key={window.hwnd} onClick={() => { void send({ type: 'target.bind', hwnd: window.hwnd }); setTargetOpen(false); }}><Icon name="monitor"/><div><strong>{window.title || '未命名窗口'}</strong><small>进程 {window.process_id} · HWND {window.hwnd}</small></div><Icon name="arrow"/></button>)}</div><Button onClick={() => void send({ type: 'windows.list' })}><Icon name="refresh" size={15}/>刷新窗口列表</Button></dialog>

  </div>;
}

function SpeechRow({ speech, current, showChinese }: { speech: Speech; current: boolean; showChinese: boolean }) {
  return <div className={`speech-row ${current ? 'current' : ''} ${speech.state === 'cancelled' ? 'cancelled' : ''}`}><p>{showChinese ? speech.zh || speech.ja : speech.ja}</p><div className="speech-meta">{showChinese && <span lang="ja">{speech.ja}</span>}<small>{current && <i/>}{reception[speech.state]}</small></div></div>;
}

function EvidenceCards({ state }: { state: ModelState }) {
  return <div className="evidence-cards">{state.evidence.map(evidence => <article key={evidence.path}><div><Icon name="file" size={16}/><strong>{evidence.path}</strong><small>从第 {evidence.start_line || evidence.line || 1} 行读取</small></div><pre><code>{evidence.content}</code></pre></article>)}</div>;
}

function SettingsForm({ state, onSave }: { state: ModelState; onSave: (settings: Record<string, unknown>) => Promise<void> }) {
  const cfg = state.settings;
  const voice = (cfg.voice || {}) as Record<string, unknown>;
  const [provider, setProvider] = useState(String(cfg.provider || 'local'));
  const [model, setModel] = useState(String(cfg.model || ''));
  const [baseUrl, setBaseUrl] = useState(String(cfg.base_url || 'https://api.openai.com/v1'));
  const [voiceMode, setVoiceMode] = useState(String(voice.voice_mode || 'auto'));
  const [hotkey, setHotkey] = useState(String(cfg.hotkey || 'Control+Alt+A'));
  const [cancelHotkey, setCancelHotkey] = useState(String(cfg.cancel_hotkey || 'Control+Alt+Space'));
  const [subtitles, setSubtitles] = useState(cfg.subtitles !== false);
  const [screenshot, setScreenshot] = useState(cfg.send_screenshot !== false);
  const [history, setHistory] = useState(cfg.save_history !== false);
  const [costume, setCostume] = useState(String(cfg.avatar_costume || '校服'));
  const [sentenceMotion, setSentenceMotion] = useState(cfg.sentence_motion !== false);
  const [volume, setVolume] = useState(Number(cfg.volume ?? 1));
  const costumes = [...new Set(Object.values(avatarCatalog.assets).map(item => item.costume))];
  const usage = state.modelUsage;
  const cacheRatio = typeof usage?.cache_hit_ratio === 'number' ? usage.cache_hit_ratio : undefined;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void onSave({ provider, model, base_url: baseUrl, voice: { ...voice, voice_mode: voiceMode }, hotkey, cancel_hotkey: cancelHotkey, subtitles, send_screenshot: screenshot, save_history: history, avatar_costume: costume, sentence_motion: sentenceMotion, volume });
  };
  return <form className="settings-form" onSubmit={submit}><div className="form-section"><h3>对话模型</h3><label>模型模式<select value={provider} onChange={event => setProvider(event.target.value)}><option value="local">本地演示 · 简单回应与文件读取</option><option value="openai">在线模型 · OpenAI 兼容接口</option></select></label>{provider === 'openai' && <><label>服务地址<Input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1"/></label><label>模型名称<Input value={model} onChange={event => setModel(event.target.value)} placeholder="填写你可用的模型名称"/></label><p className="field-note">API 凭证使用本机的 AYANA_API_KEY 或已保存的受保护凭证。</p><p className="field-note">{usage && usage.model === model ? `最近请求：输入 ${usage.prompt_tokens ?? '未知'} tokens · 缓存命中 ${usage.prompt_cache_hit_tokens ?? '未知'} tokens${cacheRatio !== undefined ? `（${(cacheRatio * 100).toFixed(1)}%）` : ''}` : '缓存统计将在模型返回用量回执后显示。'}</p></>}</div><div className="form-section"><h3>日语声音</h3><label>语音引擎<select value={voiceMode} onChange={event => setVoiceMode(event.target.value)}><option value="auto">自动选择已配置的音色</option><option value="sovits">Ayana · GPT-SoVITS 本地音色</option><option value="system">Windows 已安装的日语语音</option><option value="silent">仅显示文字</option></select></label><p className="field-note">本地音色所需的模型、参考音频与引擎路径在 voice 配置中设置。</p></div><div className="form-section"><h3>立绘与对话</h3><label>服装<select value={costume} onChange={event => setCostume(event.target.value)}>{costumes.map(item => <option key={item} value={item}>{item}</option>)}</select></label><p className="field-note">默认半身立绘；模型只在所选服装下选择表情与动作。</p><label className="motion-toggle"><input type="checkbox" checked={sentenceMotion} onChange={event => setSentenceMotion(event.target.checked)}/><span>更换表情时轻微下沉，再回到原位</span></label><label>播放音量 · {Math.round(volume * 100)}%<input type="range" min="0" max="1" step="0.05" value={volume} onChange={event => setVolume(Number(event.target.value))}/></label></div><div className="form-section"><h3>快捷键</h3><div className="form-grid"><label>呼出<Input value={hotkey} onChange={event => setHotkey(event.target.value)}/></label><label>立即打断<Input value={cancelHotkey} onChange={event => setCancelHotkey(event.target.value)}/></label></div>{state.shortcuts && (!state.shortcuts.summon_ok || !state.shortcuts.cancel_ok) && <p className="shortcut-error">有快捷键未注册成功，请换一个组合。</p>}</div><div className="form-section settings-toggles"><label><input type="checkbox" checked={subtitles} onChange={event => setSubtitles(event.target.checked)}/><span>显示中文字幕</span></label><label><input type="checkbox" checked={screenshot} onChange={event => setScreenshot(event.target.checked)}/><span>在线模型可使用当前目标截图</span></label><label><input type="checkbox" checked={history} onChange={event => setHistory(event.target.checked)}/><span>在本机保存会话历史</span></label></div><Button type="submit" disabled={!state.connected || !state.settingsLoaded} color="primary" variant="solid">保存设置<Icon name="check" size={16}/></Button></form>;
}




