import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Icon, Input } from './components';
import { bridge, type ModelState } from './state';
import { preferences, preferencePatch, savePreferences, type Preferences } from './preferences';
import { catalogFor, characterOptions, costumesOf } from './avatarCatalogs';

export const settingsSections = [
  { id: 'appearance', title: '外观与声音', icon: 'volume' },
  { id: 'model', title: '模型与连接', icon: 'message' },
  { id: 'access', title: '权限与隐私', icon: 'eye' },
  { id: 'advanced', title: '高级设置', icon: 'settings' },
] as const;
export type SettingsSection = typeof settingsSections[number]['id'];
const names: Record<string, string> = { starting: '启动中', loading: '加载中', warming: '预热中', ready: '已就绪', failed: '不可用', stopped: '已停止', idle: '空闲' };

function Toggle({ children, checked, onChange, note }: { children: ReactNode; checked: boolean; onChange: (value: boolean) => void; note?: string }) {
  return <label className="preference-toggle"><span>{children}{note && <small>{note}</small>}</span><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)}/></label>;
}

export function Settings({ state, section }: { state: ModelState; section: SettingsSection }) {
  const [draft, setDraft] = useState(() => preferences(state.settings));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [restarting, setRestarting] = useState(false);
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
        task_limits: { ...next.task_limits, ...(edits.task_limits as Preferences['task_limits'] || {}) },
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
  const costumes = costumesOf(catalogFor(draft.character));
  async function save() {
    if (saving || !dirty) return;
    setSaving(true); setError(''); setMessage('');
    try {
      await savePreferences(preferencePatch(saved, draft));
      setMessage('已保存');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  }
  async function directory(command: Record<string, unknown> & { type: string }) {
    setError('');
    try { const result = await bridge.send(command); if (!result.ok) setError(result.error || '操作未完成'); }
    catch (reason) { setError(String(reason)); }
  }
  async function choose(write: boolean) {
    try { const path = await bridge.chooseDirectory(); if (path) await directory({ type: 'directory.grant', path, write }); }
    catch (reason) { setError(String(reason)); }
  }
  const count = (key: 'max_utterances' | 'detailed_max_utterances' | 'model_max_tokens', title: string, min: number, max: number) =>
    <label>{title}<Input type="number" min={min} max={max} step={1} required value={draft[key]} onChange={event => update(key, Number(event.target.value))}/></label>;
  return <section className="settings-workspace" aria-label="设置中心">
    <form className="settings-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={saving || !state.settingsLoaded} className="settings-fields" key={section}>
      {section === 'appearance' && <>
        <div className="form-section"><h3>形象与声音</h3>
          <label>角色<select aria-label="角色" value={draft.character} onChange={event => changeCharacter(event.target.value)}>{characters.map(item => <option key={item.id} value={item.id} disabled={readyCharacters.get(item.id) === false && item.id !== draft.character}>{item.name}{readyCharacters.get(item.id) === false ? '（资源未导入）' : ''}</option>)}</select></label>
          <p className="form-hint">切换角色会同时更换立绘和声音；人设、记忆与使用设置保持不变。</p>
          <label>服装<select aria-label="服装" value={draft.avatar_costume} onChange={event => update('avatar_costume', event.target.value)}>{costumes.map(item => <option key={item}>{item}</option>)}</select></label>
          <p className="form-hint">字幕语言在彩名窗口的「外观 → 对白」中调整，可选择主语言与翻译语言。</p>
          <Toggle checked={draft.sentence_motion} onChange={value => update('sentence_motion', value)}>表情切换动效</Toggle>
        </div>
        <div className="form-section"><h3>声音</h3><label>语音引擎<select aria-label="语音引擎" value={draft.voice.voice_mode} onChange={event => update('voice', { voice_mode: event.target.value })}><option value="auto">自动选择</option><option value="sovits">Ayana 本地音色</option><option value="system">Windows 日语语音</option><option value="silent">仅显示文字</option></select></label>
          <label>播放音量 · {Math.round(draft.volume * 100)}%<input aria-label="播放音量" type="range" min="0" max="1" step="0.05" value={draft.volume} disabled={draft.voice.voice_mode === 'silent'} onChange={event => update('volume', Number(event.target.value))}/></label>
        </div>
      </>}
      {section === 'model' && <>
        <div className="form-section"><h3>对话模型</h3><label>模型模式<select aria-label="模型模式" value={draft.provider} onChange={event => update('provider', event.target.value)}><option value="local">本地演示</option><option value="openai">在线模型</option></select></label>
        {draft.provider === 'openai' && <><label>服务地址<Input type="url" required value={draft.base_url} onChange={event => update('base_url', event.target.value)} placeholder="https://api.openai.com/v1"/></label><label>模型名称<Input required value={draft.model} onChange={event => update('model', event.target.value)} placeholder="模型名称"/></label><p className="field-note">API 凭据{state.apiKeyConfigured === undefined ? '尚未检查' : state.apiKeyConfigured ? '已配置' : '未配置 · 请使用本机环境变量或凭据文件'}</p></>}
        </div>
        <div className="form-section"><h3>联网搜索</h3><label>搜索引擎<select aria-label="搜索引擎" value={draft.search_provider} onChange={event => update('search_provider', event.target.value)}><option value="auto">自动选择</option><option value="bing">Bing</option><option value="brave">Brave</option></select></label>{draft.search_provider === 'brave' && !state.searchConfigured && <p className="field-note">需要配置独立的 Brave 搜索凭据。</p>}</div>
      </>}
      {section === 'access' && <>
        <div className="form-section"><h3>访问权限</h3>
          <Toggle checked={draft.full_access} onChange={value => update('full_access', value)} note="允许读写任意本机路径、执行命令和操作应用，无需逐步确认。">完全访问（Full access）</Toggle>
          <details className="preference-advanced"><summary>目录授权{draft.full_access ? ' · 完全访问关闭后生效' : ''}</summary>
            {state.directories.filter(item => item.root_id !== 'filesystem').map(item => <div className="agent-directory" key={String(item.root_id)}><span><strong>{item.root_id === 'output' ? '默认产出目录' : item.write ? '可读写' : '只读'}</strong><small>{String(item.path)}</small></span>{item.root_id !== 'output' && <Button type="button" variant="light" disabled={!state.connected} onClick={() => void directory({ type: 'directory.revoke', root_id: item.root_id })}>撤销授权</Button>}</div>)}
            <div className="agent-buttons"><Button type="button" disabled={!state.connected} onClick={() => void choose(false)}>添加只读目录</Button><Button type="button" disabled={!state.connected} onClick={() => void choose(true)}>添加可读写目录</Button></div>
          </details>
        </div>
        <div className="form-section"><h3>隐私</h3><Toggle checked={draft.send_screenshot} onChange={value => update('send_screenshot', value)} note="需要看屏幕时，将窗口或桌面截图发送给模型。">允许屏幕观察</Toggle><Toggle checked={draft.ambient_attention} onChange={value => update('ambient_attention', value)} note="空闲时偶尔看看前台窗口，有值得聊的事情才搭话；也可以说“别看了”。">允许彩名偶尔偷看</Toggle><Toggle checked={draft.save_history} onChange={value => update('save_history', value)} note="切换会新建话题；关闭不会删除已有记录。">保存对话记录</Toggle></div>
      </>}
      {section === 'advanced' && <>
        <details className="preference-advanced"><summary>快捷键</summary><div className="form-grid"><label>呼出 Ayana<Input required value={draft.hotkey} onChange={event => update('hotkey', event.target.value)}/></label><label>立即打断<Input required value={draft.cancel_hotkey} onChange={event => update('cancel_hotkey', event.target.value)}/></label></div>{state.shortcuts && (!state.shortcuts.summon_ok || !state.shortcuts.cancel_ok) && <p className="shortcut-error" role="alert">快捷键注册失败，请更换组合。</p>}</details>
        <details className="preference-advanced"><summary>回复与任务限制</summary><div className="form-grid">{count('max_utterances', '普通回复最多句数', 1, 12)}{count('detailed_max_utterances', '详细回复最多句数', 12, 64)}{draft.provider === 'openai' && count('model_max_tokens', '单次请求输出上限（tokens）', 1000, 12000)}</div><div className="form-grid">{([['rounds', '最多处理轮数', 24], ['calls', '最多工具调用', 64], ['seconds', '最长时间（秒）', 600]] as const).map(([key, title, max]) => <label key={key}>{title}<Input type="number" min="1" max={max} step="1" required value={draft.task_limits[key]} onChange={event => update('task_limits', { ...draft.task_limits, [key]: Number(event.target.value) })}/></label>)}</div></details>
        <details className="preference-advanced"><summary>接口兼容与代理</summary><Toggle checked={draft.native_tools} onChange={value => update('native_tools', value)}>原生工具调用</Toggle><label>Brave 本机 HTTP 代理<Input value={draft.search_proxy} onChange={event => update('search_proxy', event.target.value)} placeholder="http://127.0.0.1:7892"/></label></details>
        <details className="preference-advanced"><summary>服务与诊断</summary>
          <dl className="service-grid"><div><dt>本地服务</dt><dd>{state.connected ? '已连接' : '未连接'}</dd></div><div><dt>语音引擎</dt><dd>{names[state.voice] || state.voice}</dd></div><div><dt>模型凭据</dt><dd>{state.apiKeyConfigured === undefined ? '尚未检查' : state.apiKeyConfigured ? '已配置' : '未配置'}</dd></div><div><dt>桌面执行</dt><dd>{state.computerUse?.available ? '可用' : '尚未就绪'}</dd></div></dl>
          {Boolean(state.computerUse?.detail) && <p className="field-note">{String(state.computerUse?.detail)}</p>}
          {state.modelUsage && <p className="field-note">最近请求：输入 {String(state.modelUsage.prompt_tokens ?? '未知')} tokens · 缓存 {String(state.modelUsage.prompt_cache_hit_tokens ?? '未知')} tokens</p>}
          <div className="service-actions"><Button type="button" disabled={!state.connected} onClick={() => void bridge.send({ type: 'settings.get' })}>刷新状态</Button><Button type="button" disabled={restarting || saving || dirty} onClick={async () => { setRestarting(true); try { await bridge.restart(); setMessage('正在重启服务…'); } catch (reason) { setError(String(reason)); } finally { setRestarting(false); } }}>重启服务</Button></div>
        </details>
      </>}
      </fieldset>
      <footer className="settings-savebar"><div role="status" aria-live="polite">{error || message || (!state.settingsLoaded ? '正在读取设置…' : dirty ? '有未保存的修改' : '已保存')}{dirty && <small>保存会停止当前任务与语音。</small>}</div>{dirty && <Button type="button" variant="light" disabled={saving} onClick={() => { setDraft(saved); setError(''); setMessage('已撤销修改'); }}>撤销修改</Button>}<Button type="submit" color="primary" variant="solid" disabled={!dirty || !state.connected || !state.settingsLoaded || saving}>{saving ? '保存中…' : '保存设置'}<Icon name="check" size={15}/></Button></footer>
    </form>
  </section>;
}
