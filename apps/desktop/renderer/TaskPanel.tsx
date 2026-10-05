import { useState } from 'react';
import { Button, Icon } from './components';
import { bridge, type ModelState } from './state';

export const taskLabels: Record<string, string> = {
  running: '正在处理', waiting_approval: '等待你确认', paused: '已暂停', succeeded: '已完成',
  failed: '未完成', cancelled: '已取消', interrupted: '已中断', needs_verification: '结果仍待核实',
  replied: '已回复', blocked: '暂时无法继续', needs_input: '需要补充信息',
};

export function TaskPanel({ state, send }: { state: ModelState; send: (command: { type: string; [key: string]: unknown }) => Promise<boolean> }) {
  const active = state.activeTask;
  const status = String(active?.state || '');
  const [computerGoal, setComputerGoal] = useState('');
  const [startingComputer, setStartingComputer] = useState(false);
  const [changingAccess, setChangingAccess] = useState(false);
  const fullAccess = state.settings.full_access === true;
  const canExecute = fullAccess || state.mode === 'execute';
  const changeAccess = async () => {
    if (changingAccess) return;
    setChangingAccess(true);
    try { await send({ type: 'settings.update', settings: { full_access: !fullAccess } }); }
    finally { setChangingAccess(false); }
  };
  const shellResults = state.tools.filter(event => event.tool === 'shell.run' && event.type !== 'tool.started').slice(-5).reverse();
  const computerAvailable = Boolean(state.computerUse?.available);
  const taskBusy = ['running', 'paused', 'waiting_approval'].includes(status);
  const startComputer = async () => {
    if (startingComputer) return;
    setStartingComputer(true);
    try { await send({ type: 'computer.start', goal: computerGoal.trim() }); }
    finally { setStartingComputer(false); }
  };
  const latestFiles = state.artifacts.filter((file, index, all) => all.findIndex(other => other.root_id === file.root_id && other.path === file.path) === index);
  const choose = async (write: boolean) => {
    const selected = await bridge.chooseDirectory();
    if (selected) await send({ type: 'directory.grant', path: selected, write });
  };
  return <section className="agent-workspace" aria-label="任务与结果">
    <div className="agent-section-heading"><span className="eyebrow">AYANA WORKSPACE</span><h2>把事情，一步步做好。</h2><p>资料的出处、保存的文件，还有需要你决定的下一步。</p></div>
    <section className={`agent-full-access ${fullAccess ? 'enabled' : ''}`} aria-label="访问权限">
      <div><span className="eyebrow">ACCESS CONTROL</span><h3 id="full-access-title">Full access <small>{fullAccess ? '已开启' : '已关闭'}</small></h3>
        <p id="full-access-description">{fullAccess ? 'Ayana 可以读写任意本机路径、执行命令和操作应用，直接完成你交代的任务。' : '开启后允许读写任意本机路径、执行命令和操作应用，无需逐步确认。'}</p>
        <small>选择保存在本机。切换会停止当前任务；关闭后恢复目录授权与操作确认。</small></div>
      <button type="button" role="switch" aria-checked={fullAccess} aria-labelledby="full-access-title" aria-describedby="full-access-description" disabled={!state.connected || !state.settingsLoaded || changingAccess} onClick={() => void changeAccess()} className="full-access-switch"><span/></button>
    </section>
    <section className="agent-access"><h3>打开应用与文件</h3><p>{fullAccess ? '直接在对话框交代任务，例如“打开记事本”或“读取 D 盘项目并修改配置”。文件工具和命令可以访问完整路径。' : '启用执行模式后，可以直接在对话框说“打开记事本”“打开计算器”或“打开这个网址”。查找和打开本地文档时，先在下方添加文件所在的目录。'}</p><p className="agent-empty">打开应用后，Ayana 可以查找它的窗口并继续观察。文件是否支持读取内容，和是否能用默认应用打开，是两种能力。</p></section>
    <section className="agent-computer" aria-label="桌面任务">
      <h3><Icon name="monitor" size={16}/> 桌面任务</h3>
      <p>目标窗口：<strong>{state.target?.title || '请先在右侧选择窗口'}</strong></p>
      <label htmlFor="computer-goal">希望 Ayana 在这个窗口里做什么？</label>
      <textarea id="computer-goal" rows={3} maxLength={4000} value={computerGoal} onChange={event => setComputerGoal(event.target.value)} placeholder="例如：把输入框中的内容替换为你好 Ayana，再点击应用并确认结果。"/>
      <div className="agent-buttons">
        {!canExecute && <Button onClick={() => void send({ type: 'mode.set', mode: 'execute' })}>切换到执行模式</Button>}
        <Button color="primary" disabled={!state.connected || !computerAvailable || !state.target || !canExecute || !computerGoal.trim() || taskBusy || startingComputer} onClick={() => void startComputer()}>{startingComputer ? '正在开始…' : '开始桌面任务'}</Button>
      </div>
      <p className="agent-empty">{computerAvailable ? '会自动观察、操作并核实当前窗口。执行期间可以暂停或取消；切换到其他应用会停止操作。' : String(state.computerUse?.detail || '正在检查桌面执行能力…')}</p>
      {!!state.computerProgress.length && <ol className="agent-computer-progress" aria-live="polite">{state.computerProgress.filter(event => event.message).slice(-6).map((event, index) => <li key={index}>{String(event.message)}</li>)}</ol>}
      {state.computerResult && <article className="agent-computer-result"><strong>{taskLabels[String(state.computerResult.status)] || '任务结果'}</strong><p>{String(state.computerResult.reason)}</p><small>{Math.round(Number(state.computerResult.duration_ms || 0) / 1000)} 秒 · {String(state.computerResult.steps || 0)} 步</small></article>}
    </section>
    {active && <article className="agent-task" aria-live="polite">
      <span className={`agent-state state-${status}`}>{taskLabels[status] || status}</span>
      <h3>{String(active.goal || '')}</h3>
      {Boolean(active.reason) && <p>{String(active.reason)}</p>}
      {Array.isArray(active.checks) && active.checks.length > 0 && <ul>{active.checks.map((check, index) => {
        const item = check as Record<string, unknown>;
        return <li key={index}>{item.verified ? '已核实' : '待核实'} · {String(item.description)}</li>;
      })}</ul>}
      <small>已使用 {String(active.calls || 0)} 次工具 · {String(active.rounds || 0)} 轮处理</small>
      <div className="agent-buttons">
        {status === 'running' && <Button onClick={() => void send({ type: 'task.pause' })}>暂停</Button>}
        {status === 'paused' && <Button onClick={() => void send({ type: 'task.resume' })}>继续</Button>}
        {['running', 'paused', 'waiting_approval'].includes(status) && <Button color="danger" variant="light" onClick={() => void send({ type: 'task.cancel' })}>取消任务</Button>}
      </div>
    </article>}
    {state.approvals.map(item => <article className="agent-approval" key={String(item.approval_id)}>
      <span className="agent-state">需要确认</span>
      <h3>{item.kind === 'file' ? `修改 ${String(item.path)}` : String(item.expected_result || '执行窗口操作')}</h3>
      {item.kind === 'file' ? <pre className="agent-diff">{String(item.diff || '内容没有变化。')}</pre> : <p>{String(item.action_kind)}{item.text ? ` · ${String(item.text)}` : ''}</p>}
      {state.mode !== 'execute' && <p>请在执行模式下开始修改任务。切换模式会取消当前预览。</p>}
      <div className="agent-buttons"><Button color="primary" disabled={state.mode !== 'execute' && item.action_kind !== 'highlight'} onClick={() => void send({ type: 'approval.resolve', approval_id: item.approval_id, accept: true })}>确认这一步</Button><Button variant="light" onClick={() => void send({ type: 'approval.resolve', approval_id: item.approval_id, accept: false })}>拒绝</Button></div>
    </article>)}
    {!!shellResults.length && <details className="agent-shell-results"><summary>命令执行记录</summary>{shellResults.map(event => {
      const result = event.result as Record<string, unknown> | undefined;
      return <article key={String(event.call_id)}><strong>{event.type === 'tool.failed' ? '执行失败' : result?.timed_out ? '命令已超时停止' : `退出码 ${String(result?.exit_code)}`}</strong>{Boolean(result?.cwd) && <small>{String(result?.cwd)}</small>}<pre>{String(event.message || [result?.stdout, result?.stderr].filter(Boolean).join('\n') || '命令未输出文本。')}</pre>{Boolean(result?.truncated) && <small>输出过长，已截断显示。</small>}</article>;
    })}</details>}
    <div className="agent-results-grid">
      <section><h3><Icon name="file" size={16}/> 保存的文件 <small>{latestFiles.length}</small></h3>
        {!state.artifacts.length && <p className="agent-empty">生成的笔记与修改结果会出现在这里。</p>}
        {latestFiles.map(item => <article className="agent-result" key={String(item.artifact_id)}><strong>{String(item.path)}</strong><small>{String(item.absolute_path || '')}</small>{Boolean(item.unavailable) && <p>文件暂时无法访问。</p>}{Boolean(item.changed) && <p>文件已在任务之外修改。</p>}<div className="agent-buttons"><Button variant="light" disabled={Boolean(item.unavailable)} onClick={() => void send({ type: 'artifact.open', artifact_id: item.artifact_id })}>打开文件</Button>{Boolean(item.can_restore) && <Button variant="light" disabled={Boolean(item.unavailable || item.changed)} onClick={() => void send({ type: 'artifact.restore', artifact_id: item.artifact_id })}>预览恢复版本</Button>}</div></article>)}
      </section>
      <section><h3><Icon name="eye" size={16}/> 资料来源 <small>{state.sources.length}</small></h3>
        {!state.sources.length && <p className="agent-empty">联网读取后的真实来源会保留在这里。</p>}
        {state.sources.map(item => <button className="agent-source" key={String(item.source_id)} onClick={() => void send({ type: 'source.open', source_id: item.source_id })}><strong>{String(item.title || item.url)}</strong><small>{String(item.url)}</small>{Boolean(item.summary) && <p>{String(item.summary)}</p>}</button>)}
      </section>
    </div>
    <section className="agent-access"><h3>文件访问范围</h3><p>{fullAccess ? 'Full access 已允许访问任意本机路径。下列目录授权会在关闭后继续生效。' : '产出目录用于保存新文件。修改其他目录的文本，需要你在这里授权。'}</p>
      {state.directories.filter(item => item.root_id !== 'filesystem').map(item => <div className="agent-directory" key={String(item.root_id)}><span><strong>{item.root_id === 'output' ? '默认产出目录' : item.write ? '可修改文本' : '只读目录'}</strong><small>{String(item.path)}</small></span>{item.root_id !== 'output' && <Button variant="light" onClick={() => void send({ type: 'directory.revoke', root_id: item.root_id })}>撤销</Button>}</div>)}
      <div className="agent-buttons"><Button onClick={() => void choose(false)}>添加只读目录</Button><Button onClick={() => void choose(true)}>授权文本修改</Button></div>
      <p className="agent-search-status">{state.searchConfigured ? '联网搜索已可用。' : '当前搜索方式缺少凭据；可配置凭据或切换到 Bing。'} 默认使用 Bing，无需 API Key；配置 Brave 凭据后可使用 Brave 搜索。</p>
    </section>
    {!!state.taskHistory.length && <details className="agent-task-history"><summary>最近任务</summary>{state.taskHistory.map(item => <p key={String(item.task_id)}><span>{taskLabels[String(item.state)] || String(item.state)}</span> {String(item.goal)}</p>)}</details>}
  </section>;
}
