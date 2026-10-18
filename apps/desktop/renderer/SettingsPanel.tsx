import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Icon, Input } from './components';
import { bridge, type ModelState } from './state';
import { preferences, preferencePatch, saveApiKey, savePreferences, type Preferences } from './preferences';
import { catalogFor, characterOptions, costumesOf } from './avatarCatalogs';
import { VoicePackSettings } from './VoicePack';
import { outfitAsset } from './avatarOutfit';

export const settingsSections = [
  { id: 'appearance', title: '外观与声音', icon: 'volume' },
  { id: 'model', title: '模型与连接', icon: 'message' },
  { id: 'access', title: '观察与隐私', icon: 'eye' },
  { id: 'advanced', title: '高级设置', icon: 'settings' },
] as const;
export type SettingsSection = typeof settingsSections[number]['id'];
const names: Record<string, string> = { starting: '启动中', loading: '加载中', warming: '预热中', ready: '已就绪', failed: '不可用', stopped: '已停止', idle: '空闲' };

function Toggle({ children, checked, onChange, note }: { children: ReactNode; checked: boolean; onChange: (value: boolean) => void; note?: string }) {
  return <label className="preference-toggle"><span>{children}{note && <small>{note}</small>}</span><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)}/></label>;
}

function SettingCard({ title, icon, tone = 'coral', className = '', children }: { title: string; icon: string; tone?: string; className?: string; children: ReactNode }) {
  return <section className={`form-section setting-card ${className}`} data-tone={tone}>
    <h3><span className="setting-card-icon"><Icon name={icon} size={20}/></span>{title}</h3>{children}
  </section>;
}

function SettingsDisclosure({ title, icon, children }: { title: string; icon: string; children: ReactNode }) {
  return <details className="preference-advanced"><summary><span className="setting-card-icon"><Icon name={icon} size={20}/></span>{title}<span className="disclosure-chevron" aria-hidden="true"/></summary><div className="disclosure-content">{children}</div></details>;
}

