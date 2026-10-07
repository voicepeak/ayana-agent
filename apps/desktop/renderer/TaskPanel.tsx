import { useState, type ReactNode } from 'react';
import { Button, Icon } from './components';
import type { ModelState } from './state';

export const taskLabels: Record<string, string> = {
  running: '正在处理', waiting_approval: '等待你确认', paused: '已暂停', succeeded: '已完成',
  failed: '未完成', cancelled: '已取消', interrupted: '已中断', needs_verification: '结果仍待核实',
  replied: '已回复', blocked: '暂时无法继续', needs_input: '需要补充信息',
};

export function TaskPanel({ state, send, controls }: { state: ModelState; send: (command: { type: string; [key: string]: unknown }) => Promise<boolean>; controls: ReactNode }) {
  const active = state.activeTask;
  const status = String(active?.state || '');
  const [computerGoal, setComputerGoal] = useState('');
  const [startingComputer, setStartingComputer] = useState(false);
  const canExecute = state.settings.full_access === true || state.mode === 'execute';
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
  return <section className="agent-workspace" aria-label="任务与结果">
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
      <span className="agent-state">{item.action_kind === 'create' ? '等待确认 · 尚未写入' : '需要确认'}</span>
      <h3>{item.kind === 'file' ? `${item.action_kind === 'create' ? '新建' : '修改'} ${String(item.path)}` : String(item.expected_result || '执行窗口操作')}</h3>
      {item.kind === 'file' ? <pre className="agent-diff">{String(item.action_kind === 'create' ? (item.preview || '（空文件）') : (item.diff || '内容没有变化。'))}</pre> : <p>{String(item.action_kind)}{item.text ? ` · ${String(item.text)}` : ''}</p>}
      {!canExecute && <p>请在执行模式下开始修改任务。切换模式会取消当前预览。</p>}
      <div className="agent-buttons"><Button color="primary" disabled={!canExecute && item.action_kind !== 'highlight'} onClick={() => void send({ type: 'approval.resolve', approval_id: item.approval_id, accept: true })}>确认这一步</Button><Button variant="light" onClick={() => void send({ type: 'approval.resolve', approval_id: item.approval_id, accept: false })}>拒绝</Button></div>
    </article>)}
    {!!shellResults.length && <details className="agent-shell-results"><summary>命令执行记录</summary>{shellResults.map(event => {
      const result = event.result as Record<string, unknown> | undefined;
      return <article key={String(event.call_id)}><strong>{event.type === 'tool.failed' ? '执行失败' : result?.timed_out ? '命令已超时停止' : `退出码 ${String(result?.exit_code)}`}</strong>{Boolean(result?.cwd) && <small>{String(result?.cwd)}</small>}<pre>{String(event.message || [result?.stdout, result?.stderr].filter(Boolean).join('\n') || '命令未输出文本。')}</pre>{Boolean(result?.truncated) && <small>输出过长，已截断显示。</small>}</article>;
    })}</details>}
    {(latestFiles.length > 0 || state.sources.length > 0) && <div className="agent-results-grid">
      {latestFiles.length > 0 && <section><h3><Icon name="file" size={16}/> 保存的文件 <small>{latestFiles.length}</small></h3>
        {latestFiles.map(item => <article className="agent-result" key={String(item.artifact_id)}><strong>{String(item.path)}</strong><small>{String(item.absolute_path || '')}</small>{Boolean(item.unavailable) && <p>文件暂时无法访问。</p>}{Boolean(item.changed) && <p>文件已在任务之外修改。</p>}<div className="agent-buttons"><Button variant="light" disabled={Boolean(item.unavailable)} onClick={() => void send({ type: 'artifact.open', artifact_id: item.artifact_id })}>打开文件</Button>{Boolean(item.can_restore) && <Button variant="light" disabled={Boolean(item.unavailable || item.changed)} onClick={() => void send({ type: 'artifact.restore', artifact_id: item.artifact_id })}>预览恢复版本</Button>}</div></article>)}
      </section>}
      {state.sources.length > 0 && <section><h3><Icon name="eye" size={16}/> 资料来源 <small>{state.sources.length}</small></h3>
        {state.sources.map(item => <button className="agent-source" key={String(item.source_id)} onClick={() => void send({ type: 'source.open', source_id: item.source_id })}><strong>{String(item.title || item.url)}</strong><small>{String(item.url)}</small>{Boolean(item.summary) && <p>{String(item.summary)}</p>}</button>)}
      </section>}
    </div>}
    {!active && !state.approvals.length && !latestFiles.length && !state.sources.length && !shellResults.length && !state.computerProgress.length && !state.computerResult && <div className="task-empty"><Icon name="check" size={28}/><h3>暂无任务</h3><p>在对话中交代任务，进度和结果会显示在这里。</p></div>}
      {!!state.computerProgress.length && <ol className="agent-computer-progress" aria-live="polite">{state.computerProgress.filter(event => event.message).slice(-6).map((event, index) => <li key={index}>{String(event.message)}</li>)}</ol>}
      {state.computerResult && <article className="agent-computer-result"><strong>{taskLabels[String(state.computerResult.status)] || '任务结果'}</strong><p>{String(state.computerResult.reason)}</p><small>{Math.round(Number(state.computerResult.duration_ms || 0) / 1000)} 秒 · {String(state.computerResult.steps || 0)} 步</small></article>}
    <details className="task-controls"><summary>窗口操作</summary>
      {controls}
      <section className="agent-computer" aria-label="桌面任务">
      <label htmlFor="computer-goal">窗口任务</label>
      <textarea id="computer-goal" rows={3} maxLength={4000} value={computerGoal} onChange={event => setComputerGoal(event.target.value)} placeholder="输入要在这个窗口完成的任务…"/>
      <div className="agent-buttons">
        {!canExecute && <Button onClick={() => void send({ type: 'mode.set', mode: 'execute' })}>切换到执行模式</Button>}
        <Button color="primary" disabled={!state.connected || !computerAvailable || !state.target || !canExecute || !computerGoal.trim() || taskBusy || startingComputer} onClick={() => void startComputer()}>{startingComputer ? '正在开始…' : '开始桌面任务'}</Button>
      </div>
      {!computerAvailable && <p className="agent-empty">{String(state.computerUse?.detail || '桌面执行暂未就绪')}</p>}
      </section>
    </details>
    {!!state.taskHistory.length && <details className="agent-task-history"><summary>最近任务</summary>{state.taskHistory.map(item => <p key={String(item.task_id)}><span>{taskLabels[String(item.state)] || String(item.state)}</span> {String(item.goal)}</p>)}</details>}
  </section>;
}
