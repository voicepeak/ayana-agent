import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { WelcomeMotion, chapterOrder, motionChapters, type Chapter } from './WelcomeMotion';
import { WelcomeSound } from './welcomeSound';
import { WelcomeFeedback } from './welcomeFeedback';
import { WelcomeShortcut } from './WelcomeShortcut';
import { useWelcomeEntrance } from './useWelcomeEntrance';
import { WelcomeAppearance, wardrobeLooks, type WardrobeLook } from './WelcomeAppearance';
import { companionDesign, useCompanionDesign, type CompanionDesign } from './CompanionDesign';
import { WelcomeCaption, type WelcomeLine } from './WelcomeCaption';
import { bridge, useRuntime } from './state';
import { savePreferences } from './preferences';
import { catalogFor } from './avatarCatalogs';
import { outfitAsset } from './avatarOutfit';
import { themes } from './companionThemes';
import { surfacePalette } from './companionPalette';
import { Icon } from './components';
import logoMark from './assets/logo-mark.png';
import './welcome.css';

type MeetPhase = 'name' | 'greeting';
type ChatPhase = 'compose' | 'sent';
type VoicePhase = 'idle' | 'holding' | 'released';
type SearchPhase = 'query' | 'results' | 'source';
const searchResults = [
  { title: '为什么下雨后，空气会变清新？', source: '气象小站' },
  { title: 'Petrichor：雨后的气味', source: '维基百科' },
  { title: '雨的味道，从哪里来？', source: '科学松鼠会' },
];
const waveBars = Array.from({ length: 28 }, (_, index) => ({ h: 18 + ((index * 37) % 46), d: (index * 53) % 420 }));
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

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
  return <h2 className={`mg-title ${className}`} data-long={long || undefined} aria-label={text.replaceAll('\n', '')}>{text.split('\n').map((line, index) =>
    <span className="mg-title-line" key={index}><span className="mg-title-line-inner">{line}</span></span>
  )}</h2>;
}

function WaveBars() {
  return <span className="mg-wave" aria-hidden="true">{waveBars.map((bar, index) => (
    <i key={index} style={{ '--h': bar.h, '--d': bar.d } as CSSProperties}/>
  ))}</span>;
}

