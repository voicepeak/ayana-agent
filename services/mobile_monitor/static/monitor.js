const $ = id => document.getElementById(id);
const state = { user: '', topic: '', hours: 24, inactive: false, issues: false, paused: false, follow: true, snapshot: null,
  selected: '', detailKey: '', detailEpoch: 0, filterEpoch: 0, inFlight: false, timer: 0 };
const statuses = { failed: '模型回复失败', tts_failed: '语音合成失败', cancelled: '已打断', unresolved: '缺少后续记录', model_wait_long: '模型等待偏长',
  thinking: '模型生成中', audio_wait_long: '语音等待偏长', preparing_audio: '语音合成中', slow_audio: '首段合成偏慢', complete: '已完成' };
const clock = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const calendar = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' });
function time(value) { return value ? clock.format(new Date(value * 1000)) : '—'; }
function recordTime(value) { return value ? `${calendar.format(new Date(value * 1000))} ${time(value)}` : '—'; }
function duration(value) { return value == null ? '—' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`; }
function node(tag, className, text) { const item = document.createElement(tag); if (className) item.className = className; if (text != null) item.textContent = text; return item; }
function key(turn) { return `${turn.user_id}/${turn.id}`; }
function label(uid) { return state.snapshot?.users.find(user => user.id === uid)?.label || uid; }

async function api(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', ...options });
  if (!response.ok) {
    if (response.status === 401) showLogin();
    let message = '面板暂时无法读取记录';
    try { const value = await response.json(); if (typeof value.detail === 'string') message = value.detail; } catch {}
    throw new Error(message);
  }
  return response.json();
}

function showLogin() { $('console').hidden = true; $('login').hidden = false; clearTimeout(state.timer); }
async function signIn(token) {
  await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  $('admin-token').value = '';
  await begin();
}
async function begin() { $('login').hidden = true; $('console').hidden = false; await refresh(); schedule(); }
function schedule() { clearTimeout(state.timer); if (!$('console').hidden) state.timer = setTimeout(async () => { if (!state.paused) await refresh(); schedule(); }, 2000); }

async function refresh() {
  if (state.inFlight) return;
  state.inFlight = true;
  const epoch = state.filterEpoch;
  try {
    const query = new URLSearchParams({ user_id: state.user, conversation_id: state.topic, hours: state.hours,
      include_inactive: state.inactive, issues_only: state.issues });
    const data = await api(`/api/snapshot?${query}`);
    if (epoch !== state.filterEpoch) return;
    state.snapshot = data;
    $('connection-error').hidden = true;
    $('live-dot').className = state.paused ? 'paused' : '';
    $('live-label').textContent = state.paused ? '面板刷新已暂停' : '只读监听 · 2 秒刷新';
    $('sync-time').textContent = time(data.now);
    render(data);
  } catch (error) {
    if (epoch !== state.filterEpoch || $('console').hidden) return;
    $('connection-error').textContent = `${error.message}。保留上次视图，将自动重试；手机服务不会因此被重启。`;
    $('connection-error').hidden = false;
    $('live-dot').className = 'error'; $('live-label').textContent = '面板读取中断';
  } finally {
    state.inFlight = false;
    if (epoch !== state.filterEpoch && !$('console').hidden) void refresh();
  }
}

function changeFilters() { state.filterEpoch++; state.selected = ''; state.detailKey = ''; state.follow = true; void refresh(); }
function badge(turn) { return node('span', `badge ${turn.severity}`, statuses[turn.status] || turn.status); }

function render(data) {
  $('account-count').textContent = data.summary.accounts;
  $('account-count').previousElementSibling.textContent = data.source.users !== 'ready' ? '已观察账号' : state.inactive ? '筛选账号' : '有效账号';
  $('account-count').nextElementSibling.textContent = data.source.users !== 'ready' ? '身份库暂不可读，启用状态未知' : state.inactive ? '包含已停用账号；不代表在线' : '已启用；不代表此刻在线';
  $('request-count').textContent = data.summary.requests;
  $('attention-count').textContent = data.summary.attention;
  $('attention-count').classList.toggle('has-error', data.summary.failed > 0);
  $('error-count').textContent = `${data.summary.failed} 轮明确错误 · 其余为等待 / 耗时提示`;
  $('window-label').textContent = state.hours === 72 ? '最近 3 天 · 当前筛选' : `最近 ${state.hours} 小时 · 当前筛选`;
  $('audio-p50').textContent = duration(data.summary.audio_p50_ms);
  $('audio-p95').textContent = data.summary.audio_samples ? `P95 ${duration(data.summary.audio_p95_ms)} · ${data.summary.audio_samples} 份样本` : '尚无合成完成样本';
  renderTrend(data.audio_trend);
  const focusedUser = document.activeElement?.dataset.user;
  renderUsers(data.users);
  if (focusedUser) [...$('user-list').children].find(item => item.dataset.user === focusedUser)?.focus({ preventScroll: true });
  const topicSignature = JSON.stringify(data.topics);
  if ($('topic').dataset.signature !== topicSignature) {
    $('topic').dataset.signature = topicSignature;
    $('topic').replaceChildren(node('option', '', '所有话题'));
    $('topic').firstElementChild.value = '';
    data.topics.forEach((topic, index) => { const option = node('option', '', `${index + 1}. ${topic.title}`); option.value = topic.id; $('topic').append(option); });
  }
  $('topic').value = state.topic;
  if ($('topic').selectedIndex < 0) $('topic').value = '';
  $('activity-title').replaceChildren(document.createTextNode(state.user ? label(state.user) : '全部对话'), node('span', 'count', `${data.turns.length} 轮`));
  $('source-status').textContent = `日志 ${data.source.logs === 'ready' ? '可读取' : '暂不可读取'} · 待归档 ${data.source.pending_delivery} 条\n最近事件 ${time(data.source.last_event_at)}`;
  if (data.source.logs !== 'ready' || data.source.gateway !== 'ready') {
    $('connection-error').textContent = '部分日志来源暂不可读取。面板会继续尝试，已有记录不代表手机此刻在线或离线。';
    $('connection-error').hidden = false;
  }
  $('coverage').textContent = data.source.event_limit_reached || data.turn_limit_reached ? '已达到读取上限，仅显示窗口内最近记录' : '每 2 秒读取 · 不代表手机实际播放状态';
  if (state.follow || !data.turns.some(turn => key(turn) === state.selected)) state.selected = data.turns.length ? key(data.turns[0]) : '';
  $('follow').setAttribute('aria-pressed', String(state.follow));
  const feed = $('feed');
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && feed.contains(selection.anchorNode)) return;
  const scroll = feed.scrollTop;
  const oldAnchor = scroll > 30 ? [...$('turn-list').children].find(item => item.getBoundingClientRect().bottom > feed.getBoundingClientRect().top) : null;
  const anchorKey = oldAnchor?.dataset.key;
  const anchorTop = oldAnchor?.getBoundingClientRect().top;
  const focused = document.activeElement?.closest('.turn')?.dataset.key;
  $('turn-list').replaceChildren(...data.turns.map(renderTurn));
  feed.scrollTop = scroll;
  const newAnchor = anchorKey && [...$('turn-list').children].find(item => item.dataset.key === anchorKey);
  if (newAnchor) feed.scrollTop += newAnchor.getBoundingClientRect().top - anchorTop;
  if (focused) [...$('turn-list').children].find(item => item.dataset.key === focused)?.focus({ preventScroll: true });
  $('empty').hidden = data.turns.length > 0;
  $('export').disabled = data.turns.length === 0;
  renderInspector(data.turns.find(turn => key(turn) === state.selected));
}

function renderUsers(users) {
  $('user-total').textContent = String(users.length).padStart(2, '0');
  $('all-users').classList.toggle('selected', !state.user);
  $('user-list').replaceChildren(...users.map((user, index) => {
    const button = node('button', `user-item${state.user === user.id ? ' selected' : ''}`);
    button.dataset.user = user.id;
    const avatar = node('span', 'user-avatar', user.id === 'owner' ? 'ME' : String(index + 1).padStart(2, '0'));
    const copy = node('span', 'user-copy');
    copy.append(node('strong', '', user.label), node('small', '', user.last_request_at ? `${user.requests} 轮 · 最近 ${time(user.last_request_at)}` : '暂无请求记录'));
    button.append(avatar, copy);
    if (user.attention) button.append(node('span', 'user-alert', user.attention));
    button.addEventListener('click', () => { state.user = user.id; state.topic = ''; changeFilters(); });
    return button;
  }));
}

function renderTurn(turn) {
  const item = node('article', `turn${key(turn) === state.selected ? ' selected' : ''}`);
  item.dataset.key = key(turn); item.tabIndex = 0; item.setAttribute('role', 'button');
  item.setAttribute('aria-label', `${time(turn.started_at)} ${label(turn.user_id)} ${statuses[turn.status]}`);
  item.setAttribute('aria-pressed', String(key(turn) === state.selected));
  const header = node('div', 'turn-header'); const meta = node('div', 'turn-meta');
  meta.append(node('time', 'turn-time', recordTime(turn.started_at)), node('span', 'turn-user', label(turn.user_id)), node('span', 'topic-id', `#${turn.conversation_id.slice(0, 6) || 'unknown'}`));
  header.append(meta, badge(turn)); item.append(header);
  const incoming = node('div', 'message-row'); incoming.append(node('span', 'role', '用户'), node('p', 'user-text', turn.text)); item.append(incoming);
  const outgoing = node('div', 'message-row'); const reply = node('div', 'reply-list');
  outgoing.append(node('span', 'role', '彩名'), reply);
  if (!turn.speeches.length) reply.append(node('p', 'pending-copy', turn.severity === 'error' ? '本轮未记录到有效回复' : '等待回复记录…'));
  turn.speeches.forEach(speech => { const group = node('div', 'reply'); const ja = node('p', 'reply-ja', speech.ja); ja.lang = 'ja'; group.append(ja); if (speech.zh) group.append(node('p', 'reply-zh', speech.zh)); reply.append(group); });
  item.append(outgoing);
  const footer = node('div', 'turn-footer');
  for (const [title, value] of [['首句文字', duration(turn.first_text_ms)], ['首段合成', duration(turn.first_audio_ms)], ['合成', `${turn.audio_completed}/${turn.audio_expected}`]]) {
    const fact = node('span', '', `${title} `); fact.append(node('b', '', value)); footer.append(fact);
  }
  item.append(footer);
  if (turn.errors.length) item.append(node('p', 'turn-error', turn.errors.map(error => error.code).join(' · ')));
  function select() { if (window.getSelection()?.toString()) return; state.selected = key(turn); state.follow = false; render(state.snapshot); }
  item.addEventListener('click', select);
  item.addEventListener('keydown', event => { if (event.target !== item) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } });
  return item;
}

