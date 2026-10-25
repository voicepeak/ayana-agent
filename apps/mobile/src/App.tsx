import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { bootstrap, fetchAsset, logout, pair, sessionState } from './api';
import { assetUrl } from './character';
import { AudioPlayer } from './audio';
import { MobileBridge } from './bridge';
import { SpeechLine, textFor } from './SpeechLine';
import { SettingsDrawer, themes } from './SettingsDrawer';
import { useDraft } from './useDraft';
import { usePlaybackWake } from './usePlaybackWake';
import { Capacitor } from '@capacitor/core';
import { useMobileViewport } from './useMobileViewport';
import { initialState, reduceEvent } from './state';
import type { Bootstrap } from './types';
import { FloatingCompanion } from './FloatingCompanion';
import { useCompanion } from './useCompanion';
import { NativeCompanion, nativeIOS } from './companionNative';

const assetCache = new Map<string, string>();
const loadingAssets = new Map<string, Promise<string>>();

function loadAsset(assetId: string): Promise<string> {
  const resource = assetUrl(assetId);
  const cached = assetCache.get(resource);
  if (cached) return Promise.resolve(cached);
  const loading = loadingAssets.get(resource);
  if (loading) return loading;
  const pending = fetchAsset(assetId).then(blob => {
    const url = URL.createObjectURL(blob);
    assetCache.set(resource, url);
    if (assetCache.size > 240) {
      const oldest = assetCache.keys().next().value;
      if (oldest) {
        const stale = assetCache.get(oldest);
        assetCache.delete(oldest);
        if (stale) window.setTimeout(() => URL.revokeObjectURL(stale), 30000);
      }
    }
    return url;
  }).finally(() => loadingAssets.delete(resource));
  loadingAssets.set(resource, pending);
  return pending;
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
    const cached = assetCache.get(resource);
    if (cached) setSrc(cached);
    loadAsset(assetId).then(url => {
      if (active) setSrc(url);
    }).catch(() => {
      if (active) onError();
    });
    return () => { active = false; };
  }, [assetId, resource, onError]);
  return src ? <img className={className} src={src} alt={alt} draggable={false} onError={onError} /> : null;
}

function luminance(hex: string) {
  const value = hex.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(value)) return 0;
  const [r, g, b] = [0, 2, 4].map(index => parseInt(value.slice(index, index + 2), 16) / 255)
    .map(channel => channel <= .03928 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  return .2126 * r + .7152 * g + .0722 * b;
}

