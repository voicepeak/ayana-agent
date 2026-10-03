import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Character, Icon, Input } from './components';
import { bridge, useRuntime, type ModelState, type Speech } from './state';
import type { RuntimeEvent } from './types';

const taskLabels: Record<string, string> = { idle: '可以开始啦', observing: '正在观察目标', thinking: '正在整理思路', acting: '正在执行这一步', failed: '需要留意', speaking: 'Ayana 正在说话' };
const voiceLabels: Record<string, string> = { starting: '语音启动中', loading: '加载 Ayana 音色', warming: '音色预热中', ready: '语音已就绪', synthesizing: '正在合成下一句', failed: '语音暂不可用', stopped: '语音已关闭' };
const reception: Record<string, string> = { generated: '文字已生成', playing: '正在播放', played: '已播放', partial: '已打断', cancelled: '未播放' };

export default function App() {
  const kind = new URLSearchParams(location.search).get('window') || 'chat';
  const { state, dispatch, player } = useRuntime(kind === 'chat');
  const [tab, setTab] = useState<'chat' | 'files' | 'history'>('chat');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [targetOpen, setTargetOpen] = useState(false);
  const [text, setText] = useState('');
  const [root, setRoot] = useState('');
  const [mode, setMode] = useState<'teach' | 'execute'>('teach');
  const [selectedPoint, setSelectedPoint] = useState<{ x: number; y: number }>();
  const [actionKind, setActionKind] = useState('highlight');
  const [actionText, setActionText] = useState('');
  const [actionKey, setActionKey] = useState('enter');
  const [volume, setVolume] = useState(1);
  const [fileFilter, setFileFilter] = useState('');
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<Record<string, unknown>[]>([]);
  const [localError, setLocalError] = useState('');
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [recording, setRecording] = useState(false);
  const [speechReview, setSpeechReview] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const microphone = useRef<MediaStream | null>(null);
  const recordRequested = useRef(false);
  const discardRecording = useRef(false);
  const recordingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bottom = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const targetDialog = useRef<HTMLDialogElement>(null);
  const current = state.speeches.find(speech => speech.id === state.current);
  const busy = state.task === 'thinking' || state.task === 'observing' || state.inputState === 'transcribing' || Boolean(current);

  useEffect(() => {
    document.body.classList.toggle('overlay-body', kind !== 'chat');
    if (kind === 'chat') void bridge.getState().then(s => setRoot(s.repositoryRoot));
  }, [kind]);
  useEffect(() => { if (state.repository?.root) setRoot(state.repository.root); }, [state.repository?.root]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [state.speeches.length, state.questions.length, state.speeches.at(-1)?.zh]);
  useEffect(() => { player.current?.setVolume(volume); }, [volume, player]);
  useEffect(() => { if (settingsOpen) dialogRef.current?.showModal(); else dialogRef.current?.close(); }, [settingsOpen]);
  useEffect(() => { if (targetOpen) targetDialog.current?.showModal(); else targetDialog.current?.close(); }, [targetOpen]);
  useEffect(() => { setSelectedPoint(undefined); }, [state.snapshot?.snapshot_id]);
  useEffect(() => bridge.onEvent(event => {
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
    if (await send({ type: 'turn.start', text: question.trim(), repository_root: root || undefined, mode })) {
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
    if (await send({ type: 'mode.set', mode: next })) setMode(next);
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

  if (kind === 'avatar') {
    return <div className="avatar-stage">
      <div className={`avatar-bubble ${current ? 'visible' : ''}`}>
        <span>Ayana</span><p>{state.settings.subtitles === false ? current?.ja : current?.zh || current?.ja}</p>
        <div className="bubble-progress"><i style={{ width: `${state.progress * 100}%` }} /></div>
      </div>
      <Character key={String(state.connected)} expression={state.expression} className={current ? 'speaking' : ''} />
    </div>;
  }
  if (kind === 'highlight') return <div className="highlight-frame"><span>Ayana · 看这里</span></div>;

  const files = state.repository?.files.filter(file => file.toLowerCase().includes(fileFilter.toLowerCase())) || [];
  const groups = [...new Set([...state.questions.map(q => q.generation), ...state.speeches.map(s => s.generation)])];
  const targetName = state.target?.title || '还未选择窗口';
  const statusText = recording ? '正在聆听 · 松开后识别' : state.inputState === 'transcribing' ? '正在识别语音' : current ? 'Ayana 正在说话' : taskLabels[state.task] || state.task;
  const latestTool = state.tools.at(-1);

  return <div className="workshop">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Icon name="sparkles" size={25}/></div><div><strong>Ayana</strong><span>你的桌面同伴</span></div></div>
      <div className={`connection ${state.connected ? 'online' : ''}`}><i/>{state.connected ? '本地服务已连接' : state.service === 'preview' ? '桌面界面预览' : '本地服务启动中'}</div>
      <nav aria-label="主导航">
        {([['chat', 'message', '一起学习'], ['files', 'folder', '仓库文件'], ['history', 'history', '对话历史']] as const).map(([id, icon, label]) => <button key={id} className={`nav-item ${tab === id ? 'active' : ''}`} onClick={() => { setTab(id); if (id === 'history') void send({ type: 'history.get' }); }}><Icon name={icon}/>{label}{id === 'files' && state.repository && <small>{state.repository.files.length}</small>}</button>)}
      </nav>
      <div className="workspace-label">当前学习空间</div>
      <button className="repository-card" onClick={selectRepository}><span className="folder-tile"><Icon name="folder" size={21}/></span><strong>{state.repository?.name || '选择一个仓库'}</strong><small>{state.repository ? '已读取真实文件证据' : '从 README 到第一条功能'}</small><Icon name="arrow" size={16}/></button>
      <label className="root-label" htmlFor="repository-root">也可以粘贴本地目录</label>
      <Input id="repository-root" value={root} onChange={event => setRoot(event.target.value)} placeholder="D:\\your-project" onKeyDown={event => { if (event.key === 'Enter' && root) void send({ type: 'repository.inspect', root }); }} />
      <Button className="inspect-button" disabled={!root || !state.connected} onClick={() => void send({ type: 'repository.inspect', root })}><Icon name="eye" size={15}/>读取仓库</Button>
      <div className="sidebar-bottom">
        <div className="shortcut-note"><Icon name="keyboard" size={17}/><div><span>随时呼出</span><kbd>Ctrl + Alt + A</kbd></div></div>
        <button className="nav-item" onClick={() => setSettingsOpen(true)}><Icon name="settings"/>偏好设置</button>
        <div className="build-label">AYANA DESKTOP <span>v0.1.0</span></div>
      </div>
    </aside>

    <main className="main-panel">
      <header className="main-header"><div><div className="eyebrow">AYANA WORKSHOP</div><h1>{tab === 'chat' ? '一起把它看懂。' : tab === 'files' ? '每个解释，都有出处。' : '我们走过的每一步。'}</h1></div><Button variant="bordered" onClick={() => void bridge.hide()}><Icon name="close" size={16}/>收起</Button></header>
      {(localError || state.error) && <div className="error-banner" role="alert"><span>{localError || state.error}</span><button aria-label="关闭错误提示" onClick={() => { setLocalError(''); dispatch({ protocol_version: 1, type: 'desktop.dismiss-error' }); }}>×</button></div>}
      {tab === 'chat' && <>
        <section className="conversation" aria-live="polite" aria-label="对话内容">
          {!state.questions.length && !state.speeches.length && <div className="welcome">
            <div className="welcome-symbol"><Icon name="book" size={30}/></div>
            <h2>从一个小问题开始</h2><p>打开你正在看的窗口，呼出 Ayana。<br/>她会用日语讲解，把中文和真实文件证据留在这里。</p>
            <div className="suggestions">
              {[['这个仓库怎么开始学？', 'folder'], ['解释一下我正在看的窗口', 'monitor'], ['用一个更小的例子讲给我听', 'book']].map(([question, icon]) => <button key={question} onClick={() => { setText(question); textarea.current?.focus(); }}><Icon name={icon}/><span>{question}</span><Icon name="arrow" size={15}/></button>)}
            </div>
            <div className="welcome-footnote"><i/>中文阅读 · 日语语音 · 随时打断</div>
          </div>}
          {groups.map(generation => <div key={generation} className="turn-group">
            {state.questions.filter(q => q.generation === generation).map((q, index) => <div className="user-message" key={`${generation}-${index}`}><span>你</span><p>{q.text}</p></div>)}
            {state.speeches.some(s => s.generation === generation) && <div className="assistant-message"><div className="message-avatar">A</div><div className="assistant-content"><div className="message-byline">Ayana <span>一起，一步一步来</span></div>{state.speeches.filter(s => s.generation === generation).map(speech => <SpeechRow key={speech.id} speech={speech} current={speech.id === state.current} showChinese={state.settings.subtitles !== false} />)}</div></div>}
          </div>)}
          {busy && !current && <div className="thinking-row"><span className="thinking-dots"><i/><i/><i/></span>{statusText}</div>}
          {state.actions.map(event => {
            const action = event.action as Record<string, unknown>;
            return <div className="proposed-action" key={String(action.action_id)}><span className="eyebrow">下一步 · 由你确认</span><p>{String(event.label || action.expected_result)}</p><small>{String(action.kind)} · 当前快照 {String(action.snapshot_id)}</small><Button color="primary" disabled={mode !== 'execute' && action.kind !== 'highlight'} onClick={() => void send({ type: 'tool.execute', action_id: action.action_id, snapshot_id: action.snapshot_id })}>执行这一步<Icon name="arrow" size={16}/></Button></div>;
          })}
          <div ref={bottom}/>
        </section>
        <section className="composer-area">
          <div className="mode-strip"><div className="segmented"><button className={mode === 'teach' ? 'selected' : ''} onClick={() => void setTaskMode('teach')}><Icon name="book" size={14}/>教我理解</button><button className={mode === 'execute' ? 'selected' : ''} onClick={() => void setTaskMode('execute')}><Icon name="monitor" size={14}/>单步执行</button></div><span>{mode === 'teach' ? '讲解与高亮' : '每一步由你确认'}</span></div>
          <form className="composer" onSubmit={event => { event.preventDefault(); void ask(); }}>
            <textarea ref={textarea} value={text} maxLength={4000} rows={2} onChange={event => setText(event.target.value)} placeholder="说说你想理解什么，或需要哪一步帮助…" aria-label="输入问题" onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(); } }}/>
            <div className="composer-footer"><span><Icon name="sparkles" size={14}/>{state.settings.provider === 'openai' ? '已配置在线模型' : '本地文件教学模式'}</span><div><Button type="button" className={`mic-button ${recording ? 'recording' : ''}`} color={recording ? 'danger' : 'default'} variant="light" disabled={!state.connected || state.inputState === 'transcribing'} aria-label="按住说话，松开识别，最长15秒" title="按住说话，松开后识别（最长15秒）" onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); void startMicrophone(); }} onPointerUp={endMicrophone} onPointerCancel={() => { discardRecording.current = true; endMicrophone(); }} onKeyDown={event => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); void startMicrophone(); } }} onKeyUp={event => { if (event.key === ' ' || event.key === 'Enter') endMicrophone(); }}><Icon name="mic" size={15}/>{recording ? '录音中' : '按住说话'}</Button><Button color="danger" variant="light" onClick={() => void stop()} type="button" disabled={!busy && !recording}><Icon name="stop" size={14}/>打断</Button><Button color="primary" variant="solid" type="submit" disabled={!text.trim() || !state.connected || recording}>发送<Icon name="arrow" size={16}/></Button></div></div>
          </form>
          <div className="composer-hint">{speechReview ? '语音已识别，可修改后发送。' : 'Enter 发送 · Shift + Enter 换行'} <span>Ctrl + Alt + Space 立即停止语音</span></div>
        </section>
      </>}
      {tab === 'files' && <section className="files-view">
        <div className="section-intro"><Icon name="folder" size={22}/><div><h2>{state.repository?.name || '还没有学习空间'}</h2><p>{state.repository ? `${state.repository.files.length} 个源码与文本文件 · 内容限制在所选仓库内` : '选择左侧仓库，查看文件与经过读取的证据。'}</p></div></div>
        <Input value={fileFilter} onChange={event => setFileFilter(event.target.value)} placeholder="筛选文件名…" aria-label="筛选文件"/>
        <form className="search-bar" onSubmit={event => { event.preventDefault(); if (search && root) void send({ type: 'repository.search', root, query: search }); }}><Input value={search} onChange={event => setSearch(event.target.value)} placeholder="在源码里搜索关键词" aria-label="源码关键词"/><Button color="primary" type="submit" disabled={!root || !search}>搜索</Button></form>
        {searchResults.length > 0 && <div className="search-results">{searchResults.map((result, index) => <button key={index} onClick={() => void send({ type: 'repository.read', root, path: result.path, start_line: result.line })}><b>{String(result.path)}:{String(result.line)}</b><code>{String(result.text)}</code></button>)}</div>}
        <div className="file-list">{files.map(file => <button key={file} onClick={() => void send({ type: 'repository.read', root, path: file })}><Icon name="file" size={16}/><span>{file}</span><Icon name="arrow" size={13}/></button>)}</div>
        <EvidenceCards state={state}/>
      </section>}
      {tab === 'history' && <section className="history-view"><div className="section-intro"><Icon name="history" size={23}/><div><h2>真实的播放记录</h2><p>保留完整播放、中途打断和仅显示文字的区别。</p></div></div>{!state.history.length && <p className="empty-note">开始一次对话，Ayana 会把我们的进度记在这里。</p>}{state.history.map((item, index) => <article className="history-item" key={String(item.utterance_id || index)}><span className="history-state">{reception[String(item.status)] || String(item.status)}</span><p>{String(item.display_zh || item.speech_ja || '')}</p><small lang="ja">{String(item.speech_ja || '')}</small>{Number(item.played_samples) > 0 && <small>实际播放 {(Number(item.played_samples) / Math.max(1, Number(item.sample_rate))).toFixed(1)} 秒</small>}</article>)}</section>}
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
      <div className="companion-card"><div className="companion-scenery"><div className="companion-orbit"/><Character key={String(state.connected)} expression={state.expression}/><div className="companion-name">Ayana <span>あやな</span></div></div><div className="voice-row"><span className="voice-icon"><Icon name="volume" size={17}/></span><div><strong>{(state.settings.voice as Record<string, unknown> | undefined)?.voice_mode === 'silent' ? '仅文字模式' : voiceLabels[state.voice] || state.voice}</strong><small>{current ? '表情与字幕跟随实际播放' : '陪你读懂每一个小步骤'}</small></div><span className={`voice-dot ${state.voice === 'ready' ? 'ready' : ''}`}/></div><label className="volume-slider"><span>音量</span><input type="range" min="0" max="1" step="0.05" value={volume} onChange={event => setVolume(Number(event.target.value))} aria-label="播放音量"/><small>{Math.round(volume * 100)}%</small></label>{current && <div className="live-subtitle"><span lang="ja">{current.ja}</span>{state.settings.subtitles !== false && <p>{current.zh || '中文字幕正在补齐…'}</p>}<div className="subtitle-progress"><i style={{ width: `${state.progress * 100}%` }}/></div></div>}</div>
      <div className="evidence-summary"><div className="context-heading"><span>文件证据</span><span className="count-badge">{state.evidence.length}</span></div>{state.evidence.length ? state.evidence.slice(-3).map(e => <button key={e.path} onClick={() => setTab('files')}><Icon name="file" size={15}/><span>{e.path}</span><small>L{e.start_line || e.line || 1}</small></button>) : <p>读取仓库后，相关文件会在这里出现。</p>}</div>
      {latestTool && <div className={`tool-result ${latestTool.type === 'tool.failed' ? 'failed' : ''}`}><Icon name={latestTool.type === 'tool.failed' ? 'close' : 'check'} size={14}/><span>{latestTool.type === 'tool.completed' ? '操作已返回真实结果' : latestTool.type === 'tool.started' ? '正在观察或执行' : String(latestTool.message)}</span></div>}
    </aside>

    <dialog ref={targetDialog} className="kun-dialog" onCancel={() => setTargetOpen(false)}><div className="dialog-heading"><div><span className="eyebrow">TARGET WINDOW</span><h2>选择 Ayana 要看的窗口</h2></div><Button variant="light" aria-label="关闭窗口选择" onClick={() => setTargetOpen(false)}><Icon name="close"/></Button></div><p className="dialog-note">绑定后会获取新截图；新目标会停止之前的语音与操作。</p><div className="windows-list">{state.windows.map(window => <button key={window.hwnd} onClick={() => { void send({ type: 'target.bind', hwnd: window.hwnd }); setTargetOpen(false); }}><Icon name="monitor"/><div><strong>{window.title || '未命名窗口'}</strong><small>进程 {window.process_id} · HWND {window.hwnd}</small></div><Icon name="arrow"/></button>)}</div><Button onClick={() => void send({ type: 'windows.list' })}><Icon name="refresh" size={15}/>刷新窗口列表</Button></dialog>
    <dialog ref={dialogRef} className="kun-dialog settings-dialog" onCancel={() => setSettingsOpen(false)}><div className="dialog-heading"><div><span className="eyebrow">PREFERENCES</span><h2>让 Ayana 配合你的习惯</h2></div><Button variant="light" aria-label="关闭设置" onClick={() => setSettingsOpen(false)}><Icon name="close"/></Button></div><SettingsForm key={JSON.stringify(state.settings)} state={state} onSave={async settings => { const success = await send({ type: 'settings.update', settings }); setSettingsSaved(success); }} /><div className="settings-bottom"><span>{settingsSaved ? '设置已提交，服务正在应用配置。' : '设置保存在本机；模型凭证由本地服务保管。'}</span><Button onClick={() => void bridge.restart()}><Icon name="refresh" size={15}/>重启服务</Button></div></dialog>
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
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void onSave({ provider, model, base_url: baseUrl, voice: { ...voice, voice_mode: voiceMode }, hotkey, cancel_hotkey: cancelHotkey, subtitles, send_screenshot: screenshot, save_history: history });
  };
  return <form className="settings-form" onSubmit={submit}><div className="form-section"><h3>理解与讲解</h3><label>模型模式<select value={provider} onChange={event => setProvider(event.target.value)}><option value="local">本地文件教学 · 无联网视觉模型</option><option value="openai">在线模型 · OpenAI 兼容接口</option></select></label>{provider === 'openai' && <><label>服务地址<Input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1"/></label><label>模型名称<Input value={model} onChange={event => setModel(event.target.value)} placeholder="填写你可用的模型名称"/></label><p className="field-note">API 凭证使用本机的 AYANA_API_KEY 或已保存的受保护凭证。</p></>}</div><div className="form-section"><h3>日语声音</h3><label>语音引擎<select value={voiceMode} onChange={event => setVoiceMode(event.target.value)}><option value="auto">自动选择已配置的音色</option><option value="sovits">Ayana · GPT-SoVITS 本地音色</option><option value="system">Windows 已安装的日语语音</option><option value="silent">仅显示文字</option></select></label><p className="field-note">本地音色所需的模型、参考音频与引擎路径在 voice 配置中设置。</p></div><div className="form-section"><h3>快捷键</h3><div className="form-grid"><label>呼出<Input value={hotkey} onChange={event => setHotkey(event.target.value)}/></label><label>立即打断<Input value={cancelHotkey} onChange={event => setCancelHotkey(event.target.value)}/></label></div>{state.shortcuts && (!state.shortcuts.summon_ok || !state.shortcuts.cancel_ok) && <p className="shortcut-error">有快捷键未注册成功，请换一个组合。</p>}</div><div className="form-section settings-toggles"><label><input type="checkbox" checked={subtitles} onChange={event => setSubtitles(event.target.checked)}/><span>显示中文字幕</span></label><label><input type="checkbox" checked={screenshot} onChange={event => setScreenshot(event.target.checked)}/><span>在线模型可使用当前目标截图</span></label><label><input type="checkbox" checked={history} onChange={event => setHistory(event.target.checked)}/><span>在本机保存会话历史</span></label></div><Button type="submit" color="primary" variant="solid">保存设置<Icon name="check" size={16}/></Button></form>;
}




