import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import script from '../../../config/welcome-script.json';
import timings from '../../../config/welcome-timeline.json';
import { bridge, useRuntime } from './state';
import { savePreferences } from './preferences';
import { activeCatalog } from './avatarCatalogs';
import { outfitAsset } from './avatarOutfit';
import { themes } from './companionThemes';
import { Icon } from './components';
import './welcome.css';

type Chapter = 'meet' | 'chat' | 'voice' | 'search' | 'observe' | 'style' | 'ready';
type MeetPhase = 'name' | 'greeting';
type ChatPhase = 'compose' | 'sent';
type VoicePhase = 'idle' | 'holding' | 'released';
type SearchPhase = 'query' | 'results' | 'source';
type ClipKey = keyof typeof timings;

const chapterOrder: Chapter[] = ['meet', 'chat', 'voice', 'search', 'observe', 'style', 'ready'];
const chapterLabels: Record<Chapter, string> = { meet: '见面', chat: '聊天', voice: '语音', search: '搜索', observe: '观察', style: '外观', ready: '出发' };
const chapterClips: Record<Chapter, ClipKey> = { meet: 'arrival', chat: 'chat', voice: 'voice', search: 'search', observe: 'observe', style: 'style', ready: 'ready' };
const themeAccents: Record<string, string> = { ink: '#d8bd8a', paper: '#e7dcc6', forest: '#b7d2b4', sea: '#b9d6e8' };
const loaderDurations: Record<Chapter, number> = { meet: 1600, chat: 2200, voice: 2400, search: 2200, observe: 2400, style: 2200, ready: 2000 };
const loaderLabels: Record<Chapter, string> = { meet: '正在显影', chat: '正在排版对话', voice: '正在校准声音', search: '正在整理来源', observe: '正在连接屏幕', style: '正在调色', ready: '正在准备桌面' };
const subcopy: Partial<Record<Chapter, string>> = { chat: '写下来，交给她。', voice: '松开，文字就绪。', search: '答案和来源，都在这里。', observe: '随时可以关掉。', style: '颜色，也是相处的一部分。', ready: '随时叫我。' };
const searchResults = [
  { title: '为什么下雨后，空气会变清新？', source: '气象小站' },
  { title: 'Petrichor：雨后的气味', source: '维基百科' },
  { title: '雨的味道，从哪里来？', source: '科学松鼠会' },
];
const waveBars = Array.from({ length: 28 }, (_, index) => ({ h: 18 + ((index * 37) % 46), d: (index * 53) % 420 }));
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function displayKeys(value: string) {
  return value.replace('CommandOrControl', 'Ctrl').replace('Control', 'Ctrl').split('+').map(key => key.trim()).filter(Boolean);
}

function matchesHotkey(event: KeyboardEvent, combo: string) {
  const parts = combo.split('+').map(part => part.trim()).filter(Boolean);
  const key = (parts[parts.length - 1] || '').toLowerCase();
  const ctrl = parts.some(part => /^(control|commandorcontrol|ctrl)$/i.test(part));
  const shift = parts.some(part => /^shift$/i.test(part));
  const alt = parts.some(part => /^alt$/i.test(part));
  const meta = parts.some(part => /^(meta|command|cmd)$/i.test(part));
  if (event.ctrlKey !== ctrl || event.shiftKey !== shift || event.altKey !== alt || event.metaKey !== meta) return false;
  if (key === 'space') return event.code === 'Space' || event.key === ' ';
  if (key.length === 1) return event.key.toLowerCase() === key;
  return event.key.toLowerCase() === key;
}

function Title({ text, long = false, className = '' }: { text: string; long?: boolean; className?: string }) {
  return <h2 className={`mg-title ${className}`} data-long={long || undefined}>{[...text].map((char, index) => (
    <span key={`${char}-${index}`} style={{ '--i': index } as CSSProperties}>{char}</span>
  ))}</h2>;
}

