import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, PointerEvent as ReactPointerEvent } from 'react';
import { bootstrap, fetchAsset, logout, pair, serverLabel, sessionState } from './api';
import { assetUrl, characterOptions, costumes } from './character';
import { AudioPlayer } from './audio';
import { MobileBridge } from './bridge';
import { SpeechLine } from './SpeechLine';
import { initialState, reduceEvent } from './state';
import type { Bootstrap } from './types';

const assetCache = new Map<string, string>();

function loadAsset(assetId: string): Promise<string> {
  const resource = assetUrl(assetId);
  const cached = assetCache.get(resource);
  if (cached) return Promise.resolve(cached);
  return fetchAsset(assetId).then(blob => {
    const url = URL.createObjectURL(blob);
    assetCache.set(resource, url);
    if (assetCache.size > 240) {
      const oldest = assetCache.keys().next().value;
      if (oldest) {
        const stale = assetCache.get(oldest);
        assetCache.delete(oldest);
        if (stale) URL.revokeObjectURL(stale);
      }
    }
    return url;
  });
}

export function preloadAsset(assetId: string) {
  if (assetId) void loadAsset(assetId).catch(() => {});
}

function AssetImage({ assetId, className, alt, onError }: {
  assetId: string;
  className: string;
  alt: string;
  onError: () => void;
}) {
  const resource = assetUrl(assetId);
  const [src, setSrc] = useState(() => assetCache.get(resource) || '');
  useEffect(() => {
    let active = true;
    setSrc(assetCache.get(resource) || '');
    loadAsset(assetId).then(url => {
      if (active) setSrc(url);
    }).catch(() => {
      if (active) onError();
    });
    return () => { active = false; };
  }, [assetId, resource, onError]);
  return src ? <img className={className} src={src} alt={alt} draggable={false} /> : null;
}

const themes = [
  { id: 'ink', background: '#25282d', bubble: '#30343d' },
  { id: 'paper', background: '#e6dfd0', bubble: '#faf3e5' },
  { id: 'forest', background: '#293831', bubble: '#dbe8db' },
  { id: 'sea', background: '#1c3042', bubble: '#dce6ed' },
  { id: 'sakura', background: '#3a2430', bubble: '#f4d9e4' },
  { id: 'sky', background: '#dceaf2', bubble: '#f7fcff' },
  { id: 'amber', background: '#3b2b1f', bubble: '#f3e2c9' },
  { id: 'bamboo', background: '#23302c', bubble: '#d9ebe2' },
];

function luminance(hex: string) {
  const value = hex.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(value)) return 0;
  const [r, g, b] = [0, 2, 4].map(index => parseInt(value.slice(index, index + 2), 16) / 255)
    .map(channel => channel <= .03928 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  return .2126 * r + .7152 * g + .0722 * b;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error || new Error('无法读取录音'));
    reader.readAsDataURL(blob);
  });
}

function newRequestId() {
  return `mic-${(crypto as Crypto & { randomUUID?: () => string }).randomUUID?.() || Date.now().toString(36)}`;
}