function SceneHeading({ text, asset, speaking, character, caption }: { text: string; asset: string; speaking: boolean; character: string; caption: WelcomeLine | null }) {
  return <div className="mg-scene-copy">
    <Title text={text}/>
    <div className="mg-character-with-caption"><div className="mg-character-stamp" data-speaking={speaking} aria-hidden="true">
      <i className="mg-stamp-orbit"/><span className="mg-stamp-star">✦</span>
      <img src={`ayana-asset://${asset}/?character=${character}`} alt="" draggable={false}/><span className="mg-stamp-petal">✿</span>
    </div><WelcomeCaption line={caption}/></div>
  </div>;
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
  const [theme, setTheme] = useState('paper');
  const [themeChanged, setThemeChanged] = useState(false);
  const [wash, setWash] = useState<{ id: string; x: number; y: number; from: string } | null>(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [transitioning, setTransitioning] = useState(true);
  const [sceneExiting, setSceneExiting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const [soundVolume, setSoundVolume] = useState(1);
  const [summoned, setSummoned] = useState(false);
  const [active, setActive] = useState(true);
  const [replay, setReplay] = useState(false);
  const [skip, setSkip] = useState(false);
  const [run, setRun] = useState(0);
  const [cut, setCut] = useState<{ chapter: Chapter; id: number } | null>({ chapter: 'meet', id: 0 });
  const [loaded, setLoaded] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const [caption, setCaption] = useState<WelcomeLine | null>(null);
  const [look, setLook] = useState<WardrobeLook>(wardrobeLooks[0]);
  const [lookChanged, setLookChanged] = useState(false);
  const [saveVersion, setSaveVersion] = useState(0);
  const { draft: portraitDesign, setDraft: setPortraitDesign, patch: portraitPatch } = useCompanionDesign(state.settings);
  const nameInput = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const feedbackLayer = useRef<HTMLDivElement>(null);
  const feedback = useRef<WelcomeFeedback | null>(null);
  const styleNote = useRef<HTMLDivElement>(null);
  const soundRef = useRef<WelcomeSound | null>(null);
  const cutId = useRef(0);
  const moving = useRef(false);
  const holding = useRef(false);
  const initialized = useRef(false);
  const replyTimer = useRef<number | undefined>(undefined);
  const washTimer = useRef<number | undefined>(undefined);
  const zoomTimer = useRef<number | undefined>(undefined);
  const session = useRef(0), settingBusy = useRef(false), lineId = useRef(0);
  const designRef = useRef(portraitDesign); designRef.current = portraitDesign;
  const chapterIndex = chapterOrder.indexOf(chapter);
  const readyCharacters = (state.settings.character_options as { id: string; ready: boolean }[] | undefined) || [];
  const lookReady = look.character === String(state.settings.character || 'ayana') || readyCharacters.some(item => item.id === look.character && item.ready);
  const selectedTheme = themes.find(item => item.id === theme) || themes[0];
  const notePalette = surfacePalette(selectedTheme.background);
  const bubblePalette = surfacePalette(selectedTheme.bubble);
  const accent = motionChapters[chapter].color;
  const portraitExpression = outfitAsset(
    meetPhase === 'greeting' ? 'encourage' : 'neutral',
    look.costume,
    catalogFor(look.character),
  );
  const canSave = state.connected && state.settingsLoaded && !saving && !leaving && !transitioning && !loading;
  const canContinue = !loading && (chapter !== 'meet' || meetPhase === 'greeting');
  const modelReady = state.settings.provider === 'openai' && state.apiKeyConfigured === true
    && Boolean(String(state.settings.model ?? '').trim());
  const connection = !state.connected || !state.settingsLoaded ? '正在连接…' : '';
  const modelHint = chapter === 'ready' && !modelReady ? '请先配置 API Key 与模型名称。' : '';
  const status = connection || (chapter === 'meet' && meetPhase === 'name' ? '' : error) || modelHint;
  const find = (selector: string) => rootRef.current?.querySelector(selector) || null;
  useWelcomeEntrance(rootRef, chapter, run, active, transitioning, () => soundRef.current?.cue('press'), chapter === 'meet' ? meetPhase : '');
  function speak(clip: 'remember' | 'setting', text: string) {
    setCaption({ id: ++lineId.current, text });
    return soundRef.current?.say(clip) || Promise.resolve(false);
  }
  function settingSucceeded() { setSaveVersion(version => version + 1); void speak('setting', '设定成功。'); }
  async function saveSetting(patch: Record<string, unknown>, rollback?: () => void) {
    if (!canSave || settingBusy.current || !active) return false;
    const current = session.current;
    settingBusy.current = true; setSaving(true); setError(''); setCaption(null);
    try {
      await savePreferences(patch);
      if (current !== session.current) return false;
      setSaveVersion(version => version + 1); soundRef.current?.cue('confirm');
      return true;
    } catch (reason) {
      if (current === session.current) {
        rollback?.(); setError(reason instanceof Error ? reason.message : String(reason)); soundRef.current?.cue('error');
      }
      return false;
    } finally { if (current === session.current) { settingBusy.current = false; setSaving(false); } }
  }
  useEffect(() => { setCaption(null); if (zoomTimer.current) window.clearTimeout(zoomTimer.current); }, [chapter, run]);
  useEffect(() => () => { session.current++; if (zoomTimer.current) window.clearTimeout(zoomTimer.current); }, []);
  function inputFeedback(value: string, node: HTMLInputElement) {
    soundRef.current?.cue('type', [...value].length);
    feedback.current?.pulse(node.closest('.mg-name-line') || node, 'type');
  }
  function control(target: EventTarget | null) {
    if (!active || leaving || !(target instanceof Element)) return null;
    const node = target.closest<HTMLElement>('button,input,label.mg-switch');
    if (!node || node.matches(':disabled') || node.closest('[inert]') || node.matches('input[type=range]')) return null;
    return node.closest<HTMLElement>('.mg-switch') || node;
  }
  function press(node: HTMLElement | null) {
    if (!node) return;
    soundRef.current?.cue('press');
    feedback.current?.pulse(node);
    feedback.current?.burst(node);
  }

  useEffect(() => {
    if (!feedbackLayer.current) return;
    const effects = new WelcomeFeedback(feedbackLayer.current);
    feedback.current = effects;
    return () => { effects.clear(); feedback.current = null; };
  }, []);
  useEffect(() => {
    if (!active || transitioning || leaving) feedback.current?.clear();
  }, [active, transitioning, leaving, run]);
  useEffect(() => {
    if (chapter !== 'meet' || meetPhase !== 'greeting' || !active) return;
    feedback.current?.pulse(find('.mg-portrait'), 'pop');
    feedback.current?.burst(find('.mg-portrait-frame'), true);
  }, [meetPhase]);
  useEffect(() => {
    if (chapter !== 'chat' || !active) return;
    if (reply) {
      feedback.current?.pulse(find('.mg-note'), 'pop');
      feedback.current?.burst(find('.mg-bubble-ai'), true);
    } else if (chatPhase === 'sent') {
      feedback.current?.pulse(find('.mg-note'), 'recoil');
      feedback.current?.fly(find('.mg-send'), find('.mg-bubble-user'));
    }
  }, [chatPhase, reply]);
  useEffect(() => {
    if (chapter !== 'voice' || !active) return;
    if (voicePhase === 'holding') feedback.current?.pulse(find('.mg-keys-wrap'), 'press');
    if (voicePhase === 'released') feedback.current?.burst(find('.mg-result-orb'), true);
  }, [voicePhase]);
  useEffect(() => {
    if (chapter !== 'search' || !active) return;
    feedback.current?.pulse(find('.mg-search-board'), searchPhase === 'source' ? 'pop' : 'recoil');
    if (searchPhase === 'source') feedback.current?.burst(find('.mg-result[data-selected=true] .mg-result-mark'), true);
  }, [searchPhase]);
  useEffect(() => {
    if (chapter !== 'observe' || !active) return;
    feedback.current?.pulse(find('.mg-monitor'), 'pop');
    feedback.current?.burst(find('.mg-eye'), attention);
  }, [attention]);

  useEffect(() => {
    const sound = new WelcomeSound(setSpeaking);
    soundRef.current = sound;
    const unlock = () => { sound.unlock(); void sound.preloadCompletion(); };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    const visibility = () => { if (document.hidden) { sound.stop(); feedback.current?.clear(); } };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
      document.removeEventListener('visibilitychange', visibility);
      sound.dispose(); soundRef.current = null;
    };
  }, []);
  useEffect(() => {
    soundRef.current?.setVolume(Number(state.settings.volume ?? 1) * soundVolume, muted);
  }, [state.settings.volume, soundVolume, muted]);
  useEffect(() => {
    document.documentElement.classList.add('welcome-root');
    void bridge.getState().then(snapshot => { setReplay(Boolean(snapshot.welcomeReplay)); setRun(snapshot.welcomeRun || 0); });
    const off = bridge.onEvent(event => {
      if (event.type === 'desktop.welcome-hidden') { session.current++; setActive(false); setCut(null); soundRef.current?.stop(); }
      if (event.type === 'desktop.welcome-open') {
        session.current++; settingBusy.current = false; setCaption(null);
        initialized.current = false;
        moving.current = false;
        holding.current = false;
        setChapter('meet'); setMeetPhase('name'); setChatPhase('compose'); setReply(false); setTyping(false);
        setVoicePhase('idle'); setVoiceText('彩名，今天一起去散步吧。');
        setSearchPhase('query'); setSource(0); setWash(null); setThemeChanged(false); setSummoned(false);
        setLookChanged(false);
        setSaving(false); setLeaving(false); setTransitioning(true); setSceneExiting(false); setLoading(true); setError(''); setSkip(false); setActive(true);
        setCut({ chapter: 'meet', id: ++cutId.current });
        setReplay(event.replay === true); setRun(Number(event.run));
      }
    });
    return () => {
      off();
      document.documentElement.classList.remove('welcome-root');
      soundRef.current?.stop();
    };
  }, []);
  useEffect(() => {
    if (!state.settingsLoaded || initialized.current) return;
    initialized.current = true;
    setName(String(state.settings.user_name || ''));
    setPortraitDesign(companionDesign(state.settings));
    setLook(wardrobeLooks.find(item => item.costume === String(state.settings.avatar_costume || '校服')) || wardrobeLooks[0]);
    setAttention(state.settings.ambient_attention === true);
    const stored = String((state.settings.companion_ui as Record<string, unknown> | undefined)?.theme || 'ink');
    setTheme(replay && themes.some(item => item.id === stored) ? stored : 'paper');
  }, [state.settings, state.settingsLoaded, run]);
  useEffect(() => {
    if (!state.connected) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => { if (!cancelled) setLoaded(portraitExpression); };
    image.src = `ayana-asset://${portraitExpression}/?character=${look.character}`;
    return () => { cancelled = true; };
  }, [portraitExpression, look.character, state.connected, run]);
  useEffect(() => {
    if (!active || loading || transitioning || chapter !== 'meet' || meetPhase !== 'name') return;
    const timer = window.setTimeout(() => nameInput.current?.focus({ preventScroll: true }), reduced() ? 80 : 1100);
    return () => window.clearTimeout(timer);
  }, [active, loading, transitioning, chapter, meetPhase, run]);
  useEffect(() => {
    if (!active || leaving || loading || transitioning || chapter !== 'voice' || voicePhase === 'released') return;
    const talkHotkey = String(state.settings.talk_hotkey || 'Ctrl+Shift+Space');
    const down = (event: KeyboardEvent) => {
      if (event.repeat || (event.target instanceof Element && event.target.closest('[data-recording=true]')) || !matchesHotkey(event, talkHotkey)) return;
      event.preventDefault();
      if (voicePhase === 'idle') startHold();
    };
    const up = () => { if (holding.current) endHold(); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', up);
    };
  }, [active, leaving, loading, transitioning, chapter, voicePhase, state.settings.talk_hotkey]);
  useEffect(() => () => {
    if (replyTimer.current) window.clearTimeout(replyTimer.current);
    if (washTimer.current) window.clearTimeout(washTimer.current);
    holding.current = false;
  }, [active, run]);

  // One cancellable clock owns the cut, content handoff and input lock.
  // Reopen, skip, hide and unmount all invalidate the previous clock.
  useEffect(() => {
    if (!active || leaving || !cut) return;
    const next = cut.chapter;
    const duration = reduced() ? 100 : motionChapters[next].duration;
    const timers: number[] = [];
    soundRef.current?.transition(next, duration);
    timers.push(window.setTimeout(() => {
      setChapter(next);
      if (next === 'chat') { setChatPhase('compose'); setReply(false); setTyping(false); }
      if (next === 'voice') { setVoicePhase('idle'); setVoiceText('彩名，今天一起去散步吧。'); holding.current = false; }
      if (next === 'search') { setSearchPhase('query'); setSource(0); }
      setSceneExiting(false); setError('');
    }, duration * .34));
    timers.push(window.setTimeout(() => setLoading(false), duration * .68));
    timers.push(window.setTimeout(() => {
      setCut(null); setLoading(false); setTransitioning(false); moving.current = false;
    }, duration));
    return () => { timers.forEach(window.clearTimeout); soundRef.current?.stop(); };
  }, [cut, active, leaving]);

  function go(next: Chapter) {
    if (moving.current || leaving) return;
    moving.current = true;
    if (replyTimer.current) { window.clearTimeout(replyTimer.current); replyTimer.current = undefined; }
    setTransitioning(true); setSceneExiting(true); setLoading(true);
    setCut({ chapter: next, id: ++cutId.current });
  }

  async function confirmName() {
    if (!canSave) return;
    const value = name.trim();
    if (!value || [...value].length > 32 || /\p{C}/u.test(value)) {
      setError('称呼请使用 1–32 个字。'); soundRef.current?.cue('error'); feedback.current?.pulse(find('.mg-name'), 'error'); return;
    }
    setSaving(true); setError('');
    try { await savePreferences({ user_name: value }); setName(value); }
    catch (reason) { setSaving(false); setError(reason instanceof Error ? reason.message : String(reason)); soundRef.current?.cue('error'); feedback.current?.pulse(find('.mg-name'), 'error'); return; }
    setSaving(false);
    if (skip) { await finish(); return; }
    setMeetPhase('greeting');
    soundRef.current?.cue('confirm');
    void speak('remember', '记住了。以后就这么叫你。');
  }

  function sendChat() {
    if (chatPhase !== 'compose' || transitioning || loading) return;
    soundRef.current?.cue('send');
    setChatPhase('sent');
    setTyping(true);
    if (replyTimer.current) window.clearTimeout(replyTimer.current);
    replyTimer.current = window.setTimeout(() => { setTyping(false); setReply(true); soundRef.current?.cue('reply'); }, 620);
  }

  function startHold() {
    if (holding.current || voicePhase !== 'idle' || transitioning || leaving || loading) return;
    holding.current = true;
    soundRef.current?.cue('record-start');
    setVoicePhase('holding');
  }
  function endHold() {
    if (!holding.current) return;
    holding.current = false;
    setVoicePhase('released');
    soundRef.current?.cue('record-stop');
  }

  function runQuery() {
    if (searchPhase !== 'query' || loading) return;
    soundRef.current?.cue('search');
    setSearchPhase('results');
  }
  function openSource(index: number) {
    if (searchPhase !== 'results' || loading) return;
    soundRef.current?.cue('source');
    setSource(index);
    setSearchPhase('source');
  }

  async function changeAttention(value: boolean) {
    if (!canSave || settingBusy.current) return;
    const previous = attention;
    soundRef.current?.cue(value ? 'toggle-on' : 'toggle-off');
    setAttention(value);
    await saveSetting({ ambient_attention: value }, () => setAttention(previous));
  }

  async function chooseTheme(item: typeof themes[number], event: ReactMouseEvent<HTMLButtonElement>) {
    if (!canSave || settingBusy.current) return;
    const previous = theme;
    soundRef.current?.cue('theme', themes.findIndex(theme => theme.id === item.id));
    feedback.current?.pulse(event.currentTarget.querySelector('i'), 'pop');
    feedback.current?.burst(event.currentTarget.querySelector('i'), true);
    feedback.current?.pulse(styleNote.current, 'recoil');
    setThemeChanged(true);
    if (item.id !== theme && !reduced()) {
      const note = styleNote.current?.getBoundingClientRect();
      const chip = event.currentTarget.getBoundingClientRect();
      setWash({ id: item.id, x: chip.left + chip.width / 2 - (note?.left || 0), y: chip.top + chip.height / 2 - (note?.top || 0), from: selectedTheme.background });
    } else setWash(null);
    setTheme(item.id);
    if (washTimer.current) window.clearTimeout(washTimer.current);
    washTimer.current = window.setTimeout(() => setWash(null), 820);
    await saveSetting({ companion_ui: { theme: item.id, background_mode: 'minimal', background_color: item.background, bubble_color: item.bubble } }, () => { setTheme(previous); setWash(null); });
  }

  async function chooseLook(item: WardrobeLook) {
    if (!canSave || settingBusy.current) return;
    const previous = look;
    setCaption(null);
    setLook(item); setLookChanged(true); soundRef.current?.cue('theme', wardrobeLooks.indexOf(item));
    feedback.current?.burst(find('.mg-appearance'), true);
    const ready = item.character === String(state.settings.character || 'ayana') || readyCharacters.some(character => character.id === item.character && character.ready);
    if (ready) await saveSetting({ character: item.character, avatar_costume: item.costume }, () => setLook(previous));
  }

  async function savePortrait(patch?: Partial<CompanionDesign>) {
    if (!patch || !canSave || settingBusy.current) return;
    if (zoomTimer.current) window.clearTimeout(zoomTimer.current);
    const current = designRef.current;
    const position = { portrait_x: current.portrait_x, portrait_y: current.portrait_y, portrait_size: current.portrait_size, ...patch };
    setPortraitDesign(value => ({ ...value, ...position }));
    await saveSetting({ companion_ui: position });
  }
  function previewPortrait(patch: Partial<CompanionDesign>) {
    setPortraitDesign(value => ({ ...value, ...patch }));
    if (patch.portrait_size !== undefined) {
      if (zoomTimer.current) window.clearTimeout(zoomTimer.current);
      const commit = () => {
        if (find('.portrait-stage[data-dragging=true]')) { zoomTimer.current = window.setTimeout(commit, 120); return; }
        void savePortrait(patch);
      };
      zoomTimer.current = window.setTimeout(commit, 350);
    }
  }

  async function finish() {
    if (leaving || settingBusy.current) return;
    if (!name.trim()) { setChapter('meet'); setMeetPhase('name'); setError('先告诉我，怎么称呼你。'); return; }
    if (!modelReady) { setError('请先在设置中填写 API Key 与模型名称。'); void bridge.openSettings('model'); return; }
    if (zoomTimer.current) window.clearTimeout(zoomTimer.current);
    zoomTimer.current = undefined; settingBusy.current = true;
    setSaving(true); setError('');
    const current = session.current;
    try {
      const selected = themes.find(item => item.id === theme) || themes[0];
      await savePreferences({ onboarding_version: 1,
        ...(lookChanged && lookReady ? { character: look.character, avatar_costume: look.costume } : {}),
        ...(attention !== (state.settings.ambient_attention === true) ? { ambient_attention: attention } : {}),
        ...(themeChanged || Object.keys(portraitPatch).length ? { companion_ui: { ...portraitPatch,
          ...(themeChanged ? { theme: selected.id, background_mode: 'minimal', background_color: selected.background, bubble_color: selected.bubble } : {}) } } : {}),
      });
      if (current !== session.current) return;
      soundRef.current?.stop();
      setCut(null); setLoading(false); setTransitioning(false); setSceneExiting(false); setCaption(null);
      // The current page dissolves into the desktop while the original game line plays.
      void soundRef.current?.say('champion');
      setLeaving(true);
      const result = await bridge.finishWelcome();
      if (!result.ok) throw new Error(result.error || '暂时无法进入桌面，请重试。');
      setActive(false);
    } catch (reason) {
      if (current !== session.current) return;
      setLeaving(false);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (current === session.current) { settingBusy.current = false; setSaving(false); } }
  }

  function advance() {
    if (leaving || transitioning || saving || loading) return;
    if (chapter === 'meet' && meetPhase === 'name') return;
    if (chapterIndex < chapterOrder.length - 1) go(chapterOrder[chapterIndex + 1]);
    else void finish();
  }

  function previous() {
    if (!active || leaving || transitioning || saving || loading || chapterIndex === 0) return;
    go(chapterOrder[chapterIndex - 1]);
  }

  useEffect(() => {
    const navigate = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey
        || !active || leaving || transitioning || saving || loading) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input,textarea,select,[contenteditable=true]') || rootRef.current?.querySelector('[data-recording=true],.mg-shortcut-editor[data-phase=testing]')) return;
      if (event.key === 'ArrowLeft') { event.preventDefault(); previous(); }
      else if (event.key === 'ArrowRight' || (event.key === 'Enter' && !target?.closest('button'))) { event.preventDefault(); advance(); }
    };
    window.addEventListener('keydown', navigate);
    return () => window.removeEventListener('keydown', navigate);
  }, [active, leaving, transitioning, saving, loading, chapter, meetPhase]);

  function skipTour() {
    soundRef.current?.stop();
    if (!String(state.settings.user_name || '').trim()) {
      setSkip(true);
      setChapter('meet');
      setMeetPhase('name');
      setError('');
      setTransitioning(false);
      moving.current = false;
      setCut(null); setLoading(false); setSceneExiting(false);
      return;
    }
    void finish();
  }

  function close() {
    session.current++;
    soundRef.current?.stop();
    setCut(null); setActive(false);
    void bridge.closeWelcome();
  }

  return <main ref={rootRef} className="welcome" data-chapter={chapter} data-leaving={leaving} data-transitioning={transitioning} data-loading={loading} data-saving={saving} data-save-version={saveVersion} style={{ '--accent': accent } as CSSProperties} aria-label="与彩名初次见面"
    onPointerOver={event => {
      const node = control(event.target);
      if (event.pointerType !== 'touch' && node && !(event.relatedTarget instanceof Node && node.contains(event.relatedTarget))) soundRef.current?.cue('hover');
    }}
    onPointerDownCapture={event => { if (event.button === 0) press(control(event.target)); }}
    onKeyDownCapture={event => {
      const node = control(event.target);
      if (!event.repeat && (event.key === 'Enter' || event.key === ' ') && node?.matches('button,input[type=checkbox],label.mg-switch')) press(node);
    }}
    onFocusCapture={event => {
      const node = control(event.target);
      if (node && event.target instanceof HTMLInputElement && event.target.type !== 'checkbox') {
        soundRef.current?.cue('focus'); feedback.current?.pulse(node, 'type');
      }
    }}>
    <div ref={feedbackLayer} className="mg-feedback-layer" aria-hidden="true"/>
    <header className="mg-header">
      <strong className="mg-brand"><img src={logoMark} alt=""/><span>Ayana</span></strong>
      <nav className="mg-progress" aria-label="初次见面进度">{chapterOrder.map((item, index) => (
        <span key={item} data-active={item === chapter} data-past={index < chapterIndex} aria-current={item === chapter ? 'step' : undefined}/>
      ))}</nav>
      <div className="mg-tools">
        <button aria-label={muted ? '开启声音' : '静音声音'} aria-pressed={!muted} onClick={() => {
          const next = !muted; setMuted(next); soundRef.current?.setVolume(Number(state.settings.volume ?? 1) * soundVolume, next);
          if (!next) soundRef.current?.cue('confirm');
        }}><Icon name="volume" size={16}/></button>
        <label className="mg-sound-level" title="声音音量">
          <input type="range" aria-label="声音音量" min="0" max="150" step="5" value={Math.round(soundVolume * 100)} disabled={muted}
            onChange={event => setSoundVolume(Number(event.target.value) / 100)}
            onPointerUp={() => soundRef.current?.cue('confirm')} onKeyUp={() => soundRef.current?.cue('confirm')}/>
        </label>
        <button aria-label="跳过介绍" disabled={saving || leaving} onClick={skipTour}>跳过</button>
        <button aria-label={replay ? '关闭初次见面' : '退出 Ayana'} disabled={saving || leaving} onClick={close}><Icon name="close" size={17}/></button>
      </div>
    </header>
    {cut && <WelcomeMotion key={cut.id} chapter={cut.chapter}/>}
    <section className="mg-stage" aria-busy={loading}>
      <div className="mg-scene" key={`${chapter}-${run}`} data-chapter={chapter} data-meet-phase={chapter === 'meet' ? meetPhase : undefined} data-exiting={sceneExiting} inert={loading || transitioning || leaving || !active}>
        {chapter === 'meet' && <div className="mg-meet">
          <div className="mg-meet-copy">
            {meetPhase === 'name' ? <>
              <Title text={'你好，\n我是彩名。'} className="mg-meet-title" />
              <form className="mg-name" onSubmit={event => { event.preventDefault(); void confirmName(); }}>
                <div className="mg-name-line">
                  <input ref={nameInput} id="mg-name" aria-label="我该怎么称呼你？" value={name} maxLength={64} autoComplete="nickname" placeholder="你的名字" disabled={saving || loading} onChange={event => { setName(event.target.value); setError(''); inputFeedback(event.target.value, event.target); }}/>
                  <button type="submit" className="mg-round mg-orb" aria-label="确认名字" disabled={!canSave || saving || !name.trim()}><Icon name="arrow" size={18}/></button>
                </div>
                {error && <p className="mg-form-error" role="alert">{error}</p>}
              </form>
            </> : <>
              <Title key="greeting" text={`${name}，\n记住你了。`} long={[...name].length > 5} className="mg-meet-title" />
              <button type="button" className="mg-round mg-orb mg-greet-orb" aria-label="继续" onClick={() => void advance()}><Icon name="arrow" size={20}/></button>
            </>}
          </div>
          <div className="mg-portrait" data-greeting={meetPhase === 'greeting'} data-speaking={speaking}>
            <div className="mg-portrait-frame">
              {loaded ? <img key={loaded} className="mg-portrait-img" src={`ayana-asset://${loaded}/?character=${look.character}`} alt="" draggable={false}/> : <span className="mg-portrait-fallback">✦</span>}
            </div>
            <WelcomeCaption line={caption}/>
          </div>
        </div>}
        {chapter === 'chat' && <div className="mg-split mg-chat">
          <SceneHeading text={'今天有什么\n想跟我说的？'} asset={portraitExpression} speaking={speaking} character={look.character} caption={caption}/>
          <div className="mg-note" data-sent={chatPhase === 'sent'}>
            <div className="mg-note-top"><b>彩名</b></div>
            <div className="mg-thread" aria-live="polite">
              <div className="mg-bubble mg-bubble-user">今天路过的那家书店，还开着。</div>
              <div className="mg-typing" data-visible={typing} aria-hidden="true"><i/><i/><i/></div>
              <div className="mg-bubble mg-bubble-ai" data-visible={reply}>后来进去逛了吗？</div>
            </div>
            <div className="mg-composer">
              <span className={`mg-composer-text${chatPhase === 'sent' ? ' is-empty' : ''}`}>{chatPhase === 'sent' ? '写下一句话…' : '今天路过的那家书店，还开着。'}</span>
              <button type="button" className="mg-send mg-orb" onClick={sendChat} disabled={chatPhase === 'sent' || loading} aria-label="发送消息"><Icon name="arrow" size={18}/></button>
            </div>
          </div>
        </div>}
        {chapter === 'voice' && <div className="mg-split mg-voice" data-phase={voicePhase}>
          <SceneHeading text={'不想打字，\n就按住说。'} asset={portraitExpression} speaking={speaking} character={look.character} caption={caption}/>
          <div className="mg-voice-stage">
            <div className="mg-keys-wrap" data-pressed={voicePhase === 'holding'}>
              <WelcomeShortcut field="talk_hotkey" value={String(state.settings.talk_hotkey || 'Control+Shift+Space')} disabled={!active || loading || transitioning || leaving || saving}
                onSaved={() => { holding.current = false; setVoicePhase('idle'); settingSucceeded(); }} onTesting={() => { holding.current = false; setVoicePhase('idle'); }} onTested={startHold} onCue={cue => soundRef.current?.cue(cue)}/>
            </div>
            {voicePhase === 'released' ? <div className="mg-voice-result">
              <span className="mg-orb mg-result-orb"><Icon name="check" size={16}/></span>
              <input aria-label="识别结果" value={voiceText} onChange={event => { setVoiceText(event.target.value); inputFeedback(event.target.value, event.target); }}/>
            </div> : <button type="button" className="mg-record mg-orb" data-pressed={voicePhase === 'holding'} aria-label="按住说话" disabled={loading || saving}
              onPointerDown={event => { if (event.button === 0 || event.pointerType !== 'mouse') { event.currentTarget.setPointerCapture(event.pointerId); startHold(); } }}
              onPointerUp={endHold} onPointerCancel={endHold} onContextMenu={event => event.preventDefault()}>
              <WaveBars/>
              <span className="mg-record-label">{voicePhase === 'holding' ? '正在听…松开结束' : '按住说话'}</span>
            </button>}
          </div>
        </div>}
        {chapter === 'search' && <div className="mg-split mg-search" data-phase={searchPhase}>
          <SceneHeading text={'想知道什么，\n直接问。'} asset={portraitExpression} speaking={speaking} character={look.character} caption={caption}/>
          <div className="mg-search-board">
            <div className="mg-search-row">
              <div className="mg-lens mg-orb" data-open={searchPhase !== 'query'} aria-hidden="true"><Icon name="search" size={26}/><i/></div>
              <button type="button" className="mg-query" onClick={runQuery} disabled={searchPhase !== 'query' || loading}>为什么雨后，会有特别的味道？<Icon name="arrow" size={16}/></button>
            </div>
            {searchPhase !== 'query' && <div className="mg-results">
              {searchResults.map((item, index) => <button type="button" key={item.title} className="mg-result" data-selected={searchPhase === 'source' && source === index} data-dim={searchPhase === 'source' && source !== index} onClick={() => openSource(index)} disabled={searchPhase !== 'results' || loading}>
                <span className="mg-result-mark"><Icon name="search" size={15}/></span>
                <span className="mg-result-copy"><b>{item.title}</b><span className="mg-result-source">{item.source}</span></span>
                <Icon name="external" size={14}/>
              </button>)}
            </div>}
          </div>
        </div>}
        {chapter === 'observe' && <div className="mg-split mg-observe" data-attention={attention}>
          <SceneHeading text={'要不要\n一起看屏幕？'} asset={portraitExpression} speaking={speaking} character={look.character} caption={caption}/>
          <div className="mg-observe-stage">
            <div className="mg-monitor">
              <div className="mg-screen">
                <span className="mg-window w1"/><span className="mg-window w2"/><span className="mg-window w3"/>
                <span className="mg-scan" aria-hidden="true"/>
              </div>
              <span className="mg-eye mg-orb" aria-hidden="true"><Icon name="eye" size={24}/></span>
            </div>
            <label className="mg-switch">
              <input type="checkbox" role="switch" aria-label="允许彩名偶尔看屏幕" checked={attention} disabled={loading || saving} onChange={event => changeAttention(event.target.checked)}/>
              <i/><span>{attention ? '偶尔可以看看' : '不看也没关系'}</span>
            </label>
          </div>
        </div>}
        {(chapter === 'outfit' || chapter === 'placement') && <div className={`mg-split mg-${chapter}`}>
          <SceneHeading text={chapter === 'outfit' ? '今天想看我\n什么样子？' : '这里，\n还是这里？'} asset={portraitExpression} speaking={speaking} character={look.character} caption={caption}/>
          <WelcomeAppearance mode={chapter} look={look} design={portraitDesign} readyCharacters={readyCharacters} disabled={!active || loading || transitioning || leaving || saving}
            onLook={item => void chooseLook(item)}
            onDesign={previewPortrait}
            onCommit={patch => void savePortrait(patch)}
            onReset={() => void savePortrait({ portrait_x: 0, portrait_y: 0, portrait_size: 320 })}/>
        </div>}
        {chapter === 'style' && <div className="mg-split mg-style">
          <SceneHeading text={'换个颜色，\n怎么样？'} asset={portraitExpression} speaking={speaking} character={look.character} caption={caption}/>
          <div className="mg-style-stage">
            <div ref={styleNote} className="mg-style-note" data-theme={theme} style={{
              '--note-bg': wash?.from || selectedTheme.background,
              '--note-fg': notePalette.text,
              '--bubble-bg': selectedTheme.bubble,
              '--bubble-fg': bubblePalette.text,
            } as CSSProperties}>
              {wash && <span className="mg-style-wash" key={wash.id} style={{ background: themes.find(item => item.id === wash.id)?.background, '--x': `${wash.x}px`, '--y': `${wash.y}px` } as CSSProperties}/>}
              <div className="mg-style-top"><b>彩名</b></div>
              <div className="mg-style-bubble">这个颜色怎么样？</div>
            </div>
            <div className="mg-swatches">
              {themes.map(item => <button type="button" key={item.id} aria-label={item.name} aria-pressed={theme === item.id} disabled={loading || saving} onClick={event => chooseTheme(item, event)}>
                <i className={theme === item.id ? 'mg-orb' : undefined} style={{ background: item.background, color: surfacePalette(item.background).text }}>{theme === item.id && <Icon name="check" size={14}/>}</i>
              </button>)}
            </div>
          </div>
        </div>}
        {chapter === 'ready' && <div className="mg-split mg-ready">
          <div aria-live="polite"><SceneHeading text={summoned ? '来了，\n我在呢。' : '以后想聊，\n就按这组键。'} asset={portraitExpression} speaking={speaking} character={look.character} caption={caption}/></div>
          <div className="mg-ready-stage" data-summoned={summoned}>
            <button type="button" className="mg-orb mg-ready-orb" aria-label="试试呼出彩名" title="点一下，试试呼出彩名" onClick={event => {
              setSummoned(true); soundRef.current?.cue('ready'); feedback.current?.pulse(find('.mg-ready-stage .mg-keys'), 'pop'); feedback.current?.burst(event.currentTarget, true);
            }}><Icon name={summoned ? 'check' : 'arrow'} size={18}/></button>
            <WelcomeShortcut field="hotkey" value={String(state.settings.hotkey || 'Control+Alt+A')} disabled={!active || loading || transitioning || leaving || saving}
              onSaved={() => { setSummoned(false); settingSucceeded(); }} onTesting={() => setSummoned(false)} onTested={() => { setSummoned(true); feedback.current?.burst(find('.mg-ready-orb'), true); }} onCue={cue => soundRef.current?.cue(cue)}/>
          </div>
        </div>}
      </div>
    </section>

    <footer className="mg-footer">
      {chapterIndex > 0 && <button type="button" className="mg-back" aria-label="上一页" title="上一页（←）" disabled={loading || transitioning || saving || leaving} onClick={previous}>←</button>}
      {status && <p className="mg-service-status" role={error ? 'alert' : 'status'}>{status}</p>}
      <div className="mg-actions">
        {chapter === 'ready' && !modelReady && <button type="button" className="mg-link" disabled={!canSave} onClick={() => void bridge.openSettings('model')}>配置 API Key 与模型</button>}
        {canContinue && <button type="button" className="mg-next" title={chapter === 'ready' && !modelReady ? '请先配置 API Key 与模型名称' : chapter === 'ready' ? '进入桌面（Enter）' : '下一页（→ / Enter）'} disabled={saving || leaving || transitioning || (chapter === 'ready' && (!canSave || !modelReady))} onClick={advance}>{chapter === 'ready' ? '进入桌面' : '继续'}<Icon name="arrow" size={16}/></button>}
      </div>
    </footer>
  </main>;
}