function renderInspector(turn) {
  $('inspector-empty').hidden = Boolean(turn); $('inspector-content').hidden = !turn;
  if (!turn) { state.detailKey = ''; return; }
  $('detail-badge').replaceWith(Object.assign(badge(turn), { id: 'detail-badge' }));
  $('detail-time').textContent = recordTime(turn.started_at);
  const descriptions = {
    failed: '本轮记录了明确失败。先查看错误码和发生阶段，再定位模型格式或语音合成问题。',
    tts_failed: '记录到了语音合成失败。检查语音服务的错误类型；模型可能已经生成了可阅读的回复。',
    unresolved: '未记录到完整的后续事件。可能已经打断、断网或日志延后，不能仅凭此判断服务卡死。',
    model_wait_long: `发起请求已 ${turn.age_seconds} 秒，尚未记录模型完成。建议关注后续事件。`,
    audio_wait_long: `本轮等待已 ${turn.age_seconds} 秒，仍缺少部分语音合成记录，也可能已被手机打断。`,
    slow_audio: '首段语音合成就绪超过 5 秒。下面区分模型生成和语音合成阶段。',
    complete: '模型和本轮预期语音合成记录齐全。手机是否实际播放完成，需要设备端反馈。',
    cancelled: '模型生成被取消；该状态不计为模型错误。', thinking: '模型正在生成，或完成记录尚未到达。',
    preparing_audio: '模型已结束，等待本轮预期的语音合成记录。'
  };
  $('detail-label').textContent = descriptions[turn.status] || '查看这一轮的事件记录。';
  $('phases').replaceChildren(...[['发出请求', 0], ['首句文字', turn.first_text_ms], ['中文翻译', turn.translation_ms], ['首段合成就绪', turn.first_audio_ms]].map(([title, value]) => {
    const item = node('li', `phase${value != null ? ' done' : ''}`);
    item.append(node('span', 'phase-dot'), node('span', 'phase-name', title), node('span', 'phase-time', duration(value))); return item;
  }));
  const synthesis = turn.speeches.map(speech => speech.audio?.synthesis_ms).filter(value => Number.isFinite(value));
  $('facts').replaceChildren();
  const modelStatus = { complete: '已完成', failed: '失败', cancelled: '已取消' }[turn.model_state] || turn.model_state || '未记录完成';
  const facts = [['模型状态', modelStatus], ['模型结束', duration(turn.model_ms)], ['语音完成段数', `${turn.audio_completed} / ${turn.audio_expected}`],
    ['首段合成本身', duration(synthesis[0])], ['本轮事件', turn.event_count], ['已激活设备', state.snapshot.users.find(user => user.id === turn.user_id)?.activated_devices ?? '未知']];
  facts.forEach(([title, value]) => $('facts').append(node('dt', '', title), node('dd', '', value)));
  $('error-detail').hidden = !turn.errors.length;
  $('error-detail').replaceChildren();
  turn.errors.forEach(error => { $('error-detail').append(node('code', '', error.code)); });
  if (turn.errors.length) $('error-detail').append(node('p', '', turn.errors.some(error => error.code === 'invalid_model_repair') ? '模型输出格式修复未通过。检查原始输出、日语校验和句长限制；不能仅据此认定用户修改了人设。' : '请结合对应阶段的事件定位。面板不会自动重试、封号或中断会话。'));
  const detailKey = `${key(turn)}:${turn.event_count}:${turn.last_at}`;
  if (state.detailKey !== detailKey) {
    state.detailKey = detailKey;
    const epoch = ++state.detailEpoch;
    $('event-data').textContent = '读取事件记录…';
    api(`/api/turn/${encodeURIComponent(turn.id)}?${new URLSearchParams({ user_id: turn.user_id, hours: state.hours })}`)
      .then(detail => { if (epoch !== state.detailEpoch || state.selected !== key(turn)) return; $('event-data').textContent = JSON.stringify(detail.events, null, 2); $('event-count').textContent = detail.events.length; })
      .catch(error => { if (epoch === state.detailEpoch) { $('event-data').textContent = error.message; state.detailKey = ''; } });
  }
}