export default function App() {
  const [state, dispatch] = useReducer(reduceEvent, initialState);
  const [paired, setPaired] = useState<boolean | null>(null);
  const [token, setToken] = useState('');
  const [pairError, setPairError] = useState('');
  const [pairing, setPairing] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [memoryText, setMemoryText] = useState('');
  const [text, setText] = useDraft(state.conversation?.conversation_id);
  const [notice, setNotice] = useState('');
  const companion = useCompanion(cancel, error => setNotice(error instanceof Error ? error.message : String((error as { message?: string })?.message || error)));
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const switchingRef = useRef(false);
  const transcriptRef = useRef<HTMLElement>(null);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  useMobileViewport();
  const [imageFailed, setImageFailed] = useState(false);
  const markImageFailed = useCallback(() => setImageFailed(true), []);

  const bridgeRef = useRef<MobileBridge | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);
  const stateRef = useRef(state);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
      if (event.type === 'audio.ready') {
        const speech = stateRef.current.speeches.find(item => item.id === event.utterance_id);
        if (stateRef.current.settings.voice?.voice_mode === 'silent' || speech?.state === 'played') {
          bridge.consumeAudio(event.utterance_id);
        } else player.enqueue(event);
      }
      if (event.type === 'settings.ready') {
        player.setVolume(Number((event.settings as Record<string, unknown> | undefined)?.volume ?? 1));
      }
      if (event.type === 'generation.cancelled') {
        player.cancel(Number(event.cancelled_generation_id ?? event.generation_id ?? 0));
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
        setPairError(status.error || '激活凭据失效，请重新激活');
        player.dispose();
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
      bridgeRef.current?.close();
      playerRef.current?.dispose();
      bridgeRef.current = null;
      playerRef.current = null;
      startedRef.current = false;
    };
  }, [startSession]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const listener = import('@capacitor/app').then(({ App }) => App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) bridgeRef.current?.resume();
    }));
    return () => { void listener.then(handle => handle.remove()); };
  }, []);

  useEffect(() => {
    const online = () => { bridgeRef.current?.resume(); };
    const offline = () => bridgeRef.current?.offline();
    const visible = () => { if (document.visibilityState === 'visible') bridgeRef.current?.resume(); };
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 8000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function scrollLatest(smooth = true) {
    const element = transcriptRef.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant' });
  }
  useEffect(() => { if (atBottomRef.current) scrollLatest(false); }, [state.history, state.speeches.length, state.presented]);
  useEffect(() => {
    atBottomRef.current = true; setAtBottom(true);
    requestAnimationFrame(() => scrollLatest(false));
  }, [state.conversation?.conversation_id]);
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(132, element.scrollHeight)}px`;
  }, [text, paired]);

  useEffect(() => {
    if (!paired || state.current || nativeIOS) return;
    const next = state.speeches.find(speech => speech.state === 'generated');
    if (!next) return;
    const delay = next.audioEnabled && state.voice !== 'failed' && state.settings.voice?.voice_mode !== 'silent' ? 9000 : Math.min(5000, Math.max(700, (next.zh || next.ja).length * 55));
    const timer = window.setTimeout(() => {
      dispatch({ protocol_version: 1, type: 'mobile.present', utterance_id: next.id, generation_id: next.generation });
      bridgeRef.current?.playback({ protocol_version: 1, type: 'playback.ended', utterance_id: next.id, generation_id: next.generation, played_samples: 0, total_samples: 0 });
      if (!displayedRef.current.has(next.id)) {
        displayedRef.current.add(next.id);
        void bridgeRef.current?.send({ type: 'utterance.displayed', utterance_id: next.id, generation_id: next.generation });
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [paired, state.current, state.presented, state.speeches, state.generation, state.voice, state.settings.voice?.voice_mode]);

  async function connectWithToken(event: FormEvent) {
    event.preventDefault();
    if (!token.trim() || pairing) return;
    setPairing(true);
    setPairError('');
    try {
      await pair(token.trim());
      setToken('');
      dispatch({ protocol_version: 1, type: 'mobile.reset' });
      displayedRef.current.clear();
      setPaired(true);
      startSession();
    } catch (error) {
      setPairError(String(error instanceof Error ? error.message : error));
    } finally {
      setPairing(false);
    }
  }

  async function sendCommand(command: Record<string, unknown> & { type: string }) {
    const result = await bridgeRef.current?.send(command);
    if (!result?.ok) setNotice(result?.error || '操作失败，请重试');
    return Boolean(result?.ok);
  }
  async function ask(question = text) {
    const body = question.trim();
    if (!body || sendingRef.current || switchingRef.current) return;
    if (!stateRef.current.connected) { setNotice('连接恢复后即可发送，草稿已保留。'); return; }
    sendingRef.current = true; setSending(true); setNotice('');
    atBottomRef.current = true; setAtBottom(true);
    if (!nativeIOS) void playerRef.current?.unlock().catch(() => setNotice('声音暂不可用，本轮将显示文字。'));
    playerRef.current?.cancel(stateRef.current.generation);
    try {
      const ok = await sendCommand({ type: 'turn.start', text: body });
      if (ok) setText(current => current.trim() === body ? '' : current);
    } finally { sendingRef.current = false; setSending(false); }
  }
  function cancel() { void sendCommand({ type: 'generation.cancel' }); }
  async function changeConversation(conversationId?: string) {
    if (switchingRef.current || sendingRef.current) return;
    if (conversationId === state.conversation?.conversation_id) { setDrawer(false); return; }
    switchingRef.current = true;
    try {
      const ok = await sendCommand(conversationId ? { type: 'conversation.select', conversation_id: conversationId } : { type: 'conversation.create' });
      if (ok) setDrawer(false);
    } finally { switchingRef.current = false; }
  }

  async function signOut() {
    await companion.stop(true);
    bridgeRef.current?.close();
    playerRef.current?.dispose();
    bridgeRef.current = null;
    playerRef.current = null;
    startedRef.current = false;
    await logout().catch(() => {});
    setDrawer(false); setPaired(false); setText('');
    dispatch({ protocol_version: 1, type: 'mobile.reset' });
  }

  const ui = state.settings.companion_ui || {};
  const theme = themes.find(item => item.id === ui.theme) || themes[0];
  const background = /^#[0-9a-f]{6}$/i.test(String(ui.background_color)) ? String(ui.background_color) : theme.background;
  const bubble = /^#[0-9a-f]{6}$/i.test(String(ui.bubble_color)) ? String(ui.bubble_color) : theme.bubble;
  const light = luminance(background) > .55;
  const primary = String(ui.primary_language || 'zh');
  const translation = String(ui.translation_language || 'none');
  const activeSpeech = state.speeches.find(speech => speech.id === state.presented);
  const knownDefault = state.defaultAsset && state.defaultAsset !== 'neutral' ? state.defaultAsset : boot?.default_asset_id;
  const expression = activeSpeech?.assetId || knownDefault || state.defaultAsset || 'neutral';
  const speechMap = new Map(state.speeches.map(speech => [speech.id, speech]));
  const history = state.history.filter(item => {
    if (item.role === 'user') return true;
    const speech = speechMap.get(String(item.utterance_id || ''));
    return speech ? ['playing', 'played', 'partial'].includes(speech.state)
      : item.displayed !== false && item.status !== 'cancelled';
  });
  const textOnly = state.voice === 'failed' || state.settings.voice?.voice_mode === 'silent';
  const busy = Boolean(state.current) || state.task === 'thinking' || state.speeches.some(item => item.state === 'generated');
  usePlaybackWake(busy && paired === true);
  const style = {
    '--bg': background,
    '--bubble': bubble,
    '--bubble-ink': luminance(bubble) > .4 ? '#252a2b' : '#f3efe7',
    '--ink': light ? '#1f2328' : '#f3efe7',
    '--muted': light ? 'rgba(31,35,40,.68)' : 'rgba(243,239,231,.68)',
    '--line': light ? 'rgba(31,35,40,.14)' : 'rgba(255,255,255,.14)',
    '--accent': light ? '#8a5a2b' : '#e8c48a',
    '--panel': light ? 'rgba(255,251,243,.92)' : 'rgba(27,30,35,.91)',
  } as CSSProperties;

  useEffect(() => { setImageFailed(false); }, [expression, state.character, state.costume]);
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !paired) return;
    const text = activeSpeech ? textFor(activeSpeech, primary) : '我在这里。';
    void NativeCompanion.present({ assetFile: new URL(assetUrl(expression)).pathname.replace(/^\//, ''),
      text, primary, translation, character: state.character, costume: state.costume,
      background, ink: light ? '#1f2328' : '#f3efe7', accent: light ? '#8a5a2b' : '#e8c48a',
      volume: Number(state.settings.volume ?? 1), silent: state.settings.voice?.voice_mode === 'silent' }).catch(() => {});
  }, [paired, expression, primary, translation, background, light, state.character, state.costume,
      state.settings.volume, state.settings.voice?.voice_mode, activeSpeech?.zh, activeSpeech?.ja]);

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
          <span className="eyebrow">YOUR EVERYDAY COMPANION</span>
          <img src="icon.png" alt="" className="pair-logo" />
          <h1>Ayana</h1>
          <p className="pair-lead">把今天的故事，说给彩名听。<br />粘贴激活码，开始你们的对话。</p>
          <form onSubmit={connectWithToken} aria-busy={pairing}>
            <label htmlFor="mobile-token">激活码</label>
            <div className="token-field"><input id="mobile-token" value={token} onChange={event => setToken(event.target.value)}
                   type={showToken ? 'text' : 'password'} placeholder="ayana1.…" autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={pairing} aria-describedby={pairError ? 'pair-error' : 'pair-help'} />
              <button type="button" className="token-toggle" aria-label={showToken ? '隐藏激活码' : '显示激活码'} onClick={() => setShowToken(value => !value)}>{showToken ? '隐藏' : '显示'}</button></div>
            <button type="submit" disabled={!token.trim() || pairing}>
              {pairing ? '正在激活…' : '激活并进入'}
            </button>
          </form>
          {pairError && <p id="pair-error" className="pair-error" role="alert">{pairError}</p>}
          <p id="pair-help" className="pair-help">使用电脑生成的完整激活码。公网地址支持手机流量和其他 Wi-Fi，电脑服务需保持在线。</p>
          <p className="pair-hint">对话将同步到服务提供者的电脑，用于语音生成和问题排查。立绘、字幕和播放由本机处理。</p>
        </div>
      </main>
    );
  }

  if (companion.floating) return <FloatingCompanion state={state} style={style}
    portrait={<AssetImage assetId={expression} className="portrait" alt="彩名" onError={markImageFailed} />}
    collapsed={companion.status.collapsed} text={text} notice={notice} sending={sending}
    onText={setText} onSend={() => void ask()} onCancel={cancel}
    onCollapse={value => void companion.collapse(value)} onRestore={() => void companion.stop(true)} onClose={() => void companion.stop(false)}
    onError={error => setNotice(error instanceof Error ? error.message : '悬浮窗操作失败，请重试')} />;

  return (
    <main className={`app ${light ? 'is-light' : ''}`} style={style}>
      <header className="topbar" inert={drawer}>
        <button className="icon-button" type="button" aria-label="打开菜单" aria-expanded={drawer} aria-controls="mobile-drawer" onClick={() => setDrawer(true)}>
          <span className="menu-glyph" />
        </button>
        <div className="topbar-title">
          <strong>{state.conversation?.title || 'Ayana'}</strong>
          <span><i className={`status-dot ${state.connected ? 'is-on' : ''}`} />{state.connected ? (textOnly ? '文字模式' : '已连接 · 语音陪伴') : state.service === 'offline' ? '暂时离线 · 草稿已保留' : '连接中…'}</span>
        </div>
        {busy
          ? <button className="icon-button stop-button" type="button" aria-label="打断" onClick={cancel}><span /></button>
          : <img className="topbar-logo" src="icon.png" alt="" />}
      </header>

      {!state.connected && <div className="connection-banner" role="status" inert={drawer}><span>本地话题与设置可继续使用</span><button type="button" onClick={() => bridgeRef.current?.reconnect()}>重试连接</button></div>}
      {notice && <div className="toast" role="alert">{notice}<button type="button" onClick={() => setNotice('')} aria-label="关闭">×</button></div>}

      <section className="stage" aria-label="彩名">
        {!imageFailed
          ? <AssetImage assetId={expression} className="portrait" alt="彩名" onError={markImageFailed} />
          : <div className="portrait-fallback"><img src="icon.png" alt="" /><span>彩名</span></div>}
        <div className="stage-glow" aria-hidden="true" />
      </section>

      <section className="transcript" ref={transcriptRef} aria-label="对话记录" inert={drawer} onScroll={() => {
        const element = transcriptRef.current!;
        const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 70;
        atBottomRef.current = bottom; setAtBottom(bottom);
      }}>
        <div className="transcript-inner">
          {!history.length && (
            <div className="empty-state"><span className="eyebrow">A LITTLE MOMENT, TOGETHER</span>
              <p>{state.settings.user_name ? `${state.settings.user_name}，` : ''}今天想聊点什么？</p>
              <small>你的日常、心事，或是一个突如其来的想法。</small><div className="starter-list">{['今天有点累，陪我聊聊。', '和我分享一件开心的小事吧。'].map(value => <button type="button" key={value} onClick={() => { setText(value); textareaRef.current?.focus(); }}>{value}<span>↗</span></button>)}</div>
            </div>
          )}
          {history.map((item, index) => {
            const speech = speechMap.get(String(item.utterance_id || ''));
            if (speech) return <SpeechLine key={speech.id} speech={speech} active={speech.id === state.presented} primary={primary} translation={translation} />;
            if (item.role === 'user') return <div className="message user" key={`u-${item.turn_id || index}`}><span className="message-label">你</span><p>{item.text}</p></div>;
            const content = { ja: item.speech_ja || '', zh: item.display_zh || item.text || '', en: item.display_en };
            const main = textFor(content, primary);
            const secondary = translation !== 'none' && translation !== primary ? textFor(content, translation) : '';
            return <div className="message assistant" key={`a-${item.utterance_id || index}`}><p lang={primary}>{main}</p>{secondary && secondary !== main && <p className="message-secondary" lang={translation}>{secondary}</p>}{item.status === 'partial' && <small className="speech-interrupted">已打断</small>}</div>;
          })}
          {state.task === 'failed' && <div className="turn-failed" role="status">这次回复未能完成，可以重新发送或稍后再聊。</div>}
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
        </div>
      </section>

      {!atBottom && <button className="jump-latest" type="button" onClick={() => { atBottomRef.current = true; setAtBottom(true); scrollLatest(); }}>↓ 回到最新</button>}
      <footer className="composer-area" inert={drawer}><div className="composer">
        <textarea ref={textareaRef} value={text} rows={1} maxLength={4000} aria-label="消息"
                  placeholder={!state.connected ? '先写下来，连接后发送…' : '和彩名说点什么…'}
                  onChange={event => setText(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void ask();
                    }
                  }} />
        <button className="mic-button"
                type="button" disabled title="尚未配置语音识别，请使用文字输入" aria-label="语音识别尚未配置"
                onContextMenu={event => event.preventDefault()}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
               strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
          </svg>
        </button>
        <button className="send-button" type="button" disabled={!text.trim() || !state.connected || sending}
                onClick={() => void ask()} aria-label="发送">{sending ? '·' : '↑'}</button>
        </div><div className="composer-hint"><span>{textOnly ? '文字陪伴' : '语音回复'} · {busy ? '可随时打断，或发送新消息' : '语音输入暂未开放'}</span>{text.length > 3200 && <span>{text.length} / 4000</span>}</div>
      </footer>

      {drawer && <SettingsDrawer state={state} memoryText={memoryText} version={boot?.version || '0.2.0'}
        onClose={() => setDrawer(false)} onCommand={sendCommand} onConversation={changeConversation}
        onCancel={cancel} onReconnect={() => bridgeRef.current?.reconnect()} onSignOut={signOut}
        onExport={() => bridgeRef.current!.exportConversation()} companion={companion}
        onCompanion={() => { setDrawer(false); void companion.start(); }} />}

    </main>
  );
}