export default function App() {
  const [state, dispatch] = useReducer(reduceEvent, initialState);
  const [paired, setPaired] = useState<boolean | null>(null);
  const [sessionAvailable, setSessionAvailable] = useState(true);
  const [apkAvailable, setApkAvailable] = useState(false);
  const [token, setToken] = useState('');
  const [pairError, setPairError] = useState('');
  const [pairing, setPairing] = useState(false);
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [memoryText, setMemoryText] = useState('');
  const [text, setText] = useState('');
  const [notice, setNotice] = useState('');
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const markImageFailed = useCallback(() => setImageFailed(true), []);

  const bridgeRef = useRef<MobileBridge | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);
  const stateRef = useRef(state);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingCancelled = useRef(false);
  const holdingMic = useRef(false);
  const holdTimer = useRef<number | undefined>(undefined);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const displayedRef = useRef(new Set<string>());
  const startedRef = useRef(false);
  stateRef.current = state;

  const startSession = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const bridge = new MobileBridge();
    const player = new AudioPlayer(
      receipt => bridge.playback(receipt),
      event => {
        dispatch(event);
        if (event.type === 'error' && event.message) setNotice(String(event.message));
        if (event.type === 'playback.started') {
          const id = String(event.utterance_id || '');
          if (id && !displayedRef.current.has(id)) {
            displayedRef.current.add(id);
            void bridge.send({ type: 'utterance.displayed', utterance_id: id, generation_id: event.generation_id });
          }
        }
      },
    );
    bridgeRef.current = bridge;
    playerRef.current = player;
    bridge.onEvent(event => {
      dispatch(event);
      if (event.type === 'memory.ready' && Array.isArray(event.memories)) setMemoryText(event.memories.join('\n'));
      if (event.type === 'audio.ready') player.enqueue(event);
      if (event.type === 'settings.ready') {
        player.setVolume(Number((event.settings as Record<string, unknown> | undefined)?.volume ?? 1));
      }
      if (event.type === 'generation.cancelled') {
        player.cancel(Number(event.cancelled_generation_id ?? event.generation_id ?? 0));
      }
      if (event.type === 'input.transcribed') {
        setTranscribing(false);
        if (typeof event.text === 'string' && event.text.trim()) {
          setText(event.text.trim());
          requestAnimationFrame(() => textareaRef.current?.focus());
        }
      }
      if (event.type === 'input.state' && event.state === 'failed') {
        setTranscribing(false);
        setNotice('尚未配置语音识别服务，请先使用文字输入。');
      }
      if (event.type === 'error' && event.message) setNotice(String(event.message));
      if (event.type === 'utterance.ready') {
        const asset = String(event.asset_id || '');
        if (asset) preloadAsset(asset);
      }
    });
    bridge.onStatus(status => {
      dispatch({ protocol_version: 1, type: 'bridge.status', connected: status.connected, service: status.service });
      if (status.error) setNotice(status.error);
      if (status.service === 'unauthorized') {
        startedRef.current = false;
        setPaired(false);
        bridge.close();
      }
    });
    bridge.connect();
    void bootstrap().then(setBoot).catch(error => setNotice(String(error)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void sessionState().then(result => {
      if (cancelled) return;
      setSessionAvailable(result.available);
      setApkAvailable(Boolean(result.android_apk));
      setPaired(result.paired);
      if (result.paired) startSession();
    }).catch(error => {
      if (!cancelled) {
        setPaired(false);
        setPairError(String(error));
      }
    });
    return () => {
      cancelled = true;
      bridgeRef.current?.close();      playerRef.current?.dispose();
      bridgeRef.current = null;
      playerRef.current = null;
      startedRef.current = false;
    };
  }, [startSession]);

  useEffect(() => {
    if (!paired) return;
    let released = false;
    void import('@capacitor-community/keep-awake').then(({ KeepAwake }) => {
      if (!released) void KeepAwake.keepAwake().catch(() => {});
    }).catch(() => {});
    return () => {
      released = true;
      void import('@capacitor-community/keep-awake').then(({ KeepAwake }) => KeepAwake.allowSleep()).catch(() => {});
    };
  }, [paired]);

  useEffect(() => {
    const wake = () => {
      const lock = (navigator as Navigator & { wakeLock?: { request?: (type: string) => Promise<unknown> } }).wakeLock;
      void lock?.request?.('screen')?.catch(() => {});
    };
    window.addEventListener('pointerdown', wake, { once: true });
    return () => window.removeEventListener('pointerdown', wake);
  }, []);

  useEffect(() => {
    const online = () => { if (!stateRef.current.connected) bridgeRef.current?.connect(); };
    const visible = () => { if (document.visibilityState === 'visible') bridgeRef.current?.connect(); };
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 8000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [state.history.length, state.speeches.length, state.presented]);

  useEffect(() => {
    if (!paired || state.current) return;
    if (recording || transcribing) return;
    const index = state.speeches.findIndex(speech => speech.id === state.presented);
    const next = state.speeches.slice(index + 1).find(speech => speech.state === 'generated');
    if (!next) return;
    const delay = next.audioEnabled && state.voice !== 'failed' ? 9000 : Math.min(5000, Math.max(700, (next.zh || next.ja).length * 55));
    const timer = window.setTimeout(() => {
      dispatch({ protocol_version: 1, type: 'mobile.present', utterance_id: next.id, generation_id: next.generation });
      if (!displayedRef.current.has(next.id)) {
        displayedRef.current.add(next.id);
        void bridgeRef.current?.send({ type: 'utterance.displayed', utterance_id: next.id, generation_id: next.generation });
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [paired, state.current, state.presented, state.speeches, state.generation, state.voice, recording, transcribing]);

  async function connectWithToken(event: FormEvent) {
    event.preventDefault();
    if (!token.trim() || pairing) return;
    setPairing(true);
    setPairError('');
    try {
      await pair(token.trim());
      setToken('');
      setPaired(true);
      startSession();
    } catch (error) {
      setPairError(String(error instanceof Error ? error.message : error));
    } finally {
      setPairing(false);
    }
  }

  async function ask(question = text) {
    const body = question.trim();
    if (!body) return;
    await playerRef.current?.unlock();
    playerRef.current?.cancel(stateRef.current.generation);
    dispatch({ protocol_version: 1, type: 'mobile.cancelled', cancelled_generation_id: stateRef.current.generation, generation_id: stateRef.current.generation });
    setText('');
    setNotice('');
    const result = await bridgeRef.current?.send({ type: 'turn.start', text: body });
    if (!result?.ok) setNotice(result?.error || '发送失败，请检查连接。');
  }

  function cancel() {
    playerRef.current?.cancel(stateRef.current.generation);
    dispatch({ protocol_version: 1, type: 'mobile.cancelled', cancelled_generation_id: stateRef.current.generation, generation_id: stateRef.current.generation });
    void bridgeRef.current?.send({ type: 'generation.cancel' });
  }

  async function changeConversation(conversationId?: string) {
    playerRef.current?.cancel(stateRef.current.generation);
    dispatch({ protocol_version: 1, type: 'mobile.cancelled', cancelled_generation_id: stateRef.current.generation, generation_id: stateRef.current.generation });
    setDrawer(false);
    const result = await bridgeRef.current?.send(conversationId
      ? { type: 'conversation.select', conversation_id: conversationId }
      : { type: 'conversation.create' });
    if (!result?.ok) setNotice(result?.error || '话题切换失败');
  }

  async function signOut() {
    bridgeRef.current?.close();
    playerRef.current?.dispose();
    bridgeRef.current = null;
    playerRef.current = null;
    startedRef.current = false;
    await logout().catch(() => {});
    window.location.reload();
  }

  function cleanupRecording() {
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
    holdTimer.current = undefined;
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  }

  async function startRecording() {
    if (recording || transcribing) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setNotice('当前浏览器不支持麦克风录音。');
      return;
    }
    await playerRef.current?.unlock();
    if (!holdingMic.current) return;
    setNotice('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
        video: false,
      });
      if (!holdingMic.current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
      const mimeType = candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 64000 } : undefined);
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      recordingCancelled.current = false;
      recorder.ondataavailable = data => { if (data.data.size) chunksRef.current.push(data.data); };
      recorder.onstop = () => {
        const chunks = chunksRef.current;
        const type = recorder.mimeType || mimeType || 'audio/webm';
        const cancelled = recordingCancelled.current;
        cleanupRecording();
        setRecording(false);
        if (cancelled || !chunks.length) return;
        void (async () => {
          setTranscribing(true);
          try {
            const audio = await blobToBase64(new Blob(chunks, { type }));
            const result = await bridgeRef.current?.send({
              type: 'input.audio', request_id: newRequestId(), audio_base64: audio,
              mime_type: type.split(';')[0] || 'audio/webm',
            });
            if (!result?.ok) {
              setTranscribing(false);
              setNotice(result?.error || '语音发送失败');
            }
          } catch (error) {
            setTranscribing(false);
            setNotice(String(error));
          }
        })();
      };
      recorder.start(250);
      setRecording(true);
      if (!holdingMic.current) {
        stopRecording(true);
        return;
      }
      holdTimer.current = window.setTimeout(() => stopRecording(false), 55000);
    } catch (error) {
      cleanupRecording();
      setRecording(false);
      setNotice(`无法使用麦克风：${String(error)}`);
    }
  }

  function stopRecording(cancelled = false) {
    recordingCancelled.current = cancelled;
    const recorder = recorderRef.current;
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
    holdTimer.current = undefined;
    if (!recorder) {
      cleanupRecording();
      setRecording(false);
      return;
    }
    if (recorder.state !== 'inactive') recorder.stop();
    else {
      cleanupRecording();
      setRecording(false);
    }
  }

  function onMicDown(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    holdingMic.current = true;
    void startRecording();
  }

  function onMicUp() {
    holdingMic.current = false;
    stopRecording(false);
  }

  const ui = state.settings.companion_ui || {};
  const theme = themes.find(item => item.id === ui.theme) || themes[0];
  const background = typeof ui.background_color === 'string' ? ui.background_color : theme.background;
  const bubble = typeof ui.bubble_color === 'string' ? ui.bubble_color : theme.bubble;
  const light = luminance(background) > .55;
  const primary = String(ui.primary_language || 'zh');
  const translation = String(ui.translation_language || 'none');
  const activeSpeech = state.speeches.find(speech => speech.id === state.presented);
  const knownDefault = state.defaultAsset && state.defaultAsset !== 'neutral' ? state.defaultAsset : boot?.default_asset_id;
  const expression = activeSpeech?.assetId || knownDefault || state.defaultAsset || 'neutral';
  const presentedIndex = state.speeches.findIndex(speech => speech.id === state.presented);
  const visibleSpeeches = presentedIndex < 0 ? [] : state.speeches.slice(0, presentedIndex + 1);
  const liveIds = new Set(state.speeches.map(speech => speech.id));
  const history = state.history.filter(item => item.role !== 'assistant'
    || (!liveIds.has(String(item.utterance_id || ''))
      && (item.displayed !== false || item.status === 'played' || item.status === 'partial')));
  const textOnly = state.voice === 'failed' || state.settings.voice?.voice_mode === 'silent';
  const busy = Boolean(state.current) || state.task === 'thinking';
  const style = {
    '--bg': background,
    '--bubble': bubble,
    '--ink': light ? '#1f2328' : '#f3efe7',
    '--muted': light ? 'rgba(31,35,40,.62)' : 'rgba(243,239,231,.58)',
    '--line': light ? 'rgba(31,35,40,.14)' : 'rgba(255,255,255,.14)',
    '--accent': light ? '#8a5a2b' : '#e8c48a',
    '--panel': light ? 'rgba(255,255,255,.72)' : 'rgba(20,23,28,.62)',
  } as CSSProperties;

  useEffect(() => { setImageFailed(false); }, [expression, state.character, state.costume]);

  if (paired === null) {
    return (
      <div className="boot-screen" style={style}>
        <img src="icon.png" alt="" className="boot-logo" />
        <p>正在连接 Ayana…</p>
      </div>
    );
  }

  if (!paired) {
    return (
      <main className="pair-screen" style={style}>
        <div className="pair-card">
          <img src="icon.png" alt="" className="pair-logo" />
          <h1>Ayana</h1>
          <p className="pair-lead">粘贴你的 Ayana 激活码，自动连接聊天和语音服务。公网激活码支持手机流量和其他 Wi-Fi，电脑需保持在线。</p>
          {!sessionAvailable && <p className="pair-error">接入服务暂不可用。</p>}
          <form onSubmit={connectWithToken}>
            <label htmlFor="mobile-token">激活码</label>
            <input id="mobile-token" value={token} onChange={event => setToken(event.target.value)}
                   type="password" placeholder="ayana1.…" autoComplete="off" spellCheck={false} />
            <button type="submit" disabled={!token.trim() || pairing}>
              {pairing ? '正在激活…' : '激活并进入'}
            </button>
          </form>
          {pairError && <p className="pair-error" role="alert">{pairError}</p>}
          <p className="pair-hint">对话将同步到服务提供者的电脑，用于语音生成和问题排查。立绘、字幕和播放由本机处理。</p>
        </div>
      </main>
    );
  }

  return (
    <main className={`app ${light ? 'is-light' : ''}`} style={style}>
      <header className="topbar">
        <button className="icon-button" type="button" aria-label="打开菜单" onClick={() => setDrawer(true)}>
          <span className="menu-glyph" />
        </button>
        <div className="topbar-title">
          <strong>{state.conversation?.title || 'Ayana'}</strong>
          <span><i className={`status-dot ${state.connected ? 'is-on' : ''}`} />{state.connected ? (state.voice === 'failed' ? '文字模式' : '已连接') : '连接中…'}</span>
        </div>
        {busy
          ? <button className="icon-button stop-button" type="button" aria-label="打断" onClick={cancel}>■</button>
          : <img className="topbar-logo" src="icon.png" alt="" />}
      </header>

      {!state.connected && <div className="connection-banner">网关暂未连接，本地话题和立绘仍可使用。</div>}
      {notice && <div className="toast" role="alert">{notice}<button type="button" onClick={() => setNotice('')} aria-label="关闭">×</button></div>}

      <section className="stage" aria-label="彩名">
        {!imageFailed
          ? <AssetImage key={`${state.character}:${state.costume}:${expression}`} assetId={expression} className="portrait" alt="彩名" onError={markImageFailed} />
          : <div className="portrait-fallback"><img src="icon.png" alt="" /><span>彩名</span></div>}
        <div className="stage-glow" aria-hidden="true" />
      </section>

      <section className="transcript" aria-live="polite">
        <div className="transcript-inner">
          {!history.length && !visibleSpeeches.length && (
            <div className="empty-state">
              <p>{state.settings.user_name ? `${state.settings.user_name}，` : ''}今天想聊点什么？</p>
              <small>输入文字，彩名会用声音回复。</small>
            </div>
          )}
          {history.map((item, index) => item.role === 'user' ? (
            <div className="message user" key={`u-${item.id ?? index}`}><p>{item.text}</p></div>
          ) : (
            <div className="message assistant" key={`a-${item.id ?? index}`}>
              <p>{item.display_zh || item.speech_ja}</p>
              {item.display_en && <p className="message-secondary" lang="en">{item.display_en}</p>}
            </div>
          ))}
          {visibleSpeeches.map(speech => (
            <SpeechLine key={speech.id} speech={speech} active={speech.id === state.presented}
                        primary={primary} translation={translation} />
          ))}
          {state.task === 'thinking' && (
            <div className="thinking" role="status"><span /><span /><span /><em>正在想…</em></div>
          )}
          {state.sources.length > 0 && (
            <div className="sources">
              <small>来源</small>
              {state.sources.map((source, index) => {
                const url = typeof source.url === 'string' ? source.url : '';
                const title = typeof source.title === 'string' ? source.title : url;
                return url ? <a key={index} href={url} target="_blank" rel="noreferrer">{title}</a> : null;
              })}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </section>

      <footer className="composer">
        <textarea ref={textareaRef} value={text} rows={1} maxLength={4000}
                  placeholder={transcribing ? '正在识别…' : textOnly ? '说点什么…' : '和彩名说点什么…'}
                  onChange={event => setText(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      void ask();
                    }
                  }} />
        <button className={`mic-button ${recording ? 'is-recording' : ''} ${transcribing ? 'is-busy' : ''}`}
                type="button" disabled title="尚未配置语音识别，请使用文字输入" aria-label="语音识别尚未配置"
                onPointerDown={onMicDown} onPointerUp={onMicUp}
                onPointerCancel={() => { holdingMic.current = false; stopRecording(true); }}
                onContextMenu={event => event.preventDefault()}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
               strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
          </svg>
        </button>
        <button className="send-button" type="button" disabled={!text.trim() || !state.connected}
                onClick={() => void ask()} aria-label="发送">↑</button>
      </footer>

      {drawer && (
        <div className="drawer-backdrop" onClick={() => setDrawer(false)}>
          <aside className="drawer" onClick={event => event.stopPropagation()} style={style}>
            <header>
              <strong>Ayana</strong>
              <button className="icon-button" type="button" onClick={() => setDrawer(false)} aria-label="关闭">×</button>
            </header>
            <div className="drawer-status">
              <span><i className={`status-dot ${state.connected ? 'is-on' : ''}`} />{state.connected ? '已连接' : '未连接'}</span>
              <span>{boot?.version || ''}</span>
            </div>
            <section>
              <h2>话题</h2>
              <div className="conversation-list">
                {state.conversations.map(item => (
                  <button key={item.conversation_id} type="button"
                          className={item.conversation_id === state.conversation?.conversation_id ? 'is-current' : ''}
                          onClick={() => void changeConversation(item.conversation_id)}>
                    <strong>{item.title}</strong>
                    <small>{item.preview || '还没有消息'}</small>
                  </button>
                ))}
                <button type="button" className="new-conversation" onClick={() => void changeConversation()}>＋ 新的对话</button>
              </div>
            </section>
            <section className="drawer-actions">
              <label>角色
                <select value={String(state.settings.character || 'ayana')} onChange={event => {
                  assetCache.forEach(url => URL.revokeObjectURL(url)); assetCache.clear();
                  void bridgeRef.current?.send({ type: 'settings.update', settings: { character: event.target.value,
                    avatar_costume: event.target.value === 'ayana-su' ? '白色校服' : '校服' } });
                }}>{characterOptions().map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
              </label>
              <label>服装
                <select value={String(state.settings.avatar_costume || '校服')} onChange={event => {
                  void bridgeRef.current?.send({ type: 'settings.update', settings: { avatar_costume: event.target.value } });
                }}>{costumes().map(item => <option key={item}>{item}</option>)}</select>
              </label>
              <label>称呼
                <input maxLength={32} defaultValue={String(state.settings.user_name || '')} placeholder="希望彩名称呼你的名字"
                  onBlur={event => void bridgeRef.current?.send({ type: 'settings.update', settings: { user_name: event.target.value.trim() } })} />
              </label>
              <label>音量
                <input type="range" min="0" max="1" step="0.05" value={Number(state.settings.volume ?? 1)}
                  onChange={event => void bridgeRef.current?.send({ type: 'settings.update', settings: { volume: Number(event.target.value) } })} />
              </label>
              <label>本机记忆（每行一条）
                <textarea rows={3} maxLength={15000} value={memoryText} onChange={event => setMemoryText(event.target.value)}
                  onBlur={() => void bridgeRef.current?.send({ type: 'memory.set', text: memoryText })} />
              </label>
              <button type="button" onClick={() => { bridgeRef.current?.reconnect(); setDrawer(false); }}>重新连接</button>
              <button type="button" onClick={() => void signOut()}>退出激活（保留本地历史）</button>
            </section>
            <p className="drawer-hint">语音状态：{state.voice === 'ready' ? '可用' : state.voice === 'failed' ? '不可用（文字模式）' : state.voice}
              <br />服务器：{serverLabel()}</p>
          </aside>
        </div>
      )}
    </main>
  );
}