function renderTrend(values) {
  const svg = $('audio-trend'); svg.replaceChildren();
  const ns = 'http://www.w3.org/2000/svg';
  const baseline = document.createElementNS(ns, 'line'); for (const [key, value] of Object.entries({ x1: 0, y1: 41, x2: 152, y2: 41, class: 'chart-baseline' })) baseline.setAttribute(key, value); svg.append(baseline);
  const scale = Math.max(5000, ...values.map(value => value.ms));
  values.forEach((value, index) => { const bar = document.createElementNS(ns, 'rect'); const width = 152 / Math.max(values.length, 12); const height = Math.max(2, value.ms / scale * 38); for (const [key, attribute] of Object.entries({ x: index * width, y: 40 - height, width: Math.max(2, width - 3), height, rx: 1, class: `chart-bar${value.ms > 5000 ? ' slow' : ''}` })) bar.setAttribute(key, attribute); const title = document.createElementNS(ns, 'title'); title.textContent = `${time(value.at)} · ${duration(value.ms)}`; bar.append(title); svg.append(bar); });
}

$('login-form').addEventListener('submit', async event => { event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true; $('login-error').textContent = ''; try { await signIn($('admin-token').value.trim()); } catch (error) { $('login-error').textContent = error.message; } finally { button.disabled = false; } });
$('pause').addEventListener('click', () => { state.paused = !state.paused; $('pause').textContent = state.paused ? '恢复刷新' : '暂停刷新'; $('live-label').textContent = state.paused ? '面板刷新已暂停' : '只读监听 · 2 秒刷新'; $('live-dot').className = state.paused ? 'paused' : ''; if (!state.paused) void refresh(); });
$('all-users').addEventListener('click', () => { state.user = ''; state.topic = ''; changeFilters(); });
$('follow').addEventListener('click', () => { state.follow = true; $('feed').scrollTop = 0; if (state.snapshot) render(state.snapshot); if (!state.paused) void refresh(); });
$('hours').addEventListener('change', event => { state.hours = Number(event.target.value); state.topic = ''; changeFilters(); });
$('topic').addEventListener('change', event => { state.topic = event.target.value; changeFilters(); });
$('issues-only').addEventListener('change', event => { state.issues = event.target.checked; changeFilters(); });
$('include-inactive').addEventListener('change', event => { state.inactive = event.target.checked; state.user = ''; state.topic = ''; changeFilters(); });
$('logout').addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST' }); showLogin(); } catch (error) { $('connection-error').textContent = error.message; $('connection-error').hidden = false; } });
$('export').addEventListener('click', () => {
  const data = state.snapshot; if (!data) return;
  const lines = [`Ayana 监控视图 · ${new Date(data.now * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} 北京时间`, `账号筛选：${state.user ? label(state.user) : '全部账号'}`, ...data.limitations, ''];
  [...data.turns].reverse().forEach(turn => { lines.push(`--- ${recordTime(turn.started_at)} · ${label(turn.user_id)} · ${statuses[turn.status]} ---`, `用户：${turn.text}`); turn.speeches.forEach(speech => lines.push(`日语：${speech.ja}`, `中文：${speech.zh}`)); turn.errors.forEach(error => lines.push(`错误：${error.code}`)); lines.push(`首段合成：${duration(turn.first_audio_ms)}`, ''); });
  const url = URL.createObjectURL(new Blob(['\ufeff' + lines.join('\n')], { type: 'text/plain;charset=utf-8' })); const link = node('a'); link.href = url; link.download = `Ayana-监控视图-${new Date().toISOString().slice(0, 10)}.txt`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !state.paused && !$('console').hidden) void refresh(); });

(async () => {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get('token');
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  try {
    if (token) await signIn(token);
    else if ((await api('/api/session')).authenticated) await begin();
    else showLogin();
  } catch (error) { showLogin(); $('login-error').textContent = error.message; }
})();