export function Settings({ state, section }: { state: ModelState; section: SettingsSection }) {
  const [draft, setDraft] = useState(() => preferences(state.settings));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [restarting, setRestarting] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiKeyMessage, setApiKeyMessage] = useState('');
  const saved = preferences(state.settings);
  const baseline = useRef(saved);
  const dirty = Object.keys(preferencePatch(saved, draft)).length > 0;
  useEffect(() => {
    const previous = baseline.current;
    setDraft(current => {
      const edits = preferencePatch(previous, current);
      const next = preferences(state.settings);
      return { ...next, ...edits,
        voice: { ...next.voice, ...(edits.voice as Preferences['voice'] || {}) },
        stt: { ...next.stt, ...(edits.stt as Preferences['stt'] || {}) },
      } as Preferences;
    });
    baseline.current = preferences(state.settings);
  }, [state.settings]);
  const update = <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    setDraft(current => ({ ...current, [key]: value })); setMessage(''); setError('');
  };
  const changeCharacter = (character: string) => {
    const nextCostumes = costumesOf(catalogFor(character));
    setDraft(current => ({ ...current, character,
      avatar_costume: nextCostumes.includes(current.avatar_costume) ? current.avatar_costume : nextCostumes[0] }));
    setMessage(''); setError('');
  };
  const characters = characterOptions();
  const readyCharacters = new Map(((state.settings.character_options as { id: string; ready: boolean }[] | undefined) || [])
    .map(item => [item.id, item.ready]));
  const voiceResourcesReady = Boolean((state.settings.voice as Record<string, unknown> | undefined)?.engine_root);
  const voiceInfo = state.voiceInfo;
  const voiceVram = Number(voiceInfo?.vram_total_mb || 0);
  const voiceDevice = voiceInfo ? [
    voiceInfo.gpu_name ? String(voiceInfo.gpu_name) : (voiceInfo.device_mode === 'cpu' || voiceInfo.device === 'cpu') ? 'CPU' : '',
    voiceInfo.precision ? `精度 ${String(voiceInfo.precision)}` : '',
    voiceVram > 0 ? `${voiceVram} MB 显存` : '',
  ].filter(Boolean).join(' · ') : '';
  const costumes = costumesOf(catalogFor(draft.character));
  const portrait = outfitAsset('neutral', draft.avatar_costume, catalogFor(draft.character));
  async function save() {
    if (saving || !dirty) return;
    setSaving(true); setError(''); setMessage('');
    try {
      const patch = preferencePatch(saved, draft);
      if (draft.provider !== 'openai' && String(draft.model ?? '').trim()) patch.provider = 'openai';
      await savePreferences(patch);
      setMessage('已保存');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  }
  async function storeApiKey(clear = false) {
    if (apiKeySaving || !state.connected) return;
    const value = clear ? '' : apiKey.trim();
    if (!clear && !value) return;
    setApiKeySaving(true); setApiKeyMessage(''); setError('');
    try {
      await saveApiKey(value);
      setApiKey('');
      setApiKeyMessage(clear ? '已清除本机保存的密钥。' : '密钥已加密保存，可以用于在线模型。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setApiKeySaving(false); }
  }
  const count = (key: 'max_utterances' | 'max_tool_rounds' | 'model_max_tokens' | 'history_budget_chars' | 'ambient_interval_min' | 'ambient_interval_max', title: string, min: number, max: number) =>
    <label>{title}<Input type="number" min={min} max={max} step={1} required value={draft[key]} onChange={event => update(key, Number(event.target.value))}/></label>;
  return <section className="settings-workspace" aria-label="设置中心" data-section={section}>
    <form className="settings-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={saving || !state.settingsLoaded} className="settings-fields" key={section}>
      {section === 'appearance' && <>
        <SettingCard title="与你相处" icon="sparkles" className="settings-profile">
          <div className="settings-profile-fields">
          <label>彩名对你的称呼<Input required maxLength={32} value={draft.user_name} onChange={event => update('user_name', event.target.value)} placeholder="你希望被称呼的名字"/></label>
          <Button type="button" disabled={saving || dirty} onClick={() => void bridge.openWelcome()}>重看初次见面<Icon name="arrow" size={15}/></Button>
          </div>
          <div className="settings-profile-art" aria-hidden="true"><span className="profile-orbit"/><Icon name="sparkles" size={30}/>{state.connected && state.settingsLoaded && <img key={`${draft.character}:${portrait}`} src={`ayana-asset://${portrait}/?character=${encodeURIComponent(draft.character)}`} alt="" draggable={false}/>}<span className="profile-sticker">彩名</span></div>
        </SettingCard>
        <SettingCard title="今天的模样" icon="portrait" tone="mint">
          <label>角色<select aria-label="角色" value={draft.character} onChange={event => changeCharacter(event.target.value)}>{characters.map(item => <option key={item.id} value={item.id} disabled={readyCharacters.get(item.id) === false && item.id !== draft.character}>{item.name}{readyCharacters.get(item.id) === false ? '（资源未导入）' : ''}</option>)}</select></label>
          <p className="form-hint">立绘和声音一起切换，记忆会留下。</p>
          <label>服装<select aria-label="服装" value={draft.avatar_costume} onChange={event => update('avatar_costume', event.target.value)}>{costumes.map(item => <option key={item}>{item}</option>)}</select></label>
          <p className="form-hint">字幕语言在彩名窗口的「外观 → 对白」中调整。</p>
          <Toggle checked={draft.sentence_motion} onChange={value => update('sentence_motion', value)}>表情切换动效</Toggle>
          <Toggle checked={draft.portrait_bounce} onChange={value => update('portrait_bounce', value)} note="说话时随音量轻轻伸缩，点击立绘也会回弹。">随声音Q弹</Toggle>
        </SettingCard>
        <SettingCard title="听见彩名" icon="volume" tone="lavender"><label>语音引擎<select aria-label="语音引擎" value={draft.voice.voice_mode} onChange={event => update('voice', { voice_mode: event.target.value })}><option value="auto">自动选择</option><option value="sovits" disabled={!voiceResourcesReady}>Ayana 本地音色{voiceResourcesReady ? '' : '（未安装）'}</option><option value="system">Windows 日语语音</option><option value="silent">仅显示文字</option></select></label>
          <label>播放音量 · {Math.round(draft.volume * 100)}%<input aria-label="播放音量" type="range" min="0" max="1" step="0.05" value={draft.volume} disabled={draft.voice.voice_mode === 'silent'} onChange={event => update('volume', Number(event.target.value))}/></label>
          <VoicePackSettings state={state}/>
        </SettingCard>
      </>}
      {section === 'model' && <>
        <SettingCard title="对话模型" icon="message" tone="lavender">
          <p className="form-hint">在线模型是必需项。填写 API Key 与模型名称后才能开始对话。</p>
          <label>服务地址<Input type="url" required value={draft.base_url} onChange={event => update('base_url', event.target.value)} placeholder="https://api.openai.com/v1"/></label>
          <label>模型名称<Input required value={draft.model} onChange={event => update('model', event.target.value)} placeholder="模型名称"/></label>
          <div className="form-grid"><label>温度<Input type="number" min={0} max={2} step={0.1} required value={draft.temperature} onChange={event => update('temperature', Number(event.target.value))}/></label>{count('history_budget_chars', '历史预算（字符）', 16000, 512000)}</div>
          <p className="form-hint">温度越高回复越多变；历史预算越大保留的原样对话越多，接近上限时自动摘要。</p>
          <label>API Key<Input type="password" autoComplete="new-password" spellCheck={false} value={apiKey} onChange={event => { setApiKey(event.target.value); setApiKeyMessage(''); setError(''); }} placeholder={state.apiKeyConfigured ? '已配置 · 输入新密钥可替换' : 'sk-…'}/></label>
          <div className="service-actions"><Button type="button" disabled={apiKeySaving || !apiKey.trim() || !state.connected} onClick={() => void storeApiKey(false)}>保存密钥</Button>{state.apiKeyConfigured && <Button type="button" variant="light" disabled={apiKeySaving || !state.connected} onClick={() => void storeApiKey(true)}>清除密钥</Button>}</div>
          <p className="field-note" role="status">{apiKeyMessage || (state.apiKeyConfigured === undefined ? 'API 凭据尚未检查。' : state.apiKeyConfigured ? 'API 凭据已配置。' : 'API 凭据未配置。')} 密钥使用当前 Windows 用户加密保存在本机，不写入设置文件；环境变量优先。</p>
        </SettingCard>
        <SettingCard title="联网搜索" icon="search" tone="mint"><label>搜索引擎<select aria-label="搜索引擎" value={draft.search_provider} onChange={event => update('search_provider', event.target.value)}><option value="auto">自动选择</option><option value="bing">Bing</option><option value="brave">Brave</option><option value="deepseek">DeepSeek</option></select></label>{draft.search_provider === 'brave' && !state.searchConfigured && <p className="field-note">需要配置独立的 Brave 搜索凭据。</p>}{draft.search_provider === 'deepseek' && <p className="field-note">使用对话模型的 API Key；网页直连失败时会改用 DeepSeek 读取。</p>}</SettingCard>
      </>}
      {section === 'access' && <>
        <SettingCard title="看看你的世界" icon="eye" tone="mint"><Toggle checked={draft.send_screenshot} onChange={value => update('send_screenshot', value)} note="需要看屏幕时，将窗口或桌面截图发送给模型。">允许屏幕观察</Toggle><Toggle checked={draft.ambient_attention} onChange={value => update('ambient_attention', value)} note="空闲时偶尔看看前台窗口；也可以说“别看了”。">允许彩名偶尔偷看</Toggle>{draft.ambient_attention && <><div className="form-grid">{count('ambient_interval_min', '偷看间隔最小（秒）', 15, 600)}{count('ambient_interval_max', '偷看间隔最大（秒）', 15, 600)}</div><p className="form-hint">在这个时间范围内，随机挑个时刻看一眼。</p><Toggle checked={draft.ambient_speech} onChange={value => update('ambient_speech', value)} note="遇到想聊的内容时，可以主动说一句。">偷看时允许搭话</Toggle></>}</SettingCard>
        <SettingCard title="留下聊过的话" icon="book" tone="lavender"><Toggle checked={draft.save_history} onChange={value => update('save_history', value)} note="切换会新建话题；关闭不会删除已有记录。">保存对话记录</Toggle></SettingCard>
      </>}
      {section === 'advanced' && <>
        <SettingsDisclosure title="快捷键" icon="keyboard"><div className="form-grid"><label>呼出 Ayana<Input required value={draft.hotkey} onChange={event => update('hotkey', event.target.value)}/></label><label>按住说话<Input required value={draft.talk_hotkey} onChange={event => update('talk_hotkey', event.target.value)}/></label><label>立即打断<Input required value={draft.cancel_hotkey} onChange={event => update('cancel_hotkey', event.target.value)}/></label></div>{state.shortcuts && (!state.shortcuts.summon_ok || !state.shortcuts.cancel_ok || state.shortcuts.talk_ok === false) && <p className="shortcut-error" role="alert">快捷键注册失败，请更换组合。</p>}</SettingsDisclosure>
        <SettingsDisclosure title="回复限制" icon="message"><div className="form-grid">{count('max_utterances', '每次回复最多句数', 1, 12)}{count('max_tool_rounds', '最多工具轮数', 1, 24)}{draft.provider === 'openai' && count('model_max_tokens', '单次请求输出上限（tokens）', 1000, 12000)}</div></SettingsDisclosure>
        <SettingsDisclosure title="接口兼容与代理" icon="monitor"><Toggle checked={draft.native_tools} onChange={value => update('native_tools', value)}>原生工具调用</Toggle><label>Brave 本机 HTTP 代理<Input value={draft.search_proxy} onChange={event => update('search_proxy', event.target.value)} placeholder="http://127.0.0.1:7892"/></label></SettingsDisclosure>
        <SettingsDisclosure title="服务与诊断" icon="settings">
          <dl className="service-grid"><div><dt>本地服务</dt><dd>{state.connected ? '已连接' : '未连接'}</dd></div><div><dt>语音引擎</dt><dd>{names[state.voice] || state.voice}</dd></div><div><dt>模型凭据</dt><dd>{state.apiKeyConfigured === undefined ? '尚未检查' : state.apiKeyConfigured ? '已配置' : '未配置'}</dd></div></dl>
          {voiceDevice && <p className="field-note">语音设备：{voiceDevice}{voiceInfo?.model_version ? ` · ${String(voiceInfo.model_version)}` : ''}</p>}
          {state.modelUsage && <p className="field-note">最近请求：输入 {String(state.modelUsage.prompt_tokens ?? '未知')} tokens · 缓存 {String(state.modelUsage.prompt_cache_hit_tokens ?? '未知')} tokens</p>}
          <div className="service-actions"><Button type="button" disabled={!state.connected} onClick={() => void bridge.send({ type: 'settings.get' })}>刷新状态</Button><Button type="button" disabled={restarting || saving || dirty} onClick={async () => { setRestarting(true); try { await bridge.restart(); setMessage('正在重启服务…'); } catch (reason) { setError(String(reason)); } finally { setRestarting(false); } }}>重启服务</Button></div>
        </SettingsDisclosure>
      </>}
      </fieldset>
      <footer className={`settings-savebar ${error ? 'has-error' : dirty ? 'is-dirty' : 'is-saved'}`}><span className="save-status-icon" aria-hidden="true"><Icon name={error ? 'close' : dirty ? 'settings' : 'check'} size={18}/></span><div role="status" aria-live="polite">{error || message || (!state.settingsLoaded ? '正在读取设置…' : dirty ? '有未保存的修改' : '已保存')}{dirty && <small>保存会停止当前任务与语音。</small>}</div>{dirty && <Button type="button" variant="light" disabled={saving} onClick={() => { setDraft(saved); setError(''); setMessage('已撤销修改'); }}>撤销修改</Button>}<Button type="submit" color="primary" variant="solid" disabled={!dirty || !state.connected || !state.settingsLoaded || saving}>{saving ? '保存中…' : '保存设置'}<Icon name="check" size={15}/></Button></footer>
    </form>
  </section>;
}