function KeyCaps({ keys, big = false }: { keys: string[]; big?: boolean }) {
  return <div className={`mg-keys${big ? ' mg-keys-big' : ''}`}>{keys.map((key, index) => (
    <kbd key={`${key}-${index}`} style={{ '--i': index } as CSSProperties}>{key}</kbd>
  ))}</div>;
}

function WaveBars() {
  return <span className="mg-wave" aria-hidden="true">{waveBars.map((bar, index) => (
    <i key={index} style={{ '--h': bar.h, '--d': bar.d } as CSSProperties}/>
  ))}</span>;
}

export function Welcome() {
  const { state } = useRuntime(false);
  const [chapter, setChapter] = useState<Chapter>('meet');
  const [meetPhase, setMeetPhase] = useState<MeetPhase>('name');
  const [chatPhase, setChatPhase] = useState<ChatPhase>('compose');
  const [reply, setReply] = useState(false);
  const [typing, setTyping] = useState(false);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>('idle');
  const [voiceText, setVoiceText] = useState('彩名，今天一起去散步吧。');
  const [searchPhase, setSearchPhase] = useState<SearchPhase>('query');
  const [source, setSource] = useState(0);
  const [attention, setAttention] = useState(false);
  const [theme, setTheme] = useState('ink');
  const [themeChanged, setThemeChanged] = useState(false);
  const [wash, setWash] = useState<{ id: string; x: number; y: number } | null>(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [sceneExiting, setSceneExiting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [audioError, setAudioError] = useState(false);
  const [muted, setMuted] = useState(false);
  const [active, setActive] = useState(true);
  const [replay, setReplay] = useState(false);
  const [skip, setSkip] = useState(false);
  const [run, setRun] = useState(0);
  const [caption, setCaption] = useState(timings.arrival.segments[0].zh);
  const [loaded, setLoaded] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);
  const styleNote = useRef<HTMLDivElement>(null);
  const loaderRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const clipRef = useRef<ClipKey>('arrival');
  const playToken = useRef(0);
  const moving = useRef(false);
  const holding = useRef(false);
  const initialized = useRef(false);
  const shouldPlay = useRef(false);
  const replyTimer = useRef<number | undefined>(undefined);
  const washTimer = useRef<number | undefined>(undefined);
  const chapterIndex = chapterOrder.indexOf(chapter);
  const selectedTheme = themes.find(item => item.id === theme) || themes[0];
  const accent = themeAccents[selectedTheme.id] || '#9ab7ff';
  const summonKeys = displayKeys(String(state.settings.hotkey || 'Ctrl+Alt+A'));
  const talkKeys = displayKeys(String(state.settings.talk_hotkey || 'Ctrl+Shift+Space'));
  const portraitExpression = outfitAsset(
    script[meetPhase === 'greeting' ? 'greeting' : 'arrival'].expression,
    String(state.settings.avatar_costume || '校服'),
    activeCatalog(state.settings),
  );
  const canSave = state.connected && state.settingsLoaded && !saving && !leaving && !transitioning && !loading;
  const canContinue = !loading && (chapter === 'meet' ? meetPhase === 'greeting'
    : chapter === 'chat' ? reply
    : chapter === 'voice' ? voicePhase === 'released'
    : chapter === 'search' ? searchPhase === 'source'
    : chapter === 'observe' || chapter === 'style' ? true
    : chapter === 'ready');
  const connection = !state.connected || !state.settingsLoaded ? '正在连接…' : '';
  const status = connection || (chapter === 'meet' && meetPhase === 'name' ? '' : error) || (audioError ? '讲解声音未播放' : '');
  const hint = loading ? '正在准备…' : status || interactionHint();

  function interactionHint() {
    if (chapter === 'meet') return meetPhase === 'name' ? '输入称呼，按 Enter' : '记住这个名字';
    if (chapter === 'chat') return chatPhase === 'compose' ? '点击箭头，发送这句话' : reply ? '这就是她的回答' : '她正在想…';
    if (chapter === 'voice') return voicePhase === 'idle' ? '按住快捷键，或按住这里' : voicePhase === 'holding' ? '正在听…松开结束' : '识别结果可以修改';
    if (chapter === 'search') return searchPhase === 'query' ? '点一下问题，看看答案' : searchPhase === 'results' ? '点开一个来源' : '来源一直都在';
    if (chapter === 'observe') return attention ? '偶尔看看，也可以随时关掉' : '看与不看，你决定';
    if (chapter === 'style') return themeChanged ? '颜色变了，气氛也变了' : '选一个你喜欢的颜色';
    return '记住这组键，然后进入桌面';
  }

  function playClip(clip: ClipKey, index = 0) {
    const audio = audioRef.current;
    if (!audio) return;
    const timing = timings[clip];
    const segment = timing.segments[Math.min(Math.max(index, 0), timing.segments.length - 1)];
    clipRef.current = clip;
    shouldPlay.current = true;
    setCaption(segment.zh);
    setAudioError(false);
    const token = ++playToken.current;
    if (audio.dataset.clip !== clip) {
      audio.dataset.clip = clip;
      let started = false;
      const begin = () => {
        if (started || token !== playToken.current) return;
        started = true;
        try { audio.currentTime = segment.start; } catch { /* Metadata is not ready yet. */ }
        void audio.play().catch(() => { /* A first gesture retries this. */ });
      };
      audio.addEventListener('loadedmetadata', begin, { once: true });
      audio.src = `./welcome/${clip}.wav`;
      audio.load();
      if (audio.readyState >= 1) begin();
    } else {
      try { audio.currentTime = segment.start; } catch { /* Ignore seek races. */ }
      void audio.play().catch(() => { /* A first gesture retries this. */ });
    }
  }

  useEffect(() => {
    const audio = new Audio();
    audio.preload = 'auto';
    audio.volume = Math.max(0, Math.min(1, Number(state.settings.volume ?? 1)));
    audio.muted = muted;
    const time = () => {
      const timing = timings[clipRef.current];
      const segment = timing.segments.find(item => audio.currentTime < item.until) || timing.segments[timing.segments.length - 1];
      setCaption(segment.zh);
    };
    const fail = () => setAudioError(true);
    audio.addEventListener('timeupdate', time);
    audio.addEventListener('error', fail);
    audioRef.current = audio;
    return () => {
      audio.pause();
      audio.removeEventListener('timeupdate', time);
      audio.removeEventListener('error', fail);
      audio.removeAttribute('src');
      audio.load();
      audioRef.current = null;
    };
  }, []);
  useEffect(() => { if (audioRef.current) audioRef.current.muted = muted; }, [muted]);
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = Math.max(0, Math.min(1, Number(state.settings.volume ?? 1)));
  }, [state.settings.volume]);
  useEffect(() => {
    const unlock = () => {
      const audio = audioRef.current;
      if (!audio || !shouldPlay.current) return;
      if (audio.paused) void audio.play().catch(() => { /* Keep the guide usable without sound. */ });
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    return () => {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
  }, []);
  useEffect(() => {
    document.documentElement.classList.add('welcome-root');
    void bridge.getState().then(snapshot => { setReplay(Boolean(snapshot.welcomeReplay)); setRun(snapshot.welcomeRun || 0); });
    const off = bridge.onEvent(event => {
      if (event.type === 'desktop.welcome-hidden') { setActive(false); shouldPlay.current = false; audioRef.current?.pause(); }
      if (event.type === 'desktop.welcome-open') {
        initialized.current = false;
        moving.current = false;
        holding.current = false;
        shouldPlay.current = false;
        setChapter('meet'); setMeetPhase('name'); setChatPhase('compose'); setReply(false); setTyping(false);
        setVoicePhase('idle'); setVoiceText('彩名，今天一起去散步吧。');
        setSearchPhase('query'); setSource(0); setWash(null); setThemeChanged(false);
        setSaving(false); setLeaving(false); setTransitioning(false); setSceneExiting(false); setLoading(true); setError(''); setSkip(false); setActive(true);
        setCaption(timings.arrival.segments[0].zh);
        setReplay(event.replay === true); setRun(Number(event.run));
      }
    });
    return () => {
      off();
      document.documentElement.classList.remove('welcome-root');
      audioRef.current?.pause();
    };
  }, []);
  useEffect(() => {
    if (!state.settingsLoaded || initialized.current) return;
    initialized.current = true;
    setName(String(state.settings.user_name || ''));
    setAttention(state.settings.ambient_attention === true);
    const stored = String((state.settings.companion_ui as Record<string, unknown> | undefined)?.theme || 'ink');
    setTheme(themes.some(item => item.id === stored) ? stored : 'ink');
  }, [state.settings, state.settingsLoaded, run]);
  useEffect(() => {
    if (!state.connected) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => { if (!cancelled) setLoaded(portraitExpression); };
    image.src = `ayana-asset://${portraitExpression}/`;
    return () => { cancelled = true; };
  }, [portraitExpression, state.connected, run]);
  useEffect(() => {
    if (!active || leaving) return;
    const timer = window.setTimeout(() => playClip('arrival', 0), reduced() ? 0 : 320);
    return () => window.clearTimeout(timer);
  }, [active, run, leaving]);
  useEffect(() => {
    if (!active || loading || chapter !== 'meet' || meetPhase !== 'name') return;
    const timer = window.setTimeout(() => nameInput.current?.focus(), 220);
    return () => window.clearTimeout(timer);
  }, [active, loading, chapter, meetPhase, run]);
  useEffect(() => {
    if (loading || chapter !== 'voice' || voicePhase === 'released') return;
    const talkHotkey = String(state.settings.talk_hotkey || 'Ctrl+Shift+Space');
    const down = (event: KeyboardEvent) => {
      if (event.repeat || !matchesHotkey(event, talkHotkey)) return;
      event.preventDefault();
      if (voicePhase === 'idle') startHold();
    };
    const up = () => { if (holding.current) endHold(); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [loading, chapter, voicePhase, state.settings.talk_hotkey]);
  useEffect(() => () => {
    if (replyTimer.current) window.clearTimeout(replyTimer.current);
    if (washTimer.current) window.clearTimeout(washTimer.current);
  }, []);

  function releaseLoader() {
    const loader = loaderRef.current;
    window.setTimeout(() => {
      setLoading(false);
      setTransitioning(false);
      moving.current = false;
    }, reduced() ? 0 : 240);
    if (!loader) return;
    try {
      loader.animate([
        { opacity: 1, transform: 'scale(1)' },
        { opacity: 0, transform: 'scale(1.015)' },
      ], { duration: reduced() ? 0 : 240, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
    } catch { /* The content still becomes interactive below. */ }
  }

  function go(next: Chapter) {
    if (moving.current || leaving) return;
    moving.current = true;
    shouldPlay.current = false;
    audioRef.current?.pause();
    if (replyTimer.current) { window.clearTimeout(replyTimer.current); replyTimer.current = undefined; }
    setTransitioning(true);
    setSceneExiting(true);
    const clip = chapterClips[next];
    window.setTimeout(() => {
      setChapter(next);
      if (next === 'chat') { setChatPhase('compose'); setReply(false); setTyping(false); }
      if (next === 'voice') { setVoicePhase('idle'); setVoiceText('彩名，今天一起去散步吧。'); holding.current = false; }
      if (next === 'search') { setSearchPhase('query'); setSource(0); }
      setSceneExiting(false);
      setError('');
      setLoading(true);
      playClip(clip, 0);
      window.setTimeout(() => releaseLoader(), reduced() ? 0 : loaderDurations[next]);
    }, reduced() ? 0 : 180);
  }

  useEffect(() => {
    if (!active || leaving) return;
    setLoading(true);
    const timer = window.setTimeout(() => releaseLoader(), reduced() ? 0 : loaderDurations.meet);
    return () => window.clearTimeout(timer);
  }, [active, run]);

  async function confirmName() {
    if (!canSave) return;
    const value = name.trim();
    if (!value || [...value].length > 32 || /\p{C}/u.test(value)) { setError('称呼请使用 1–32 个字。'); return; }
    setSaving(true); setError('');
    try { await savePreferences({ user_name: value }); setName(value); }
    catch (reason) { setSaving(false); setError(reason instanceof Error ? reason.message : String(reason)); return; }
    setSaving(false);
    if (skip) { await finish(); return; }
    setMeetPhase('greeting');
    playClip('greeting', 0);
  }

  function sendChat() {
    if (chatPhase !== 'compose' || transitioning || loading) return;
    setChatPhase('sent');
    setTyping(true);
    if (replyTimer.current) window.clearTimeout(replyTimer.current);
    replyTimer.current = window.setTimeout(() => { setTyping(false); setReply(true); }, 620);
  }

  function startHold() {
    if (voicePhase !== 'idle' || transitioning || leaving || loading) return;
    holding.current = true;
    audioRef.current?.pause();
    setVoicePhase('holding');
  }
  function endHold() {
    if (!holding.current) return;
    holding.current = false;
    setVoicePhase('released');
    if (shouldPlay.current) void audioRef.current?.play().catch(() => { /* Keep going without sound. */ });
  }

  function runQuery() {
    if (searchPhase !== 'query' || loading) return;
    setSearchPhase('results');
  }
  function openSource(index: number) {
    if (searchPhase !== 'results' || loading) return;
    setSource(index);
    setSearchPhase('source');
  }

  function changeAttention(value: boolean) {
    if (loading) return;
    setAttention(value);
  }

  function chooseTheme(item: typeof themes[number], event: ReactMouseEvent<HTMLButtonElement>) {
    if (loading || item.id === theme) return;
    const note = styleNote.current?.getBoundingClientRect();
    const chip = event.currentTarget.getBoundingClientRect();
    setWash({ id: item.id, x: chip.left + chip.width / 2 - (note?.left || 0), y: chip.top + chip.height / 2 - (note?.top || 0) });
    setTheme(item.id);
    setThemeChanged(true);
    if (washTimer.current) window.clearTimeout(washTimer.current);
    washTimer.current = window.setTimeout(() => setWash(null), 680);
  }

  async function finish(configure = false) {
    if (leaving) return;
    if (!name.trim()) { setChapter('meet'); setMeetPhase('name'); setError('先告诉我，怎么称呼你。'); return; }
    setSaving(true); setError('');
    try {
      const selected = themes.find(item => item.id === theme) || themes[0];
      await savePreferences({ onboarding_version: 1,
        ...(attention !== (state.settings.ambient_attention === true) ? { ambient_attention: attention } : {}),
        ...(themeChanged ? { companion_ui: { theme: selected.id, background_mode: 'minimal', background_color: selected.background, bubble_color: selected.bubble } } : {}),
      });
      shouldPlay.current = false;
      audioRef.current?.pause();
      setLeaving(true);
      const result = await bridge.finishWelcome(configure);
      if (!result.ok) throw new Error(result.error || '暂时无法进入桌面，请重试。');
      setActive(false);
    } catch (reason) {
      setLeaving(false);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setSaving(false); }
  }

  function advance() {
    if (leaving || transitioning || saving || loading) return;
    if (chapter === 'meet' && meetPhase === 'greeting') void go('chat');
    else if (chapter === 'chat' && reply) void go('voice');
    else if (chapter === 'voice' && voicePhase === 'released') void go('search');
    else if (chapter === 'search' && searchPhase === 'source') void go('observe');
    else if (chapter === 'observe') void go('style');
    else if (chapter === 'style') void go('ready');
    else if (chapter === 'ready') void finish();
  }

  function skipTour() {
    shouldPlay.current = false;
    audioRef.current?.pause();
    if (!String(state.settings.user_name || '').trim()) {
      setSkip(true);
      setChapter('meet');
      setMeetPhase('name');
      setError('');
      setTransitioning(false);
      moving.current = false;
      playClip('arrival', 0);
      return;
    }
    void finish();
  }

  function close() {
    shouldPlay.current = false;
    audioRef.current?.pause();
    void bridge.closeWelcome();
  }

  return <main className="welcome" data-chapter={chapter} data-leaving={leaving} data-transitioning={transitioning} data-loading={loading} style={{ '--accent': accent } as CSSProperties} aria-label="与彩名初次见面">
    <header className="mg-header">
      <strong className="mg-brand"><i aria-hidden="true"/><span>Ayana</span></strong>
      <nav className="mg-progress" aria-label="初次见面进度">{chapterOrder.map((item, index) => (
        <span key={item} data-active={item === chapter} data-past={index < chapterIndex} aria-current={item === chapter ? 'step' : undefined}/>
      ))}</nav>
      <div className="mg-tools">
        <button aria-label={muted ? '开启开场声音' : '静音开场声音'} aria-pressed={!muted} onClick={() => setMuted(!muted)}><Icon name="volume" size={16}/></button>
        <button aria-label="跳过介绍" disabled={saving || leaving} onClick={skipTour}>跳过</button>
        <button aria-label={replay ? '关闭初次见面' : '退出 Ayana'} disabled={saving || leaving} onClick={close}><Icon name="close" size={17}/></button>
      </div>
    </header>
    <section className="mg-stage">
      <div className="mg-scene" key={`${chapter}-${run}`} data-chapter={chapter} data-exiting={sceneExiting} inert={loading}>
        <div className="mg-chapter"><b>{String(chapterIndex + 1).padStart(2, '0')}</b><i/><span>{chapterLabels[chapter]}</span></div>
        {loading && <div ref={loaderRef} className="mg-loader" aria-hidden="true" style={{ '--loader-ms': `${loaderDurations[chapter]}ms` } as CSSProperties}>
          <span className="mg-loader-ring"/>
          <div className="mg-loader-meta">
            <span>LOADING</span>
            <b>{String(chapterIndex + 1).padStart(2, '0')}</b>
            <em>{chapterLabels[chapter]}</em>
            <p>{loaderLabels[chapter]}</p>
            <i><b/></i>
          </div>
        </div>}
        {chapter === 'meet' && <div className="mg-meet">
          <div className="mg-meet-copy">
            <p className="mg-kicker">音無彩名 · AYANA</p>
            {meetPhase === 'name' ? <>
              <Title text="你来了。" className="mg-meet-title" />
              <form className="mg-name" onSubmit={event => { event.preventDefault(); void confirmName(); }}>
                <label htmlFor="mg-name">怎么称呼你？</label>
                <div className="mg-name-line">
                  <input ref={nameInput} id="mg-name" aria-label="我该怎么称呼你？" value={name} maxLength={64} autoComplete="nickname" placeholder="你的名字" disabled={saving || loading} onChange={event => { setName(event.target.value); setError(''); }}/>
                  <button type="submit" className="mg-round mg-orb" aria-label="确认名字" disabled={!canSave || saving || !name.trim()}><Icon name="arrow" size={18}/></button>
                </div>
                {error && <p className="mg-form-error" role="alert">{error}</p>}
              </form>
            </> : <>
              <Title text={name} long={name.length > 4} className="mg-meet-title" />
              <p className="mg-greeting"><Icon name="check" size={18}/> 以后，就这么叫你。</p>
              <button type="button" className="mg-round mg-orb mg-greet-orb" aria-label="继续" onClick={() => void advance()}><Icon name="arrow" size={20}/></button>
            </>}
          </div>
          <div className="mg-portrait" data-greeting={meetPhase === 'greeting'}>
            <div className="mg-portrait-frame">
              {loaded ? <img key={loaded} className="mg-portrait-img" src={`ayana-asset://${loaded}/`} alt="" draggable={false}/> : <span className="mg-portrait-fallback">彩</span>}
            </div>
            <div className="mg-portrait-meta"><b>音無彩名</b><span>AYANA</span></div>
          </div>
        </div>}
        {chapter === 'chat' && <div className="mg-split mg-chat">
          <div className="mg-scene-copy"><p className="mg-kicker">第一句话</p><Title text="一句话，就够了。" /><p className="mg-sub">{subcopy.chat}</p></div>
          <div className="mg-note" data-sent={chatPhase === 'sent'}>
            <div className="mg-note-top"><span className="mg-avatar">彩</span><b>彩名</b><span className="mg-note-status">{chatPhase === 'sent' ? (reply ? '刚刚' : '正在输入…') : '现在'}</span></div>
            <div className="mg-thread" aria-live="polite">
              <div className="mg-bubble mg-bubble-user">今天路过的那家书店，还开着。</div>
              <div className="mg-typing" data-visible={typing} aria-hidden="true"><i/><i/><i/></div>
              <div className="mg-bubble mg-bubble-ai" data-visible={reply}>这让人有一点开心呢。</div>
            </div>
            <div className="mg-composer">
              <span className={`mg-composer-text${chatPhase === 'sent' ? ' is-empty' : ''}`}>{chatPhase === 'sent' ? '写下一句话…' : '今天路过的那家书店，还开着。'}</span>
              <button type="button" className="mg-send mg-orb" onClick={sendChat} disabled={chatPhase === 'sent' || loading} aria-label="发送消息"><Icon name="arrow" size={18}/></button>
            </div>
          </div>
        </div>}
        {chapter === 'voice' && <div className="mg-split mg-voice" data-phase={voicePhase}>
          <div className="mg-scene-copy"><p className="mg-kicker">语音 · 按住说话</p><Title text="按住，说话。" /><p className="mg-sub">{subcopy.voice}</p></div>
          <div className="mg-voice-stage">
            <div className="mg-keys-wrap" data-pressed={voicePhase === 'holding'}><KeyCaps keys={talkKeys} big/></div>
            {voicePhase === 'released' ? <div className="mg-voice-result">
              <span className="mg-orb mg-result-orb"><Icon name="check" size={16}/></span>
              <span className="mg-result-label">识别结果 · 可修改</span>
              <input aria-label="识别结果" value={voiceText} onChange={event => setVoiceText(event.target.value)}/>
              <p className="mg-result-note">松开就变成文字。发送前，还能改。</p>
            </div> : <button type="button" className="mg-record mg-orb" data-pressed={voicePhase === 'holding'} aria-label="按住说话" disabled={loading}
              onPointerDown={event => { if (event.button === 0 || event.pointerType !== 'mouse') { event.currentTarget.setPointerCapture(event.pointerId); startHold(); } }}
              onPointerUp={endHold} onPointerCancel={endHold} onContextMenu={event => event.preventDefault()}>
              <WaveBars/>
              <span className="mg-record-label">{voicePhase === 'holding' ? '正在听…松开结束' : '按住说话'}</span>
            </button>}
          </div>
        </div>}
        {chapter === 'search' && <div className="mg-split mg-search" data-phase={searchPhase}>
          <div className="mg-scene-copy"><p className="mg-kicker">搜索 · 来源</p><Title text="想问什么，直接问。" /><p className="mg-sub">{subcopy.search}</p></div>
          <div className="mg-search-board">
            <div className="mg-search-row">
              <div className="mg-lens mg-orb" data-open={searchPhase !== 'query'} aria-hidden="true"><Icon name="search" size={26}/><i/></div>
              <button type="button" className="mg-query" onClick={runQuery} disabled={searchPhase !== 'query' || loading}>为什么雨后，会有特别的味道？<Icon name="arrow" size={16}/></button>
            </div>
            {searchPhase !== 'query' && <div className="mg-results">
              {searchResults.map((item, index) => <button type="button" key={item.title} className="mg-result" data-selected={searchPhase === 'source' && source === index} data-dim={searchPhase === 'source' && source !== index} onClick={() => openSource(index)} disabled={searchPhase !== 'results' || loading}>
                <span className="mg-result-mark"><Icon name="search" size={15}/></span>
                <span className="mg-result-copy"><b>{item.title}</b><small>{item.source}</small></span>
                <Icon name="external" size={14}/>
              </button>)}
            </div>}
            {searchPhase === 'source' && <p className="mg-source-note"><Icon name="external" size={14}/> 来源已打开，原网页随时可回。</p>}
          </div>
        </div>}
        {chapter === 'observe' && <div className="mg-split mg-observe" data-attention={attention}>
          <div className="mg-scene-copy"><p className="mg-kicker">屏幕观察</p><Title text="看与不看，你决定。" /><p className="mg-sub">{subcopy.observe}</p></div>
          <div className="mg-observe-stage">
            <div className="mg-monitor">
              <div className="mg-screen">
                <span className="mg-window w1"/><span className="mg-window w2"/><span className="mg-window w3"/>
                <span className="mg-scan" aria-hidden="true"/>
              </div>
              <span className="mg-eye mg-orb" aria-hidden="true"><Icon name="eye" size={24}/></span>
            </div>
            <label className="mg-switch">
              <input type="checkbox" role="switch" aria-label="允许彩名偶尔偷看" checked={attention} disabled={loading} onChange={event => changeAttention(event.target.checked)}/>
              <i/><span>{attention ? '偶尔可以看看' : '不看也没关系'}</span>
            </label>
          </div>
        </div>}
        {chapter === 'style' && <div className="mg-split mg-style">
          <div className="mg-scene-copy"><p className="mg-kicker">外观</p><Title text="换一种心情。" /><p className="mg-sub">{subcopy.style}</p></div>
          <div className="mg-style-stage">
            <div ref={styleNote} className="mg-style-note" data-theme={theme} style={{
              '--note-bg': selectedTheme.background,
              '--note-fg': theme === 'paper' ? '#2c2822' : '#f1ece2',
              '--bubble-bg': selectedTheme.bubble,
              '--bubble-fg': theme === 'ink' ? '#e9edf5' : '#262a2c',
            } as CSSProperties}>
              {wash && <span className="mg-style-wash" key={wash.id} style={{ background: themes.find(item => item.id === wash.id)?.background, '--x': `${wash.x}px`, '--y': `${wash.y}px` } as CSSProperties}/>}
              <div className="mg-style-top"><b>彩名</b><span>{selectedTheme.name}</span></div>
              <div className="mg-style-bubble">今天的故事，讲给我听。</div>
              <div className="mg-style-composer">写下一句话…</div>
            </div>
            <div className="mg-swatches">
              {themes.map(item => <button type="button" key={item.id} aria-label={item.name} aria-pressed={theme === item.id} disabled={loading} onClick={event => chooseTheme(item, event)}>
                <i className={theme === item.id ? 'mg-orb' : undefined} style={{ background: item.background, color: item.id === 'paper' ? '#25282d' : '#f1ece2' }}>{theme === item.id && <Icon name="check" size={14}/>}</i>
                <span>{item.name.split(' · ')[1]}</span>
              </button>)}
            </div>
          </div>
        </div>}
        {chapter === 'ready' && <div className="mg-split mg-ready">
          <div className="mg-scene-copy"><p className="mg-kicker">准备好了</p><Title text="桌面见。" /><p className="mg-sub">{subcopy.ready}</p></div>
          <div className="mg-ready-stage">
            <span className="mg-orb mg-ready-orb" aria-hidden="true"><Icon name="arrow" size={18}/></span>
            <p className="mg-ready-copy">想聊天的时候，按下这组键。</p>
            <KeyCaps keys={summonKeys} big/>
            <p className="mg-ready-note">剩下的，交给我。</p>
          </div>
        </div>}
      </div>
    </section>
    <div className="mg-caption-row"><p className="mg-caption" key={caption}>{caption}</p></div>
    <footer className="mg-footer">
      <p className={`mg-hint${status ? ' is-status' : ''}`} role={error ? 'alert' : 'status'}>{hint}</p>
      <div className="mg-actions">
        {chapter === 'ready' && !(state.settings.provider === 'openai' && state.settings.apiKeyConfigured) && <button type="button" className="mg-link" disabled={!canSave} onClick={() => void finish(true)}>连接模型</button>}
        {canContinue && <button type="button" className="mg-next" disabled={saving || leaving || transitioning || (chapter === 'ready' && !canSave)} onClick={advance}>{chapter === 'ready' ? '进入桌面' : '继续'}<Icon name="arrow" size={16}/></button>}
      </div>
    </footer>
  </main>;
}
