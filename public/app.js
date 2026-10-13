const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const e = escapeHtml;
const statusNames = { draft: '待启动', active: '进行中', paused: '已暂停', blocked: '待处理', validating: '验收中', completed: '已交付', failed: '失败', cancelled: '已取消', idle: '空闲', running: '工作中', waiting_approval: '等待审批', waiting_user: '等待回复', recovering: '恢复中', offline: '离线', error: '异常', ready: '待开始', assigned: '已分配', review: '待验收', accepted: '已验收', pending: '待处理', approved: '已批准', denied: '已拒绝', consumed: '授权已使用', persisted: '已保存', admitted: '已接收', placed: '已投递', answered: '已回答', unanswered: '未回答', delivered: '已接收', queued: '排队中', dispatching: '投递中', uncertain: '结果不确定', aborted: '已撤回', succeeded: '执行成功', available: '可用', cancelled_delivery: '已撤回' };
const roleNames = { orchestrator: '负责人', worker: '执行者', validator: '验收者' };
Object.assign(statusNames, { unassigned: '尚未分配', passed: '已通过', untested: '尚未验证', enrolled: '等待节点连接', online: '节点已连接', revoked: '授权已吊销', dispatched: '已派发' });
const badge = (status) => `<span class="badge ${e(status)}">${e(statusNames[status] || status)}</span>`;
const date = (value) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
const navItems = [['missions', '◈', 'Missions'], ['profiles', '◇', '模型连接'], ['roles', '♧', '角色与职责'], ['mcp', '⌘', '外部工具'], ['workspaces', '▱', '工作区'], ['machines', '▦', '执行机器']];
const mcpCatalogs = new Map();
const nodeProbes = new Map();
const state = { app: null, detail: null, section: 'missions', missionId: null, tab: 'overview', filter: 'all', query: '', busy: false, transcriptId: null };
let submitHandler = null;
let toastTimer;
let loading = false;
let pendingLoad = false;
let routeVersion = 0;
let lastSnapshot = '';

async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MissionControl' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let result;
  try { result = text ? JSON.parse(text) : {}; } catch { throw new Error(`后台返回了非 JSON 内容（${response.status}）。`); }
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : result.error?.message || result.message || `请求失败（${response.status}）`);
  return result;
}

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4200);
}

function field(name, label, value = '', options = {}) {
  const common = `id="f-${e(name)}" name="${e(name)}" ${options.required ? 'required' : ''}`;
  let input;
  if (options.choices) input = `<select ${common}>${options.choices.map(([id, text]) => `<option value="${e(id)}" ${String(value) === String(id) ? 'selected' : ''}>${e(text)}</option>`).join('')}</select>`;
  else if (options.multiline) input = `<textarea ${common} rows="${options.rows || 3}" placeholder="${e(options.placeholder || '')}">${e(value)}</textarea>`;
  else input = `<input ${common} type="${options.type || 'text'}" value="${e(value)}" ${options.type === 'number' ? `min="${options.min ?? 0}" step="${options.step ?? 1}"` : options.step !== undefined ? `step="${e(options.step)}"` : ''} placeholder="${e(options.placeholder || '')}" ${options.pattern ? `pattern="${e(options.pattern)}"` : ''}>`;
  return `<div class="field ${options.wide ? 'wide' : ''}"><label for="f-${e(name)}">${e(label)}</label>${input}${options.help ? `<small>${e(options.help)}</small>` : ''}</div>`;
}

function check(name, label, checked = false) { return `<label class="check"><input type="checkbox" name="${e(name)}" ${checked ? 'checked' : ''}>${e(label)}</label>`; }

function dialog(title, fields, handler, submitLabel = '保存') {
  delete $('#dialog').dataset.nodeCommand;
  $('#dialog-title').textContent = title;
  $('#form-fields').innerHTML = fields;
  $('#form-error').textContent = '';
  $('#submit-dialog').textContent = submitLabel;
  $('#submit-dialog').hidden = !handler;
  $('#cancel-dialog').textContent = handler ? '取消' : '关闭';
  $('#submit-dialog').disabled = false;
  $('#close-dialog').disabled = $('#cancel-dialog').disabled = false;
  submitHandler = handler;
  if (!$('#dialog').open) $('#dialog').showModal();
}

$('#form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!submitHandler) return;
  const button = $('#submit-dialog');
  const handler = submitHandler;
  const activeDialog = $('#dialog');
  button.disabled = true;
  $('#close-dialog').disabled = $('#cancel-dialog').disabled = true;
  activeDialog.dataset.submitting = 'true';
  $('#form-error').textContent = '';
  try {
    const afterSubmit = await handler(new FormData($('#form')));
    $('#dialog').close();
    if (typeof afterSubmit === 'function') afterSubmit();
    await load(true);
  } catch (error) { $('#form-error').textContent = error.message; }
  finally { button.disabled = false; $('#close-dialog').disabled = $('#cancel-dialog').disabled = false; delete activeDialog.dataset.submitting; }
});
$('#dialog').addEventListener('cancel', (event) => { if ($('#dialog').dataset.submitting) event.preventDefault(); });
$('#dialog').addEventListener('close', () => {
  if ($('#dialog').open) return;
  $('#form-fields').replaceChildren();
  submitHandler = null;
  delete $('#dialog').dataset.nodeCommand;
});
$('#close-dialog').onclick = $('#cancel-dialog').onclick = () => $('#dialog').close();
$('#refresh').onclick = () => load(true);

function heading(eyebrow, title, subtitle, actions = '') {
  return `<div class="page-heading"><div><div class="eyebrow">${e(eyebrow)}</div><h1>${e(title)}</h1><p class="subtitle">${e(subtitle)}</p></div><div class="actions">${actions}</div></div>`;
}
function button(label, action, id = '', type = '') { return `<button class="button ${type}" data-action="${e(action)}" data-id="${e(id)}">${e(label)}</button>`; }
function empty(title, description, actions = '', compact = false) { return `<div class="empty ${compact ? 'compact' : ''}"><div class="empty-symbol">↗</div><h2>${e(title)}</h2><p>${e(description)}</p>${actions}</div>`; }
function stat(label, value, note) { return `<div class="stat"><div class="stat-label">${e(label)}<span>↗</span></div><div class="stat-value">${e(value)}</div><div class="stat-note">${e(note)}</div></div>`; }
function profileName(id) { const p = state.app.profiles.find((item) => item.id === id); return p ? p.name : id || '未配置'; }
function agentName(id) { if (id === 'user') return '你'; if (id === 'system:scheduler') return '定时唤醒'; if (id === 'system:watchdog') return '推进监测'; return state.detail?.agents.find((agent) => agent.id === id)?.title || id || '系统'; }
function workspaceName(id) { return state.app.workspaces.find((workspace) => workspace.id === id)?.name || id; }
function renderNav() {
  $('#nav').innerHTML = navItems.map(([key, icon, label]) => `<a href="#${key}" class="nav-item ${state.section === key ? 'active' : ''}" ${state.section === key ? 'aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${icon}</span>${label}${key === 'missions' ? `<span class="nav-count">${state.app.missions.length}</span>` : ''}</a>`).join('');
  $('#breadcrumb').textContent = `工作台 / ${navItems.find(([key]) => key === state.section)?.[2] || 'Mission'}${state.missionId ? ' / 详情' : ''}`;
  $('#version').textContent = `v${state.app.version || '0.1.0'} · pi-durable`;
}

function renderMissions() {
  const missions = state.app.missions;
  const filtered = missions.filter((m) => (state.filter === 'all' || m.status === state.filter) && `${m.title} ${m.goal} ${workspaceName(m.workspaceId)}`.toLowerCase().includes(state.query.toLowerCase()));
  const active = missions.filter((m) => ['active', 'validating'].includes(m.status)).length;
  const waiting = missions.filter((m) => ['paused', 'blocked', 'failed'].includes(m.status)).length;
  return heading('YOUR MISSION, IN MOTION', '把目标交给一个团队', '明确目标，组建代理团队。持续推进，有据可验。', button('＋ 新建 Mission', 'new-mission')) +
    `<div class="stats">${stat('进行中的 Mission', active.toString().padStart(2, '0'), '后台持续运行')}${stat('已验收交付', missions.filter((m) => m.status === 'completed').length.toString().padStart(2, '0'), '不仅仅是一句“已完成”')}${stat('需要你关注', waiting.toString().padStart(2, '0'), '暂停、阻塞或失败')}${stat('模型连接', state.app.profiles.length.toString().padStart(2, '0'), '每个角色，独立选择')}</div>` +
    `<div class="section-head"><h2>你的 Missions <span class="small-muted">${missions.length}</span></h2><div class="filters">${[['all', '全部'], ['active', '进行中'], ['completed', '已交付']].map(([key, text]) => `<button class="filter ${state.filter === key ? 'active' : ''}" data-filter="${key}">${text}</button>`).join('')}<input class="search" id="mission-search" type="search" aria-label="搜索 Mission" placeholder="搜索任务或工作区…" value="${e(state.query)}"></div></div>` +
    (filtered.length ? `<div class="mission-grid">${filtered.map((mission) => `<a class="mission-card" href="#missions/${e(mission.id)}"><div class="card-top"><span class="mission-number">MISSION / ${e(mission.id.slice(0, 8).toUpperCase())}</span>${badge(mission.status)}</div><h3>${e(mission.title)}</h3><p class="card-description">${e(mission.goal)}</p><div class="card-bottom"><span>▱ ${e(workspaceName(mission.workspaceId))}</span><span>${date(mission.updatedAt)} ↗</span></div></a>`).join('')}</div>` : empty(missions.length ? '没有匹配的 Mission' : '第一个目标，从这里开始', missions.length ? '试试其他关键词或状态。' : '连接你自己的模型，选择工作区，告诉团队交付什么。任务、对话与执行进度都会持久保存。', missions.length ? '' : button('创建第一个 Mission', 'new-mission'))) +
    `<div class="onboarding"><a href="#profiles"><b><i class="step-number">01</i>连接你的模型</b><span>OpenAI / Anthropic 兼容接口与本地模型。密钥仅通过环境变量读取。</span></a><a href="#roles"><b><i class="step-number">02</i>配置团队职责</b><span>负责人、执行者、验收者分别选模型，验收不能由执行者自证。</span></a><a href="#workspaces"><b><i class="step-number">03</i>选择工作区</b><span>明确工具作用目录与权限。持久消息驱动团队持续接力。</span></a></div>`;
}

function renderProfiles() {
  return heading('MODEL CONNECTIONS', '模型，由你决定', '不绑定供应商。每个角色可独立选择模型、接口与密钥引用。', button('＋ 添加模型', 'new-profile')) +
    `<div class="notice neutral">这里不保存密钥明文。填写后台进程可以读取的环境变量名称；新增环境变量后需重启后台。配置完整不等于接口已实测兼容。</div>` +
    (state.app.profiles.length ? `<div class="cards">${state.app.profiles.map((p) => `<article class="panel"><div class="card-top"><span class="mission-number">${e(p.api)}</span><span class="badge">${p.available === false ? '缺少凭证' : p.credentialEnv ? '环境变量凭证' : '免密本地接口'}</span></div><h3>${e(p.name)}</h3><p class="text">${e(p.modelId)}</p><p class="agent-meta">${e(p.baseUrl)}<br>凭证：${e(p.credentialEnv || '不需要')}<br>上下文 ${Number(p.contextWindow).toLocaleString()} · 输出上限 ${Number(p.maxTokens).toLocaleString()}<br>${p.toolCalling ? '支持工具' : '不支持工具'} · ${p.vision ? '支持图片' : '纯文本'} · 修订 ${p.revision}</p>${button('编辑连接', 'edit-profile', p.id, 'secondary small')}</article>`).join('')}</div>` : empty('添加第一个模型连接', '你可以使用已有订阅的兼容 API，也可以连接本地推理服务。', button('添加连接', 'new-profile')));
}

function renderRoles() {
  return heading('YOUR PERSISTENT TEAM', '各司其职，各选其模', '职责与模型分开管理。代理有独立对话，不共享整段上下文。', button('＋ 添加角色', 'new-role')) +
    (state.app.roles.length ? `<div class="cards">${state.app.roles.map((r) => `<article class="panel"><div class="card-top"><span class="avatar">${e(r.name.slice(0, 1))}</span><span class="badge">${e(roleNames[r.kind])}</span></div><h3>${e(r.name)}</h3><p class="agent-meta">${e(profileName(r.profileId))}</p><p class="text">${e(r.instructions)}</p>${button('编辑角色', 'edit-role', r.id, 'secondary small')}</article>`).join('')}</div>` : empty('定义你的团队', '至少配置一位负责人、一位执行者和一位独立验收者。', button('添加角色', 'new-role')));
}

function renderWorkspaces() {
  return heading('WORKSPACE BOUNDARIES', '工作有明确的目录', '文件工具限定目录，命令在该目录启动。共享目录不等于隔离工作树或系统沙箱。', button('＋ 添加工作区', 'new-workspace')) +
    `<div class="notice">本地工具不是操作系统级沙箱。仅将可信项目交给代理；“自主执行”允许它在本机执行命令，不要用于不受信任的提示词或仓库。</div>` +
    '<p class="small-muted">远端目录请到“执行机器”完成只读检查，再从成功回执登记。登记只保存目录与机器的对应关系，代理执行尚未启用；Mission 的主交付目录和初始独立验收仍在本机。</p>' +
    (state.app.workspaces.length ? `<div class="table-wrap"><table><thead><tr><th>工作区</th><th>完整路径</th><th>执行机器</th><th>目录依据</th></tr></thead><tbody>${state.app.workspaces.map((w) => `<tr><td>${e(w.name)}</td><td class="mono">${e(w.path)}</td><td>${e(state.app.machines.find((m) => m.id === w.machineId)?.name || w.machineId)}</td><td>${w.machineId === 'local' ? '本机目录' : `远端代理执行未启用<br><span class="small-muted">检查时间：${date(w.probe?.verifiedAt)}<br>会话代次：${e(w.probe?.sessionEpoch ?? '未记录')}<br>回执：${e(w.probe?.commandId ?? '未记录')}</span>`}</td></tr>`).join('')}</tbody></table></div>` : empty('还没有工作区', '选择一个实际存在的本地目录。代理的文件、命令与交付物都属于这个工作区。', button('添加工作区', 'new-workspace')));
}

function mcpCatalog(server) {
  const catalog = mcpCatalogs.get(server.id);
  return catalog?.revision === server.revision ? catalog : null;
}

function renderMcp() {
  const servers = state.app.mcpServers || [];
  return heading('EXTERNAL TOOLS / MCP', '把工具交给合适的角色', '连接外部服务，再逐项授权。未授权的角色不能发现或调用工具。', button('＋ 添加工具连接', 'new-mcp')) +
    '<div class="notice">只连接你信任的程序和服务。本地 MCP 程序以你的账户运行，不是系统沙箱；工具可能修改文件或外部系统。“只读”标签不会自动获得权限。密钥只填环境变量名称，不填明文。</div>' +
    (servers.length ? servers.map((server) => {
      const catalog = mcpCatalog(server);
      const grants = state.app.roles.flatMap((role) => (role.mcpPermissions || []).filter((grant) => grant.serverId === server.id).map((grant) => ({ role, grant })));
      const references = server.transport === 'stdio' ? Object.values(server.envRefs) : Object.values(server.headerRefs).map((ref) => ref.env);
      return `<article class="panel"><div class="card-top"><span class="mission-number">${e(server.transport === 'stdio' ? '本地程序 · STDIO' : '远端服务 · STREAMABLE HTTP')}</span><span class="badge">${server.enabled ? '已启用' : '已停用'}</span></div><h2>${e(server.name)}</h2><p class="agent-meta mono">${e(server.transport === 'stdio' ? server.command : server.url)}</p><p class="small-muted">配置修订 ${server.revision} · 超时 ${server.timeoutMs / 1000} 秒 · 密钥引用：${e(references.join('、') || '无')}<br>${catalog ? `目录上次读取于 ${date(catalog.fetchedAt)}，不代表当前在线；调用前会重新核对工具定义。` : '尚未读取当前配置的工具目录；保存配置不会自动连接。'}</p><div class="actions">${button('编辑配置', 'edit-mcp', server.id, 'secondary small')}${server.enabled ? button('读取工具目录', 'discover-mcp', server.id, 'secondary small') + button('停用连接', 'disable-mcp', server.id, 'secondary small') : ''}${server.enabled && catalog?.tools.length ? button('授权给角色', 'grant-mcp', server.id, 'small') : ''}</div><h3>角色授权</h3>${grants.length ? `<div class="table-wrap"><table><thead><tr><th>角色</th><th>工具</th><th>执行方式</th><th>操作</th></tr></thead><tbody>${grants.map(({ role, grant }) => `<tr><td>${e(role.name)}</td><td class="mono">${e(grant.toolName)}</td><td>${grant.mode === 'approve' ? '每次审批' : '允许执行（仍受 Mission 审批模式约束）'}</td><td>${button('撤销授权', 'revoke-mcp', JSON.stringify([role.id, server.id, grant.toolName]), 'secondary small')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small-muted">默认拒绝：尚未向任何角色开放此连接。</p>'}${catalog ? `<details data-identity="mcp-${e(server.id)}"><summary>工具目录 · ${catalog.tools.length} 项</summary>${catalog.tools.map((tool) => `<h4 class="mono">${e(tool.name)}</h4><p class="text">${e(tool.description || '未提供说明')}</p><pre>${e(JSON.stringify(tool.inputSchema, null, 2))}</pre>`).join('') || '<p class="small-muted">服务器没有提供工具。</p>'}</details>` : ''}</article>`;
    }).join('') : empty('还没有外部工具', '支持本地 stdio 程序与 Streamable HTTP 服务。新连接默认停用，新角色默认无权限。', button('添加工具连接', 'new-mcp')));
}

function renderMachines() {
  return heading('EXECUTION PLANE', '执行机器', '节点主动连回后台。通信租约只代表连接有效，不代表任务已执行或旧进程已停止。', button('＋ 登记远端机器', 'new-machine')) +
    '<div class="notice">远端目前开放连接、心跳与只读目录检查，尚未启用代理执行、模型调用或远端工作树。完整远端 Mission 仍在实现；不会把“已连接”当成执行验收通过。</div>' +
    `<div class="cards">${state.app.machines.map((machine) => {
      if (machine.kind === 'local') return `<article class="panel"><div class="card-top"><span class="avatar">▦</span>${badge(machine.status)}</div><h3>${e(machine.name)}</h3><p class="agent-meta">当前后台所在机器 · LOCAL</p><p class="small-muted">代理独立进程 · 独立 pi-durable 存储</p></article>`;
      const capabilities = machine.capabilities;
      const latest = nodeProbes.get(machine.id);
      return `<article class="panel"><div class="card-top"><span class="mission-number">REMOTE / ${e(machine.id)}</span>${badge(machine.status)}</div><h3>${e(machine.name)}</h3><p class="agent-meta">${capabilities ? `${e(capabilities.platform)} / ${e(capabilities.arch)} · 节点 ${e(capabilities.version)}<br>Node ${e(capabilities.node)} · pi-durable ${e(capabilities.piDurable || '尚未报告')}` : '节点尚未报告运行环境'}<br>会话代次：${e(machine.sessionEpoch)}<br>最近心跳：${date(machine.lastSeenAt)}<br>通信租约到期：${date(machine.leaseExpiresAt)}</p><p class="small-muted">连接层可用 ≠ 代理执行已启用。旧会话无权领取新命令。</p>${capabilities ? `<details data-identity="node-${e(machine.id)}"><summary>节点声明的目录与凭证名称</summary><p class="small-muted">目录仍需在节点上实际检查。凭证只显示名称，不证明模型接口能用。</p><ul>${capabilities.roots.map((root) => `<li class="mono">${e(root)}</li>`).join('')}</ul><p class="small-muted">凭证引用：${e(capabilities.credentialRefs.join('、') || '未声明')}</p></details>` : ''}<div class="actions">${machine.status === 'online' ? button('检查目录', 'probe-machine', machine.id, 'secondary small') : ''}${button('检查历史', 'node-history', machine.id, 'secondary small')}${latest ? button('最近目录检查', 'view-node-probe', machine.id, 'secondary small') : ''}${machine.status !== 'revoked' ? button('连接说明', 'node-instructions', machine.id, 'secondary small') + button('吊销授权', 'revoke-machine', machine.id, 'secondary small') : ''}</div></article>`;
    }).join('')}</div>`;
}

function nodeInstructions(machine) {
  return '<div class="notice neutral">在另一台机器安装同版本 Mission Control，配置节点令牌的环境变量后启动。不要把令牌放进命令参数、聊天、截图或源码；后台无法再次显示它，遗失请吊销后重新登记。</div>' +
    '<p class="text">只能转发专用节点端口，不能转发管理端口：管理界面的本机登录入口不应对节点开放。连接地址必须使用验证证书的 HTTPS，或 SSH 加密隧道中的回环地址。</p>' +
    (state.app.nodePort ? `<p class="small-muted">后台专用节点入口：127.0.0.1:${e(state.app.nodePort)}。请将隧道或 HTTPS 反向代理指向这个端口。</p>` : '<p class="small-muted">尚未开启专用节点端口。请显式停止并用 serve/start --node-port &lt;端口&gt; 重新启动后台；不要替代为管理端口。</p>') +
    `<pre>mission-control node --coordinator &lt;连接地址&gt; --machine-id ${e(machine.id)} --token-env MC_NODE_TOKEN --home &lt;独立节点目录&gt; --root &lt;允许的绝对目录&gt;</pre>` +
    '<p class="small-muted">可以重复 --root 声明多个目录。--credential-ref 仅声明目标机器上的凭证环境变量名称，不传递密钥值。目录检查是只读的，不创建工作区，不启动代理，不消耗模型额度。</p>';
}

function showEnrollment({ machine, token }) {
  dialog('登记成功：安全交接节点令牌', nodeInstructions(machine) +
    '<div class="field"><label for="node-enrollment-token">一次性令牌（默认隐藏）</label><input id="node-enrollment-token" type="password" readonly autocomplete="off" spellcheck="false"><small>关闭后不会再显示。它只允许这个节点连接，不能访问管理员接口。</small></div>' +
    '<div class="actions"><button type="button" class="button secondary" id="copy-node-token">复制令牌</button><button type="button" class="button secondary" id="toggle-node-token">显示令牌</button></div><p id="node-token-feedback" class="small-muted" role="status"></p>', null);
  const input = $('#node-enrollment-token');
  input.value = token;
  $('#copy-node-token').onclick = async () => {
    const feedback = $('#node-token-feedback');
    try {
      await navigator.clipboard.writeText(input.value);
      feedback.textContent = '已复制。请通过安全渠道放入目标机器的 MC_NODE_TOKEN 环境变量，使用后清理剪贴板。';
    } catch { feedback.textContent = '浏览器不允许自动复制。可显示后手动选中复制，请避免录屏。'; }
  };
  $('#toggle-node-token').onclick = () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    $('#toggle-node-token').textContent = input.type === 'password' ? '显示令牌' : '隐藏令牌';
  };
}

function machineDialog() {
  dialog('登记远端机器', '<div class="notice neutral">这里只登记节点身份，不启动远端命令。登记后会生成只能查看一次的令牌；请安全保存，不要分享给代理。</div>' +
    field('id', '稳定机器标识', '', { required: true, pattern: '[A-Za-z0-9][A-Za-z0-9._-]{0,63}', placeholder: 'linux-builder', help: '1–64 个英文字母、数字、点、横线或下划线；不能使用 local。' }) +
    field('name', '显示名称', '', { required: true, placeholder: '我的 Linux 开发机' }),
  async (data) => {
    const registration = await api('/api/machines', 'POST', Object.fromEntries(data));
    return () => showEnrollment(registration);
  }, '登记并生成令牌');
}

function showNodeProbe(machine, command) {
  nodeProbes.set(machine.id, command);
  const status = { completed: '目录检查通过', failed: '目录检查未通过', uncertain: '结果不确定，不会自动重做', cancelled: '命令已取消', queued: '等待节点领取', dispatched: '节点已领取，等待回执' }[command.status] || command.status;
  const reason = {
    'probe path must be an absolute path': '请输入目标机器上的绝对目录路径。',
    'probe path does not exist': '目标机器上不存在这个目录，或节点无法访问它。',
    'probe path is not a directory': '目标路径不是目录。',
    'probe path is unavailable': '节点无法读取目标目录的状态。',
    'probe path is outside a declared root': '这个路径位于节点允许的目录之外，或通过符号链接指向了外部目录。'
  }[command.error] || '检查未完成，详细原因请查看原始回执；不会自动重做。';
  const output = command.error
    ? `<p class="text">${e(reason)}</p><details><summary>原始回执</summary><pre class="output">${e(command.error)}</pre></details>`
    : `<pre class="output">${e(JSON.stringify(command.result ?? command.payload, null, 2))}</pre>`;
  const canBind = command.status === 'completed' && machine.status === 'online' && command.sessionEpoch === machine.sessionEpoch &&
    !state.app.workspaces.some((workspace) => workspace.machineId === machine.id && workspace.probe?.commandId === command.id);
  dialog(`${machine.name} · 只读目录检查`, `<p class="text">${e(status)}</p><p class="small-muted">命令：${e(command.id)}<br>更新时间：${date(command.updatedAt)}</p>${output}` +
    '<p class="small-muted">只证明这个节点报告的目录检查结果；不等于代理运行、模型调用或多机任务通过。迟到结果不能覆盖“不确定”记录。</p><div class="actions"><button type="button" class="button secondary" id="refresh-node-probe">刷新回执</button>' +
    (canBind ? '<button type="button" class="button" id="bind-node-workspace">登记为远端工作区</button>' : '') + '</div>', null);
  if (canBind) $('#bind-node-workspace').onclick = () => dialog('登记远端工作区',
    '<div class="notice neutral">只保存这个节点的目录映射，不启动代理、不写文件、不消耗模型额度。后台不把远端路径当成本机路径使用；目录以后仍可能变化，执行前必须重新检查。</div>' +
    `<p class="text">执行机器：${e(machine.name)}<br>节点确认的路径：${e(command.result.path)}</p>` +
    field('name', '工作区名称', machine.name, { required: true }), async (data) => {
      await api('/api/workspaces', 'POST', { name: data.get('name'), machineId: machine.id, probeCommandId: command.id });
      location.hash = '#workspaces';
      toast('已登记远端目录，代理执行尚未启用。');
    }, '确认登记');
  $('#dialog').dataset.nodeCommand = command.id;
  $('#refresh-node-probe').onclick = async () => {
    const refresh = $('#refresh-node-probe');
    refresh.disabled = true;
    try {
      const current = await api(`/api/machines/${encodeURIComponent(machine.id)}/commands/${encodeURIComponent(command.id)}`);
      nodeProbes.set(machine.id, current);
      if ($('#dialog').open && $('#dialog').dataset.nodeCommand === command.id) showNodeProbe(machine, current);
    } catch (error) {
      if ($('#dialog').dataset.nodeCommand === command.id) $('#form-error').textContent = error.message;
    } finally { refresh.disabled = false; }
  };
}

async function showNodeHistory(machine, before) {
  const suffix = before ? `?before=${encodeURIComponent(before)}` : '';
  const page = await api(`/api/machines/${encodeURIComponent(machine.id)}/commands${suffix}`);
  dialog(`${machine.name} · 目录检查历史`, '<p class="small-muted">记录保存在后台，刷新页面或重启后仍可查看。不确定的检查不会自动重做。</p>' +
    (page.commands.length ? page.commands.map((command) =>
      `<article class="panel"><p class="mono">${e(command.payload.path)}</p><p>${e(({ completed: '通过', failed: '失败', uncertain: '不确定', cancelled: '已取消', queued: '排队中', dispatched: '等待回执' })[command.status] || command.status)} · ${date(command.createdAt)}</p><p class="small-muted mono">${e(command.id)}</p><button type="button" class="button secondary small" data-node-history-command="${e(command.id)}">查看回执</button></article>`
    ).join('') : '<p class="small-muted">还没有检查记录。</p>') +
    `<div class="actions">${before ? '<button type="button" class="button secondary" id="node-history-first">返回最新记录</button>' : ''}${page.nextCursor ? '<button type="button" class="button secondary" id="node-history-next">较早记录</button>' : ''}</div>`, null);
  for (const button of document.querySelectorAll('[data-node-history-command]')) button.onclick = async () => {
    try {
      const command = await api(`/api/machines/${encodeURIComponent(machine.id)}/commands/${encodeURIComponent(button.dataset.nodeHistoryCommand)}`);
      showNodeProbe(machine, command);
    } catch (error) { $('#form-error').textContent = error.message; }
  };
  const load = async (cursor) => {
    try { await showNodeHistory(machine, cursor); }
    catch (error) { $('#form-error').textContent = error.message; }
  };
  if ($('#node-history-first')) $('#node-history-first').onclick = () => load();
  if ($('#node-history-next')) $('#node-history-next').onclick = () => load(page.nextCursor);
}

async function machineAction(name, id) {
  const machine = state.app.machines.find((item) => item.id === id && item.kind === 'remote');
  if (!machine) throw new Error('机器不存在，请刷新后重试。');
  if (name === 'node-history') return showNodeHistory(machine);
  if (name === 'node-instructions') return dialog(`${machine.name} · 连接说明`, nodeInstructions(machine), null);
  if (name === 'revoke-machine') return dialog('吊销节点授权？', `<p class="text">吊销 ${e(machine.name)} 的令牌并封住旧会话。排队命令会取消；已派发且没有可靠结果的操作保留为“不确定”。吊销不能撤回已经发生的外部操作。</p>`, async () => {
    await api(`/api/machines/${encodeURIComponent(id)}/revoke`, 'POST', {});
    toast('节点授权已吊销，历史证据保留。');
  }, '确认吊销');
  if (name === 'view-node-probe') {
    const previous = nodeProbes.get(id);
    if (!previous) throw new Error('当前页面还没有目录检查记录。');
    return showNodeProbe(machine, await api(`/api/machines/${encodeURIComponent(id)}/commands/${encodeURIComponent(previous.id)}`));
  }
  const requestId = crypto.randomUUID();
  return dialog('检查目标机器上的目录', '<div class="notice neutral">目录会由目标节点检查，不能用这台后台机器上的同名目录代替。不会注册工作区，也不会开始执行任务。</div>' +
    field('path', '目标机器的绝对目录', '', { required: true, placeholder: '/srv/projects/my-app', help: '必须存在且位于节点声明的根目录中。通过符号链接逃出根目录会被拒绝。' }), async (data) => {
    const command = await api(`/api/machines/${encodeURIComponent(id)}/probe`, 'POST', { path: data.get('path'), requestId });
    return () => showNodeProbe(machine, command);
  }, '提交只读检查');
}

function timeline(events, limit = 40) {
  return events.length ? `<div class="timeline">${events.slice(-limit).reverse().map((event) => `<div class="event"><span class="event-dot"></span><div><p>${e(event.text)}</p><small>#${event.seq} · ${e(event.type)} · ${date(event.createdAt)}</small></div></div>`).join('')}</div>` : '<p class="small-muted">尚无活动。启动后会在这里记录真实事件。</p>';
}

function renderAgents(agents) {
  return agents.length ? `<div class="cards">${agents.map((agent) => `<article class="agent-card"><div class="agent-header"><span class="avatar">${e(agent.title.slice(0, 1))}</span><div><h3>${e(agent.title)}</h3><span class="small-muted">${e(roleNames[agent.kind])}</span></div>${badge(agent.status)}</div><p class="agent-meta">${e(profileName(agent.profileId))}<br>${e(agent.workspacePath)}<br>执行代次 ${agent.epoch} · ${date(agent.updatedAt)}</p>${agent.error ? `<p class="text danger-text">${e(agent.error)}</p>` : ''}<div class="actions">${button('对话', 'transcript', agent.id, 'secondary small')}${button('发消息', 'message-agent', agent.id, 'secondary small')}${button('中断', 'interrupt-agent', agent.id, 'secondary small')}${button('换模型', 'agent-profile', agent.id, 'secondary small')}</div></article>`).join('')}</div>` : empty('团队尚未启动', '启动 Mission 后将创建持久负责人，由负责人派工，或由你手动添加代理。', '', true);
}

function worktreeCommit(receipt) {
  if (!receipt?.workspaceCommit) return '';
  const integrity = receipt.snapshotIntegrity === true ? '已检查，输入未被改写' : receipt.snapshotIntegrity === false ? '失败，不可用于通过验收' : '未记录，不推断通过';
  return `<div class="notice ${receipt.snapshotIntegrity === false ? '' : 'neutral'}"><strong>验收运行在独立副本</strong><p class="small-muted mono digest">提交：${e(receipt.workspaceCommit)}<br>来源分支：${e(receipt.workspaceBranch || '未记录')}<br>命令执行目录：${e(receipt.workspacePath || '未记录')}<br>副本输入完整性：${e(integrity)}</p>${receipt.snapshotError ? `<p class="text danger-text">${e(receipt.snapshotError)}</p>` : ''}</div>`;
}

function renderWorktreeSummary() {
  const mission = state.detail.mission;
  if (mission.workspaceStrategy !== 'worktree') return '';
  const records = state.detail.worktrees || [];
  const errors = records.filter((record) => record.status === 'error');
  return `<section class="panel"><div class="card-top"><h3>各自开发，合并后再验收</h3><span class="badge ${errors.length ? 'error' : ''}">${errors.length ? `${errors.length} 个目录需处理` : '独立 Git 工作树'}</span></div><p class="text">代理使用不同工作目录，原仓库文件不随代理修改。各分支通过后，还必须合并到一个工作目录，再由独立验收者验证完整产品。</p><p class="small-muted">${mission.repository ? `起点提交：<span class="mono digest">${e(mission.repository.baseCommit)}</span>` : '启动时会检查并固定仓库起点；准备目录不代表已经执行任务。'} · 详细状态见“工作目录”。</p></section>`;
}

function renderWorktrees() {
  const { mission, tasks, agents } = state.detail;
  if (mission.workspaceStrategy !== 'worktree') return `<section class="panel"><h2>共享工作目录</h2><p class="text">此 Mission 保留共享目录模式，没有自动搬迁历史文件或代理。多个代理可能修改同一份文件，需要协调分工。</p><p class="small-muted">如需隔离，请创建新的 Mission 并选择“独立 Git 工作树”。工作目录模式不能在运行途中切换。</p></section>`;
  const records = state.detail.worktrees || [];
  const agentTrees = records.filter((record) => record.kind === 'agent');
  const validationTrees = records.filter((record) => record.kind === 'validation');
  const treeNames = { pending: '等待准备', ready: '目录已就绪', error: '准备或校验失败' };
  const treeBadge = (record) => `<span class="badge ${record.status === 'error' ? 'error' : record.status === 'ready' ? 'idle' : 'pending'}">${e(treeNames[record.status] || record.status)}</span>`;
  const integration = tasks.filter((task) => task.integration);
  let delivery = '<p class="small-muted">尚无当前的整体合并验收记录；多个分支分别通过，不等于完整产品已交付。</p>';
  if (integration.length === 1) {
    const task = integration[0];
    const validation = state.detail.validations.filter((entry) => entry.taskId === task.id && entry.passed && entry.attempt === task.attempt && entry.taskRevision === (task.revision ?? 0)).at(-1);
    const receipt = state.detail.validationReceipts?.find((entry) => entry.id === validation?.receiptId);
    if (task.status === 'accepted' && receipt?.workspaceCommit) {
      const owner = agents.find((agent) => agent.id === task.ownerId);
      const tree = records.find((record) => record.id === owner?.worktreeId);
      delivery = `<article class="panel"><h3>${mission.status === 'completed' ? '最终合并交付' : '已记录整合验收，尚不代表 Mission 交付'}</h3><p class="text">${e(task.title)}</p><p class="small-muted mono digest">实际成果目录：${e(owner?.workspacePath || '未记录')}<br>成果分支：${e(tree?.branch || receipt.workspaceBranch || '未记录')}<br>已验收提交：${e(receipt.workspaceCommit)}</p><p class="small-muted">原工作副本没有被切换。交付物可在“交付与验收”下载；工作树和分支会保留，不自动删除。</p>${worktreeCommit(receipt)}</article>`;
    }
  }
  return `<div class="notice neutral">这是文件协作隔离，不是安全沙箱，也不隔离 Git 对象与分支。只能执行可信代码；本地提交、合并和冲突处理仍遵守工具审批。不会自动推送远端或覆盖原工作副本。</div>` +
    `<section class="panel"><h3>固定的仓库起点</h3><p class="small-muted mono digest">来源目录：${e(mission.repository?.path || '启动后固定')}<br>起点提交：${e(mission.repository?.baseCommit || '尚未检查')}<br>Git 存储：${e(mission.repository?.gitCommonDir || '尚未检查')}</p><p class="small-muted">只复制提交中的文件；忽略的依赖、凭证和本地文件不会复制。准备失败会保留现场，不自动清理或退回共享目录。</p></section>` +
    `<div class="section-head"><h2>合并后的整体交付</h2><span class="small-muted">独立验收，不是分支数量</span></div>${delivery}` +
    `<div class="section-head"><h2>代理工作目录 <span class="small-muted">${agentTrees.length}</span></h2></div>` +
    (agentTrees.length ? `<div class="cards">${agentTrees.map((record) => `<article class="panel"><div class="card-top"><h3>${e(agentName(record.agentId))}</h3>${treeBadge(record)}</div><p class="small-muted mono digest">实际目录：${e(record.path)}<br>本地分支：${e(record.branch || '未记录')}<br>创建起点：${e(record.baseCommit)}</p><p class="small-muted">创建 ${date(record.createdAt)} · 最近检查 ${date(record.checkedAt)}</p>${record.error ? `<p class="text danger-text">${e(record.error)}</p>` : ''}</article>`).join('')}</div>` : '<p class="small-muted">尚未准备代理目录。启动后会先持久保存身份，再准备工作树。</p>') +
    `<section class="panel"><details data-identity="worktree-validation-history"><summary>独立验收副本（${validationTrees.length} 个，最近 ${Math.min(50, validationTrees.length)} 个）</summary><p class="small-muted">验收者在任务拥有者的提交副本运行命令，不借用原仓库或其他代理的目录。副本和失败历史不会自动删除。</p>${validationTrees.slice(-50).reverse().map((record) => `<article class="panel"><div class="card-top"><h3>${e(agentName(record.agentId))}</h3>${treeBadge(record)}</div><p class="small-muted mono digest">副本目录：${e(record.path)}<br>验收提交：${e(record.baseCommit)}</p>${record.error ? `<p class="text danger-text">${e(record.error)}</p>` : ''}</article>`).join('') || '<p class="small-muted">尚无验收副本。</p>'}</details></section>`;
}

function renderTasks() {
  const groups = [['待开始', ['pending', 'ready', 'assigned']], ['工作中', ['running', 'blocked']], ['待验收', ['review']], ['已验收', ['accepted']]];
  return `<div class="task-board">${groups.map(([title, statuses]) => { const tasks = state.detail.tasks.filter((t) => statuses.includes(t.status)); return `<section class="task-column"><h3>${title}<span>${tasks.length}</span></h3>${tasks.map((t) => `<article class="task-card"><h3>${e(t.title)}</h3>${t.integration ? '<span class="badge">整体合并验收</span>' : ''}<p>${e(t.description)}</p>${badge(t.status)}<p><b>验收标准</b><br>${e(t.acceptance)}</p>${t.integration ? '<p>在合并后的完整提交上，额外复验当前全部需求；不重复认领需求。</p>' : ''}<div class="small-muted">${e(agentName(t.ownerId))} · 第 ${t.attempt} 次尝试${t.dependencies.length ? `<br>依赖 ${e(t.dependencies.map((id) => state.detail.tasks.find((task) => task.id === id)?.title || id).join('、'))}` : ''}</div>${t.evidence ? `<details data-identity="task-${e(t.id)}"><summary class="small-muted">查看证据</summary><pre class="output">${e(t.evidence)}</pre></details>` : ''}</article>`).join('') || '<p class="small-muted">暂无任务</p>'}</section>`; }).join('')}</div>`;
}

function renderRequirements() {
  const contract = state.detail.validationContract;
  if (!contract) return `<section class="panel"><h2>保留原有验收规则</h2><p class="text">这是启用逐条需求覆盖之前创建的 Mission。原任务、验收标准和历史回执没有被自动改写，不将已有通过记录冒充逐条需求验证。</p></section>`;
  const coverage = state.detail.requirementCoverage || [];
  const passed = coverage.filter((item) => item.status === 'passed').length;
  const editable = ['draft', 'paused', 'blocked'].includes(state.detail.mission.status);
  return `<div class="section-head"><h2>每条需求，都要有去处</h2>${editable ? button('修改验收契约', 'edit-contract', '', 'secondary') : '<span class="small-muted">暂停后才可修改标准</span>'}</div>` +
    `<section class="panel"><p class="text">契约第 ${contract.revision} 版 · ${passed} / ${contract.assertions.length} 条需求已通过独立验收</p><progress class="mission-progress" aria-label="已通过验收的需求" max="${contract.assertions.length || 1}" value="${passed}"></progress><p class="small-muted">每条需求只能由一个任务认领。遗漏、未验证和旧版本的通过记录，都不能让 Mission 完成。修改标准会使受影响任务及其依赖任务需要重新验收。</p></section>` +
    contract.assertions.map((assertion) => {
      const item = coverage.find((entry) => entry.assertion.id === assertion.id);
      const task = state.detail.tasks.find((entry) => entry.id === item?.taskId);
      const validation = state.detail.validations.find((entry) => entry.id === item?.validationId);
      const result = validation?.assertionResults?.find((entry) => entry.assertionId === assertion.id);
      return `<article class="panel"><div class="card-top"><span class="mission-number">${e(assertion.id)} · 修订 ${assertion.revision}</span>${badge(item?.status === 'passed' ? 'accepted' : item?.status || 'pending')}</div><p class="text">${e(assertion.description)}</p><p class="small-muted">负责的任务：${e(task?.title || '尚未分配')}<br>独立验收者：${e(task?.validatorId ? agentName(task.validatorId) : '尚未指定')}</p>${item?.receiptId ? `<details data-identity="requirement-${e(assertion.id)}"><summary class="small-muted">查看依据</summary><p class="text">${e(result?.evidence || validation?.evidence || '请查看关联的验收回执。')}</p><p class="text mono">回执：${e(item.receiptId)}</p>${button('查看交付与验收', 'view-validation', '', 'secondary small')}</details>` : '<p class="small-muted">尚无当前版本的独立验收依据。</p>'}</article>`;
    }).join('');
}

function contractDialog() {
  const { mission, validationContract: contract } = state.detail;
  if (!contract || !['draft', 'paused', 'blocked'].includes(mission.status)) return toast('请先暂停 Mission，再修改当前验收契约。');
  const fields = `<div class="notice">变更会留下版本历史。已改变的需求及其下游任务必须重新验收；历史通过记录不会删除，也不能继续当作新标准已通过。</div>` +
    contract.assertions.map((assertion, index) => `<fieldset class="role-fieldset"><legend>${e(assertion.id)} · 修订 ${assertion.revision}</legend>${field(`assertion-${index}`, '验收要求', assertion.description, { multiline: true, rows: 3 })}${check(`remove-${index}`, '删除这条需求（缩小范围，必须明确确认）')}</fieldset>`).join('') +
    field('additions', '新增需求（每行一条，可留空）', '', { multiline: true, rows: 3, help: '保存后获得稳定编号；已有需求保留原编号。' }) +
    field('reason', '为什么修改？', '', { required: true, multiline: true, rows: 2 }) +
    check('confirmRemoval', '我确认删除已勾选的需求，而不是用删除来掩盖验收失败');
  dialog(`修改验收契约 · 当前第 ${contract.revision} 版`, fields, async (data) => {
    const removing = contract.assertions.some((_, index) => data.has(`remove-${index}`));
    if (removing && !data.has('confirmRemoval')) throw new Error('删除需求会缩小交付范围，请明确勾选删除确认。');
    const assertions = contract.assertions.flatMap((assertion, index) => data.has(`remove-${index}`) ? [] : [{ id: assertion.id, description: String(data.get(`assertion-${index}`)).trim() }]);
    for (const description of String(data.get('additions')).split('\n').map((line) => line.trim()).filter(Boolean)) assertions.push({ id: `REQ-${crypto.randomUUID()}`, description });
    if (!assertions.length || assertions.some((assertion) => !assertion.description)) throw new Error('至少保留一条非空验收要求；删除需求请勾选删除，不要清空文本。');
    await api(`/api/missions/${encodeURIComponent(mission.id)}/validation-contract`, 'PUT', { expectedRevision: contract.revision, assertions, reason: data.get('reason'), confirmRemoval: data.has('confirmRemoval') });
    toast('验收契约已保存；受影响任务必须重新验收。');
  }, '确认变更并保存');
}

function renderMessages() {
  return `<div class="section-head"><h2>持久消息箱</h2>${button('＋ 发送消息', 'message')}</div>` + (state.detail.messages.length ? [...state.detail.messages].reverse().map((m) => `<article class="message"><div class="message-head"><b>${e(agentName(m.senderId))}</b><span>→</span><b>${e(agentName(m.recipientId))}</b><small>${date(m.createdAt)}</small></div><pre>${e(m.content)}</pre><div class="card-bottom">${badge(m.status)}<span>${m.mode === 'steer' ? '运行中插话' : '下一轮跟进'} · 第 ${m.attempt} 次投递</span></div>${m.error ? `<p class="danger-text text">${e(m.error)}</p>` : ''}</article>`).join('') : empty('消息会先保存，再投递', '队列确认不代表任务完成。回答、失败和投递尝试会分别记录。', '', true));
}

function approvalScope(approval) {
  const binding = approval.mcpBinding;
  if (!binding) return '';
  const server = (state.app.mcpServers || []).find((item) => item.id === binding.serverId);
  const actor = state.detail.agents.find((item) => item.id === approval.agentId);
  const stale = !server?.enabled || server.revision !== binding.serverRevision || actor?.epoch !== binding.actorEpoch;
  const source = approval.status === 'pending' ? '尚未批准执行' : approval.authorizationSource === 'user-approval' ? '人工批准' : '按角色权限授权';
  return `<p class="text"><b>外部工具：${e(binding.toolName)}</b><br>连接：${e(server?.name || binding.serverId)}</p><p class="small-muted mono">服务器 ID：${e(binding.serverId)} · 配置修订 ${e(binding.serverRevision)}<br>角色修订 ${e(binding.roleRevision)} · 代理代次 ${e(binding.actorEpoch)} · ${source}<br>工具定义 SHA-256：${e(binding.definitionHash)}</p>${approval.status === 'pending' ? `<div class="notice">${stale ? '配置或代理状态已变化，旧审批不能执行。' : '本次批准只用于以上工具及下面的参数；执行前会再次核对权限与工具定义。'} MCP 结果不代表独立验收通过。</div>` : ''}`;
}

function renderApprovals() {
  const pending = state.detail.approvals.filter((a) => a.status === 'pending');
  const history = state.detail.approvals.filter((a) => a.status !== 'pending');
  return pending.map((a) => `<article class="panel approval"><div class="card-top"><h3>${e(agentName(a.agentId))} 请求执行 ${e(a.tool)}</h3>${badge(a.status)}</div>${approvalScope(a)}<pre class="output">${e(JSON.stringify(a.args, null, 2))}</pre><div class="actions section-head">${button('批准这一次', 'approve', a.id)}${button('拒绝', 'deny', a.id, 'secondary')}</div></article>`).join('') +
    (history.length ? `<details data-identity="approval-history"><summary class="small-muted">已处理授权 · ${history.length} 次（批准不等于执行成功）</summary>${history.map((a) => `<article class="panel"><div class="card-top"><h3>${e(agentName(a.agentId))} · ${e(a.tool)}</h3>${badge(a.status)}</div>${approvalScope(a)}<pre class="output">${e(JSON.stringify(a.args, null, 2))}</pre>${a.receipt ? executionOutput(a.receipt) : '<p class="small-muted">尚无执行结果回执。</p>'}<p class="small-muted">${date(a.createdAt)}</p></article>`).join('')}</details>` : '');
}

function executionOutput(receipt) {
  return `<p class="small-muted">退出码：<b>${receipt.exitCode === null ? '无（中断或异常）' : e(receipt.exitCode)}</b></p>` +
    `<h3>标准输出</h3><pre class="output receipt-output">${e(receipt.stdout || '（无标准输出）')}</pre>` +
    `<h3>错误输出</h3><pre class="output receipt-output">${e(receipt.stderr || '（无错误输出）')}</pre>`;
}

function renderBlockers() {
  const blockers = state.detail.blockers || [];
  const open = blockers.filter((item) => item.status === 'open');
  return open.map((item) => `<section class="panel approval"><div class="card-top"><h3>${item.kind === 'user_input' ? '团队需要你的回答' : '需要人工处理'}</h3>${badge('blocked')}</div><p class="text">${e(item.text)}</p>${item.kind === 'unsafe_execution' ? '<p class="notice">命令可能已经产生外部影响。请先核对真实状态，不要把“没有收到结果”理解为“没有执行”。记录处置不等于自动重跑。</p>' : ''}${button(item.kind === 'user_input' ? '回答团队' : '记录处理结果', 'resolve-blocker', item.id, 'secondary')}</section>`).join('');
}

function renderArtifacts() {
  return `<div class="section-head"><h2>交付物</h2><a class="button secondary small" href="/api/missions/${encodeURIComponent(state.missionId)}/export" download>导出证据</a></div>` +
    (state.detail.artifacts.length ? `<div class="table-wrap"><table><thead><tr><th>交付物</th><th>来源</th><th>内容身份 SHA-256</th><th>操作</th></tr></thead><tbody>${state.detail.artifacts.map((a) => `<tr><td>${e(a.name)}<small>源文件：${e(a.path)}</small><small>${a.snapshotPath ? '后台保留独立快照' : '未记录独立快照'}</small>${a.workspaceCommit ? `<small class="mono">发布提交：${e(a.workspaceCommit)}<br>提交内路径：${e(a.relativePath)}</small>` : ''}</td><td>${e(agentName(a.agentId))}<small>${date(a.createdAt)}</small></td><td class="mono digest">${e(a.sha256)}<small>${a.size} bytes</small></td><td><a class="button secondary small" href="/api/artifacts/${encodeURIComponent(a.id)}/content" download>下载</a></td></tr>`).join('')}</tbody></table></div>` : empty('还没有交付物', '代理需要发布实际文件，并由后台保存交付快照，模型口头承诺不算交付。', '', true)) +
    `<div class="section-head"><h2>独立验收记录（含历史版本）</h2></div><p class="small-muted">以下保留每次验收的原始结论；当前需求是否通过，以“需求覆盖”中的当前版本为准。旧版 Mission 仍按原有验收规则判断。</p>` +
    (state.detail.validations.length ? state.detail.validations.map((v) => `<article class="panel"><div class="card-top"><h3>${e(state.detail.tasks.find((t) => t.id === v.taskId)?.title || v.taskId)}</h3>${badge(v.passed ? 'accepted' : 'failed')}</div><pre class="output">${e(v.evidence)}</pre><p class="small-muted">验收者 ${e(agentName(v.agentId))} · ${date(v.createdAt)}<br>执行回执：${e(v.receiptId || '未关联')} · 任务修订 ${e(v.taskRevision ?? '未记录')}</p></article>`).join('') : '<p class="small-muted">尚无验收结论。执行者不能验收自己的工作，运行命令也不等于已经接受交付。</p>') +
    `<div class="section-head"><h2>真实命令回执</h2><span class="small-muted">保留成功与失败，不能用新结果覆盖旧失败</span></div>` +
    ((state.detail.validationReceipts || []).map((receipt) => `<article class="panel"><div class="card-top"><h3>${e(state.detail.tasks.find((t) => t.id === receipt.taskId)?.title || receipt.taskId)}</h3>${badge(receipt.exitCode === 0 ? 'succeeded' : receipt.exitCode === null ? 'uncertain' : 'failed')}</div><pre class="output">${e(receipt.command)}</pre><p class="small-muted">${e(agentName(receipt.validatorId))} · 第 ${Number(receipt.attempt) + 1} 轮 · 任务修订 ${e(receipt.taskRevision)} · ${date(receipt.createdAt)}<br>回执 ${e(receipt.id)}</p>${worktreeCommit(receipt)}<details data-identity="receipt-${e(receipt.id)}"><summary class="small-muted">查看完整输出与交付物身份</summary>${executionOutput(receipt)}<h3>绑定的交付物</h3>${receipt.artifactIds.map((id) => `<p class="small-muted mono digest">${e(state.detail.artifacts.find((item) => item.id === id)?.name || id)}<br>${e(receipt.artifactDigests[id])}</p>`).join('')}</details></article>`).join('') || '<p class="small-muted">尚未执行独立验收命令。</p>');
}

const scheduleNames = { enabled: '已启用', held: '已暂停', finished: '已到期', deleted: '已移除' };
const deliveryNames = { queued: '已排队', dispatching: '投递中', admitted: '已接收', completed: '本轮结束', aborted: '已撤回', uncertain: '结果不确定', failed: '投递失败', skipped: '已跳过' };
const cadenceOptions = [['*/15 * * * *', '每 15 分钟'], ['0 * * * *', '每小时整点'], ['0 9 * * *', '每天 09:00'], ['0 9 * * 1', '每周一 09:00'], ['custom', '自定义 Cron']];
const scheduleTime = (value) => value ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'short' }) : '—';
function scheduleReason(reason) {
  return { manual_hold: '由你暂停，需明确启用才会触发', manual_delete: '已移除计划，历史记录保留', mission_not_active: 'Mission 未运行，本次不唤醒', mission_completed: 'Mission 已交付，不再唤醒', mission_cancelled: 'Mission 已取消，不再唤醒', mission_not_found: '所属 Mission 不存在，请检查记录', team_busy: '团队正在工作，本次不追加消息', open_blocker: '存在未处理的阻塞事项', outbox_pending: '先前消息仍在处理或结果不确定', approval_pending: '存在未完成审批或待核对的操作', turn_budget_exhausted: '执行轮次已用尽', cost_budget_exhausted: '已达到模型费用上限', orchestrator_unavailable: '负责人尚未就绪', invalid_schedule: '计划数据异常，已停止触发，请编辑修复', next_run_unavailable: '无法计算下一次时刻，已暂停计划', scheduler_error: '调度发生错误，已暂停此计划' }[reason] || reason || '';
}

function renderSchedules() {
  const { mission } = state.detail;
  const schedules = state.detail.schedules || [];
  const occurrences = state.detail.scheduleOccurrences || [];
  const editable = !['completed', 'cancelled'].includes(mission.status);
  const cards = schedules.map((item) => {
    const actions = [];
    if (editable && item.status !== 'deleted') {
      actions.push(button('编辑', 'edit-schedule', item.id, 'secondary small'));
      if (item.status === 'enabled') actions.push(button('暂停计划', 'hold-schedule', item.id, 'secondary small'));
      if (item.status === 'held') actions.push(button('启用计划', 'resume-schedule', item.id, 'secondary small'));
      actions.push(button('移除', 'delete-schedule', item.id, 'secondary small danger'));
    }
    const description = item.schedule.kind === 'once' ? `单次 · ${scheduleTime(item.schedule.at)}` : `${cadenceOptions.find(([expression]) => expression === item.schedule.expression)?.[1] || item.schedule.expression} · ${item.schedule.timeZone}`;
    return `<article class="panel"><div class="card-top"><span class="mission-number">计划 / 修订 ${e(item.revision)}</span><span class="badge ${item.status === 'enabled' ? 'active' : ''}">${e(scheduleNames[item.status] || item.status)}</span></div><h3>${e(item.name)}</h3><p class="text">${e(description)}</p><p class="agent-meta">${item.status === 'enabled' ? '下次检查时刻' : '计划时刻（未启用不触发）'}：${e(scheduleTime(item.nextRunAt))}</p><p class="text">${e(item.prompt)}</p>${item.reason ? `<p class="small-muted">${e(scheduleReason(item.reason))}</p>` : ''}<div class="actions">${actions.join('')}</div></article>`;
  }).join('');
  return `<div class="notice neutral">由后台唤醒同一个负责人，不依赖浏览器开着。仅在 Mission 已启动、团队空闲且预算允许时发送消息；暂停、阻塞不会被自动解除。重启错过多次只合并检查一次，忙碌时跳过，不堆积催办。</div>` +
    `<div class="section-head"><h2>定时计划 <span class="small-muted">${schedules.filter((item) => item.status !== 'deleted').length}</span></h2>${editable ? button('＋ 新建定时计划', 'new-schedule') : ''}</div>` +
    (schedules.length ? `<div class="cards">${cards}</div>` : empty('还没有定时唤醒', editable ? '设置一次提醒或周期检查。新计划默认暂停，由你明确启用。' : '这个 Mission 已结束，不能再被计划唤醒。', editable ? button('新建定时计划', 'new-schedule') : '', true)) +
    `<div class="section-head"><h2>触发与投递记录</h2><span class="small-muted">最近 ${Math.min(200, occurrences.length)} 条 · 时刻按浏览器时区显示</span></div>` +
    '<p class="small-muted">“本轮结束”只代表这条输入的代理轮次结束，不代表任务验收通过。移除计划会保留历史；暂停计划也不会撤销已投递的操作。</p>' +
    (occurrences.length ? `<div class="table-wrap"><table><thead><tr><th>计划 / 修订</th><th>预定 / 实际检查</th><th>原投递结果</th></tr></thead><tbody>${occurrences.slice(-200).reverse().map((item) => {
      const delivery = item.deliveryStatus || item.outcome;
      return `<tr><td>${e(schedules.find((plan) => plan.id === item.scheduleId)?.name || item.scheduleId)}<small>修订 ${e(item.scheduleRevision)} · ${e(item.id)}</small></td><td>${e(scheduleTime(item.scheduledFor))}<small>检查：${e(scheduleTime(item.observedAt))}</small></td><td><span class="badge ${delivery === 'uncertain' ? 'uncertain' : ''}">${e(deliveryNames[delivery] || delivery)}</span>${item.reason ? `<small>${e(scheduleReason(item.reason))}</small>` : ''}${item.deliveryError ? `<small>${e(item.deliveryError)}</small>` : ''}${item.messageId ? `<small>消息 ${e(item.messageId)} · 原尝试 ${e(item.attempt)}</small>` : ''}</td></tr>`;
    }).join('')}</tbody></table></div>` : '<p class="small-muted">还没有触发记录。保存计划不等于已经执行。</p>');
}

const watchdogDiagnoses = {
  observation_error: ['监测检查失败', '后台本次检查未成功，不能把旧观察当成当前状态；请检查活动记录和后台日志。失败的检查不会重放旧操作。'],
  not_observed: ['等待首次检查', '后台会定期检查实际状态；此时还没有停滞结论。'],
  mission_inactive: ['当前不运行', '监测不会启动、恢复或重新打开 Mission。需要继续时，请由你明确操作。'],
  waiting_user: ['等待你的回答', '先处理团队提出的问题。等待人工决定不算停滞，也不会自动催办。'],
  waiting_approval: ['等待审批', '先检查待审批或正在执行的操作。自动唤醒不会替你批准。'],
  blocked: ['存在阻塞事项', '检查阻塞原因、任务和不确定操作。监测不会清除阻塞或重放旧指令。'],
  offline: ['团队尚未就绪', '有代理离线、恢复中或出错。请检查代理状态与后台日志；不会用新代理替换旧身份。'],
  running: ['团队正在推进', '团队正在处理工作；不会往正在执行的代理追加催办消息。'],
  running_no_progress: ['执行中，进展需核对', '一段时间未看到任务或交付证据变化。这也可能是正常的长耗时工作，不代表已经卡死；监测不会强杀或中断。'],
  delivery_pending: ['先前投递尚未结束', '等待现有输入完成，或核对结果不确定的操作。自动唤醒不重试旧投递。'],
  budget_exhausted: ['预算已到上限', '不会继续调用模型。调整预算需要你明确操作，已经消耗的轮次与费用不会重置。'],
  no_pending_tasks: ['没有待推进任务', '当前没有未验收任务，因此不会自动唤醒。这不代表 Mission 已完成；交付仍受独立验收门槛约束。'],
  observing: ['正在观察空闲', '有待办且团队空闲。只有持续满足条件，才会判为无人推进；短暂等待不会立刻触发。'],
  stalled: ['有待办，暂时无人推进', '已达到连续空闲观察时长。你可以检查任务、给负责人发消息，或明确开启有界自动唤醒。'],
  wake_queued: ['已安排一次唤醒', '新输入已持久排队给原负责人；排队不等于已执行，更不等于验收通过。'],
  needs_attention: ['已唤醒，仍需核对', '相同工作状态已用过一次自动唤醒。不再循环催办；请检查原投递、任务与证据，必要时明确给负责人发消息。']
};

function renderWatchdog() {
  const { mission } = state.detail;
  const monitor = state.detail.watchdog;
  const diagnosis = monitor?.diagnosis || 'not_observed';
  const [title, description] = watchdogDiagnoses[diagnosis] || ['需要检查', '后台返回了未知诊断，请查看活动记录。'];
  const attention = ['blocked', 'offline', 'running_no_progress', 'budget_exhausted', 'stalled', 'needs_attention', 'observation_error'].includes(diagnosis);
  const editable = !['completed', 'cancelled'].includes(mission.status);
  const wakes = state.detail.watchdogWakes || [];
  return `<section class="panel"><div class="section-head"><div><span class="mission-number">推进监测 · ${monitor?.autoWake ? '已开启有界唤醒' : '仅观察，不调用模型'}</span><h2>${e(title)}</h2></div><div class="actions"><span class="badge ${attention ? 'blocked' : ''}">${attention ? '需留意' : '后台检查'}</span>${editable ? button(monitor?.autoWake ? '关闭自动唤醒' : '开启自动唤醒', 'configure-watchdog', '', 'secondary small') : ''}</div></div>` +
    `<p class="text">${e(description)}</p><p class="small-muted">待推进任务 ${monitor?.pendingTaskIds?.length ?? 0} · 连续空闲观察 ${Math.round((monitor?.idleThresholdMs ?? 60000) / 1000)} 秒 · 执行中 ${Math.round((monitor?.runningThresholdMs ?? 600000) / 60000)} 分钟无实质进展时提示核对</p>` +
    `<p class="agent-meta">工作状态保持自：${e(scheduleTime(monitor?.progressSince))}<br>连续空闲观察自：${e(scheduleTime(monitor?.eligibleSince))}<br>最近检查：${e(scheduleTime(monitor?.checkedAt))}</p>` +
    '<p class="small-muted">同一份工作状态最多自动唤醒一次。刷新、重启、开关切换、汇报“还在等”都不会重置。只有任务或验收证据发生实质变化后，才重新观察；暂停、审批、不确定操作和预算限制始终优先。关闭自动唤醒不撤销已排队的输入。</p>' +
    (wakes.length ? `<details data-identity="watchdog-history"><summary>自动唤醒历史（${wakes.length} 条，显示最近 ${Math.min(50, wakes.length)} 条）</summary><p class="small-muted">“本轮结束”不是任务验收。原消息、请求和尝试保持不变，失败或不确定结果不会被改写。</p><div class="table-wrap"><table><thead><tr><th>安排时刻</th><th>原投递状态</th><th>关联标识</th></tr></thead><tbody>${wakes.slice(-50).reverse().map((wake) => `<tr><td>${e(scheduleTime(wake.createdAt))}</td><td><span class="badge ${wake.deliveryStatus === 'uncertain' ? 'uncertain' : ''}">${e(deliveryNames[wake.deliveryStatus] || wake.deliveryStatus || '尚无投递记录')}</span>${wake.deliveryError ? `<small>${e(wake.deliveryError)}</small>` : ''}</td><td><small>消息：${e(wake.messageId)}</small><small>请求：${e(wake.requestId)}</small><small>原尝试：${e(wake.attempt)} · 工作指纹：${e(wake.fingerprint)}</small></td></tr>`).join('')}</tbody></table></div></details>` : '<p class="small-muted">还没有自动唤醒记录。</p>') + '</section>';
}

function watchdogDialog() {
  const { mission } = state.detail;
  if (['completed', 'cancelled'].includes(mission.status)) return toast('已结束的 Mission 不再配置唤醒。');
  const autoWake = !state.detail.watchdog?.autoWake;
  const expectedRevision = state.detail.watchdog?.revision ?? 1;
  const requestId = crypto.randomUUID();
  dialog(autoWake ? '开启有界自动唤醒' : '关闭自动唤醒', autoWake
    ? '<p class="text">有待办、团队持续空闲且没有阻塞时，后台会向原负责人发送一次新输入。同一份工作状态不会反复催办。</p><p class="notice neutral">这可能产生额外模型调用，并占用现有预算；未配置单价不代表免费。不会自动恢复暂停的 Mission、替你审批，或重试结果不确定的旧操作。</p>'
    : '<p class="text">关闭后只保留诊断，不再新增自动唤醒。已经排队或被代理接收的输入不会撤回，原投递与历史记录保留。</p>', async () => {
      await api(`/api/missions/${encodeURIComponent(mission.id)}/watchdog`, 'POST', { requestId, expectedRevision, autoWake });
      toast(autoWake ? '已开启有界唤醒；仍需满足任务、状态和预算条件。' : '已关闭自动唤醒，继续观察。');
    }, autoWake ? '确认开启' : '确认关闭');
}

function renderDetail() {
  const { mission, tasks, agents, events } = state.detail;
  const controls = [badge(mission.status)];
  if (mission.status === 'draft') controls.push(button('启动 Mission', 'start'));
  if (['active', 'validating'].includes(mission.status)) controls.push(button('暂停', 'pause', '', 'secondary'));
  if (['paused', 'blocked', 'failed'].includes(mission.status)) controls.push(button('继续执行', 'resume'));
  if (!['completed', 'cancelled'].includes(mission.status)) controls.push(button('取消', 'cancel', '', 'secondary danger'));
  if (['draft', 'paused', 'blocked', 'failed'].includes(mission.status)) controls.push(button('调整预算', 'edit-limits', '', 'secondary'));
  controls.push(button('重命名', 'rename', '', 'secondary'));
  const accepted = tasks.filter((t) => t.status === 'accepted').length;
  const tabs = [['overview', '概览'], ['requirements', '需求覆盖'], ['tasks', '任务'], ['agents', '团队'], ['worktrees', '工作目录'], ['messages', '消息'], ['schedules', '定时唤醒'], ['artifacts', '交付与验收'], ['events', '活动记录']];
  let content = '';
  if (state.tab === 'overview') content = `<div class="split"><div><section class="panel"><h3>目标</h3><p class="text">${e(mission.goal)}</p><h3>${state.detail.validationContract ? '创建时的验收说明' : '验收标准'}</h3><p class="text">${e(mission.acceptance)}</p>${state.detail.validationContract ? '<p class="small-muted">当前逐条标准和修订结果，请查看“需求覆盖”。修改后的标准不会覆盖这里的原始说明。</p>' : ''}<progress class="mission-progress" aria-label="通过独立验收的任务" max="${tasks.length || 1}" value="${accepted}"></progress><span class="small-muted">${accepted} / ${tasks.length} 个任务通过独立验收</span></section><div class="section-head"><h2>持久代理团队</h2>${button('添加代理', 'spawn-agent', '', 'secondary small')}</div>${renderAgents(agents)}</div><section class="panel"><div class="section-head"><h2>最新活动</h2><span class="small-muted">持久事件记录</span></div>${timeline(events, 12)}</section></div>`;
  if (state.tab === 'overview') content = renderWatchdog() + renderWorktreeSummary() + content;
  if (state.tab === 'worktrees') content = renderWorktrees();
  if (state.tab === 'tasks') content = renderTasks();
  if (state.tab === 'requirements') content = renderRequirements();
  if (state.tab === 'agents') content = `<div class="section-head"><h2>代理团队</h2>${button('＋ 添加代理', 'spawn-agent')}</div>${renderAgents(agents)}`;
  if (state.tab === 'messages') content = renderMessages();
  if (state.tab === 'schedules') content = renderSchedules();
  if (state.tab === 'artifacts') content = renderArtifacts();
  if (state.tab === 'events') content = `<section class="panel">${timeline(events, 300)}</section>`;
  return `<a class="back-link" href="#missions">← 所有 Missions</a>` + heading(`MISSION / ${mission.id.slice(0, 8).toUpperCase()}`, mission.title, `${workspaceName(mission.workspaceId)} · ${mission.autonomy === 'trusted' ? '可信自主执行' : '工具操作需审批'} · 创建于 ${date(mission.createdAt)}`, controls.join('')) +
    `<div class="stats">${stat('任务验收', `${accepted} / ${tasks.length}`, '独立验证后才能完成')}${stat('活跃代理', `${agents.filter((a) => a.status === 'running').length} / ${agents.length}`, '各自保持上下文')}${stat('执行轮次', `${mission.turns} / ${mission.maxTurns}`, '达到上限后停止派工')}${stat('已记录模型费用', mission.costKnown ? `$${Number(mission.cost).toFixed(4)}` : '未定价', mission.costKnown ? `${mission.maxCost > 0 ? `上限 $${mission.maxCost}` : '未设置费用上限'} · 不含未结算请求` : '未配置单价，不假装免费')}</div>` +
    (['paused', 'blocked'].includes(mission.status) ? `<div class="notice">${mission.status === 'paused' ? '已冻结新派工。迟到报告仍会保存，但不会偷偷唤醒负责人。' : 'Mission 需要处理阻塞。查看活动与消息，解决原因后再继续。'}</div>` : '') + renderBlockers() + renderApprovals() +
    `<div class="tabs" role="tablist" aria-label="Mission 内容">${tabs.map(([key, label]) => `<button role="tab" aria-selected="${key === state.tab}" class="tab ${key === state.tab ? 'active' : ''}" data-tab="${key}">${label}${key === 'agents' ? ` ${agents.length}` : ''}${key === 'tasks' ? ` ${tasks.length}` : ''}</button>`).join('')}</div>${content}`;
}

function render() {
  if (!state.app) return;
  renderNav();
  const active = document.activeElement;
  const mainHadFocus = Boolean(active?.closest('#main'));
  const editingSearch = active?.id === 'mission-search';
  const selection = editingSearch ? active.selectionStart : 0;
  const selectionEnd = editingSearch ? active.selectionEnd : 0;
  const focusKey = active?.dataset.action || active?.dataset.tab || active?.dataset.filter;
  const focusId = active?.dataset.id;
  const expanded = new Set([...$('#main').querySelectorAll('details[open]')].map((node) => node.dataset.identity).filter(Boolean));
  $('#main').innerHTML = state.missionId && state.detail ? renderDetail() : ({ missions: renderMissions, profiles: renderProfiles, roles: renderRoles, mcp: renderMcp, workspaces: renderWorkspaces, machines: renderMachines }[state.section] || renderMissions)();
  for (const node of $('#main').querySelectorAll('details[data-identity]')) node.open = expanded.has(node.dataset.identity);
  if (editingSearch && $('#mission-search')) { $('#mission-search').focus({ preventScroll: true }); $('#mission-search').setSelectionRange(selection, selectionEnd); }
  else if (focusKey && mainHadFocus) [...$('#main').querySelectorAll('button')].find((node) => (node.dataset.action || node.dataset.tab || node.dataset.filter) === focusKey && node.dataset.id === focusId)?.focus({ preventScroll: true });
}

async function load(force = false) {
  if (loading) { if (force) pendingLoad = true; return; }
  if ($('#dialog').open && !force) return;
  loading = true;
  const version = routeVersion;
  try {
    const app = await api('/api/state');
    const detail = state.missionId ? await api(`/api/missions/${encodeURIComponent(state.missionId)}`) : null;
    if (version !== routeVersion) { pendingLoad = true; return; }
    const snapshot = JSON.stringify({ app, detail, routeVersion });
    const changed = snapshot !== lastSnapshot;
    lastSnapshot = snapshot;
    state.app = app;
    state.detail = detail;
    $('#connection').textContent = '后台已连接';
    $('#connection-dot').className = 'connection-dot online';
    if (changed || force) render();
  } catch (error) {
    $('#connection').textContent = '后台连接中断';
    $('#connection-dot').className = 'connection-dot offline';
    if (!state.app || force) $('#main').innerHTML = `<section class="empty error-panel"><h2>无法读取当前状态</h2><p>${e(error.message)}</p><p>界面不会将连接失败显示为任务完成。检查后台进程后重试。</p>${button('重新连接', 'reload')}</section>`;
  } finally { loading = false; if (pendingLoad) { pendingLoad = false; void load(true); } }
}

function scheduleDialog(id) {
  const mission = state.detail.mission;
  if (['completed', 'cancelled'].includes(mission.status)) return toast('已结束的 Mission 不能再配置唤醒。');
  const current = id ? state.detail.schedules?.find((item) => item.id === id) : undefined;
  if (id && (!current || current.status === 'deleted')) return toast('计划已变更，请刷新后再操作。');
  const spec = current?.schedule || { kind: 'once', at: new Date(Date.now() + 5 * 60 * 1000).toISOString() };
  let localTime = new Date(spec.kind === 'once' ? spec.at : Date.now() + 5 * 60 * 1000);
  if (!Number.isFinite(localTime.getTime())) localTime = new Date(Date.now() + 5 * 60 * 1000);
  const at = new Date(localTime.getTime() - localTime.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  const expression = spec.kind === 'cron' ? spec.expression : '0 9 * * *';
  const cadence = cadenceOptions.some(([value]) => value === expression) ? expression : 'custom';
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const requestId = crypto.randomUUID();
  const fields = '<div class="notice neutral">只给原负责人增加一条后续消息，不自动启动或恢复 Mission，不增加预算。计划暂停或团队忙碌时不会不断排队。</div>' +
    field('name', '计划名称', current?.name || '', { required: true, placeholder: '例如：每天检查待处理事项' }) +
    field('kind', '触发方式', spec.kind, { choices: [['once', '单次唤醒'], ['cron', '周期唤醒']] }) +
    field('at', `执行时间（浏览器时区：${browserZone}）`, at, { required: true, type: 'datetime-local', step: 1, help: '后台保存为明确的 UTC 时刻。已过去的时间不能启用。' }) +
    field('cadence', '检查周期', cadence, { choices: cadenceOptions }) +
    field('expression', 'Cron 表达式', expression, { required: true, help: '五段：分钟 小时 日期 月份 星期。不支持秒级催办。' }) +
    field('timeZone', '周期所用时区', spec.kind === 'cron' ? spec.timeZone : browserZone, { required: true, help: '例如 Asia/Shanghai、Europe/London 或 UTC；与浏览器时区可以不同。' }) +
    field('prompt', '到时让负责人做什么？', current?.prompt || '', { required: true, multiline: true, rows: 4, placeholder: '说明检查什么、什么条件下继续工作。原验收标准、权限和总预算仍然有效。' }) +
    check('enabled', '保存后启用此计划（不启动或恢复 Mission）', current?.status === 'enabled');
  dialog(current ? '编辑定时计划' : '新建定时计划', fields, async (data) => {
    const name = String(data.get('name') || '').trim();
    const prompt = String(data.get('prompt') || '').trim();
    if (!name || name.length > 160 || !prompt || prompt.length > 10000) throw new Error('名称需为 1–160 字符，指令需为 1–10000 字符。');
    let schedule;
    if (data.get('kind') === 'once') {
      const time = new Date(String(data.get('at')));
      if (!Number.isFinite(time.getTime()) || time.getTime() <= Date.now()) throw new Error('请选择一个有效的未来时间。');
      schedule = { kind: 'once', at: time.toISOString() };
    } else {
      const selected = String(data.get('cadence'));
      const cron = (selected === 'custom' ? String(data.get('expression') || '') : selected).trim();
      if (cron.split(/\s+/).length !== 5) throw new Error('Cron 必须有五段，不接受秒字段。');
      const timeZone = String(data.get('timeZone') || '').trim();
      try { new Intl.DateTimeFormat('zh-CN', { timeZone }).format(new Date()); } catch { throw new Error('请输入有效时区，例如 Asia/Shanghai 或 UTC。'); }
      schedule = { kind: 'cron', expression: cron, timeZone };
    }
    const body = { requestId, name, prompt, schedule, enabled: data.has('enabled'), ...(current ? { expectedRevision: current.revision } : {}) };
    await api(`/api/missions/${encodeURIComponent(mission.id)}/schedules${current ? `/${encodeURIComponent(current.id)}` : ''}`, current ? 'PATCH' : 'POST', body);
    toast(body.enabled ? '计划已保存并启用，仍受 Mission 状态与预算限制。' : '计划已保存为暂停，需要时请明确启用。');
  }, '保存计划');
  const updateFields = () => {
    const recurring = $('#f-kind').value === 'cron';
    for (const [name, visible] of [['at', !recurring], ['cadence', recurring], ['expression', recurring && $('#f-cadence').value === 'custom'], ['timeZone', recurring]]) {
      const input = $(`#f-${name}`);
      input.disabled = !visible;
      input.closest('.field').hidden = !visible;
    }
  };
  $('#f-kind').addEventListener('change', updateFields);
  $('#f-cadence').addEventListener('change', updateFields);
  updateFields();
}

function scheduleAction(action, id) {
  const missionId = state.detail.mission.id;
  const item = state.detail.schedules?.find((plan) => plan.id === id);
  if (!item) return toast('计划已变更，请刷新后重试。');
  const requestId = crypto.randomUUID();
  const labels = { hold: '暂停计划', resume: '启用计划', delete: '移除计划' };
  const explanation = action === 'resume' ? '从下一个未来时刻开始。不会自动启动或恢复 Mission，也不会补发暂停期间错过的提醒。单次时间已过期的计划需先编辑。' : '只停止今后的定时触发，不撤销已投递的消息或已经发生的操作。计划与触发历史仍会保留。';
  dialog(`${labels[action]}？`, `<p class="text">${e(item.name)}</p><div class="notice">${explanation}</div>`, async () => {
    await api(`/api/missions/${encodeURIComponent(missionId)}/schedules/${encodeURIComponent(id)}/${action}`, 'POST', { requestId, expectedRevision: item.revision });
    toast(`${labels[action]}已保存，历史记录保留。`);
  }, `确认${labels[action]}`);
}

function limitsDialog() {
  const { mission } = state.detail;
  if (!['draft', 'paused', 'blocked', 'failed'].includes(mission.status)) return toast('请先暂停 Mission，再调整预算。');
  const minimum = Math.max(1, mission.turns);
  const fields = `<div class="notice neutral">填写整个 Mission 的总上限，不是追加的轮数。已使用的 ${e(mission.turns)} 轮及历史证据不会重置。保存只调整预算，不会自动恢复执行或重放中断消息。</div>` +
    field('maxTurns', '执行轮次总上限', mission.maxTurns, { type: 'number', min: minimum, required: true, help: `当前总上限 ${mission.maxTurns} 轮；新的总上限不能低于 ${minimum}。` }) +
    '<p id="budget-remaining" class="small-muted" aria-live="polite"></p>' +
    (mission.costKnown ? field('maxCost', '模型费用总上限（美元）', mission.maxCost, { type: 'number', min: 0, step: 'any', required: true, help: `已记录 $${Number(mission.cost).toFixed(4)}，不含未结算请求。0 表示不设金额上限，仍受轮次限制；金额上限不是预付费硬额度。` }) : '<p class="text">模型单价未知，无法估算费用或启用金额上限。本次只能调整轮次，不代表调用免费。</p>');
  dialog('调整 Mission 预算', fields, async (data) => {
    const maxTurns = Number(data.get('maxTurns'));
    if (!Number.isSafeInteger(maxTurns) || maxTurns < minimum) throw new Error(`总上限必须是至少 ${minimum} 的整数，不能清零已用轮次。`);
    const payload = { maxTurns };
    if (mission.costKnown) {
      const maxCost = Number(data.get('maxCost'));
      if (!Number.isFinite(maxCost) || maxCost < 0) throw new Error('费用上限必须是大于等于 0 的有限数字。');
      payload.maxCost = maxCost;
    }
    await api(`/api/missions/${encodeURIComponent(mission.id)}`, 'PATCH', payload);
    toast('预算已保存，历史轮次保留；需要时请单独继续执行。');
  }, '保存预算');
  const updateRemaining = () => {
    const input = $('#f-maxTurns');
    const total = Number(input.value);
    $('#budget-remaining').textContent = !input.value || !Number.isSafeInteger(total) || total < minimum
      ? `请输入不少于 ${minimum} 的整数总上限。`
      : `保留已用 ${mission.turns} 轮，最多还可使用 ${total - mission.turns} 轮。${total === mission.turns ? '没有剩余轮次，不能继续执行。' : ''}`;
  };
  $('#f-maxTurns').addEventListener('input', updateRemaining);
  updateRemaining();
}

function profileDialog(id) {
  const p = state.app.profiles.find((item) => item.id === id) || { name: '', api: 'openai-completions', baseUrl: '', credentialEnv: '', modelId: '', contextWindow: 128000, maxTokens: 8192, toolCalling: true, vision: false, reasoning: false };
  const costFields = [['input', '输入单价'], ['output', '输出单价'], ['cacheRead', '缓存读取单价'], ['cacheWrite', '缓存写入单价']];
  const fields = `<div class="form-grid">` +
    field('name', '连接名称', p.name, { required: true }) +
    field('api', '接口协议', p.api, { choices: [['openai-completions', 'OpenAI Chat Completions'], ['openai-responses', 'OpenAI Responses'], ['anthropic-messages', 'Anthropic Messages']] }) +
    field('modelId', '模型 ID', p.modelId, { required: true, placeholder: '例如 MiniMax-M2.5' }) +
    field('credentialEnv', '密钥环境变量名称', p.credentialEnv, { placeholder: '例如 MINIMAX_CN', pattern: '[A-Za-z_][A-Za-z0-9_]*', help: '不要粘贴密钥。无需认证的服务可留空。' }) +
    field('baseUrl', '接口地址', p.baseUrl, { required: true, type: 'url', wide: true, placeholder: 'https://example.com/v1' }) +
    field('contextWindow', '上下文窗口', p.contextWindow, { type: 'number', min: 1024, required: true }) +
    field('maxTokens', '单次最大输出', p.maxTokens, { type: 'number', min: 128, required: true }) + '</div>' +
    check('toolCalling', '模型支持工具调用（Mission 必需）', p.toolCalling) +
    check('vision', '模型支持图片输入', p.vision) + check('reasoning', '模型支持推理模式', p.reasoning) +
    `<details><summary class="small-muted">计价（美元 / 百万 token，可选）</summary><p class="small-muted">四项都留空表示未知定价。填写时必须提供全部费率，不会自动把缓存价格当作零。</p><div class="form-grid">${costFields.map(([key, label]) => field(`cost-${key}`, label, p.cost?.[key] ?? '', { type: 'number', step: 'any' })).join('')}</div></details>`;
  dialog(id ? '编辑模型连接' : '添加模型连接', fields, async (data) => {
    const payload = Object.fromEntries(data);
    for (const key of ['contextWindow', 'maxTokens']) payload[key] = Number(payload[key]);
    if (payload.maxTokens > payload.contextWindow) throw new Error('单次输出上限不能超过上下文窗口。');
    for (const key of ['toolCalling', 'vision', 'reasoning']) payload[key] = data.has(key);
    const rates = costFields.map(([key]) => [key, data.get(`cost-${key}`)]);
    if (rates.some(([, value]) => value !== '')) {
      if (rates.some(([, value]) => value === '')) throw new Error('请填写全部四项费率，或全部留空表示未知。');
      payload.cost = Object.fromEntries(rates.map(([key, value]) => [key, Number(value)]));
    }
    for (const [key] of costFields) delete payload[`cost-${key}`];
    if (id) payload.id = id;
    await api('/api/profiles', 'POST', payload);
    toast('模型连接已保存；未静默替换任何模型。');
  });
}

function mcpDialog(id) {
  const server = (state.app.mcpServers || []).find((item) => item.id === id);
  const current = server || { name: '', transport: 'stdio', enabled: false, timeoutMs: 30000, args: [], envRefs: {}, headerRefs: {} };
  const fields = '<div class="notice neutral">保存不会运行程序或连接服务器。启用后还需读取目录、明确授权给角色。启动程序本身也可能有副作用，请只使用可信工具。</div>' +
    field('name', '连接名称', current.name, { required: true }) +
    field('transport', '连接方式', current.transport, { choices: [['stdio', '本地程序（stdio）'], ['http', '远端服务（Streamable HTTP）']] }) +
    field('command', '程序的绝对路径', current.command || '', { required: true, placeholder: '/opt/homebrew/bin/node', help: '直接启动这个程序，不经过 shell。程序参数、路径里不要放密钥。' }) +
    field('args', '启动参数（JSON 数组）', JSON.stringify(current.args || [], null, 2), { multiline: true, placeholder: '["/absolute/path/server.mjs"]' }) +
    field('envRefs', '环境变量引用（JSON 对象）', JSON.stringify(current.envRefs || {}, null, 2), { multiline: true, help: '例如 {"API_KEY":"MY_MCP_KEY"}：把后台的 MY_MCP_KEY 提供给工具的 API_KEY。两边都是变量名，不是密钥。' }) +
    field('url', '服务地址', current.url || '', { required: true, placeholder: 'https://tools.example.com/mcp', help: '必须使用 HTTPS，本机回环地址可用 HTTP。不要在地址中放令牌或查询参数。' }) +
    field('headerRefs', '请求头密钥引用（JSON 对象）', JSON.stringify(current.headerRefs || {}, null, 2), { multiline: true, help: '例如 {"Authorization":{"env":"MY_MCP_KEY","prefix":"Bearer "}}。env 填后台已有的环境变量名称。' }) +
    field('timeoutSeconds', '单次操作超时（1–60 秒）', current.timeoutMs / 1000, { type: 'number', min: 1, required: true }) +
    check('enabled', '启用配置（不自动连接，也不自动授权）', current.enabled);
  dialog(id ? '编辑工具连接' : '添加工具连接', fields, async (data) => {
    const parse = (key) => { try { return JSON.parse(data.get(key) || (key === 'args' ? '[]' : '{}')); } catch { throw new Error(`${key} 不是有效 JSON，请检查引号和逗号。`); } };
    const transport = data.get('transport');
    const payload = { name: data.get('name'), transport, enabled: data.has('enabled'), timeoutMs: Number(data.get('timeoutSeconds')) * 1000,
      ...(server ? { id: server.id, expectedRevision: server.revision } : {}),
      ...(transport === 'stdio' ? { command: data.get('command'), args: parse('args'), envRefs: parse('envRefs') } : { url: data.get('url'), headerRefs: parse('headerRefs') }) };
    await api('/api/mcp-servers', 'POST', payload);
    if (server) mcpCatalogs.delete(server.id);
    toast('配置已保存。工具调用前仍会重新检查授权与定义。');
  });
  const update = () => {
    const local = $('#f-transport').value === 'stdio';
    for (const name of ['command', 'args', 'envRefs', 'url', 'headerRefs']) {
      const visible = ['command', 'args', 'envRefs'].includes(name) === local;
      const input = $(`#f-${name}`);
      input.disabled = !visible;
      input.closest('.field').hidden = !visible;
    }
  };
  $('#f-transport').addEventListener('change', update);
  update();
}

function discoverMcp(id) {
  const server = (state.app.mcpServers || []).find((item) => item.id === id);
  if (!server?.enabled) return toast('连接已停用，请先启用。');
  const localWorkspaces = state.app.workspaces.filter((workspace) => workspace.machineId === 'local');
  if (!localWorkspaces.length) return toast('请先添加一个本地工作区，作为工具程序的工作目录。');
  dialog('读取工具目录', `<p class="text">${e(server.name)}</p><div class="notice">将实际启动本地程序或连接远端服务，只查询目录，不调用目录中的工具。程序启动本身仍可能产生副作用。</div>` + field('workspaceId', '本地工作区', '', { choices: localWorkspaces.map((workspace) => [workspace.id, `${workspace.name} · ${workspace.path}`]) }) + check('trusted', '我信任此程序或服务，并允许此次连接'), async (data) => {
    if (!data.has('trusted')) throw new Error('请先确认你信任此工具连接。');
    const catalog = await api(`/api/mcp-servers/${encodeURIComponent(id)}/discover`, 'POST', { workspaceId: data.get('workspaceId') });
    mcpCatalogs.set(id, { ...catalog, fetchedAt: new Date().toISOString() });
    toast(`已读取 ${catalog.tools.length} 项工具；未自动授权任何角色。`);
  }, '连接并读取');
}

function grantMcp(id) {
  const server = (state.app.mcpServers || []).find((item) => item.id === id);
  const catalog = server && mcpCatalog(server);
  if (!server?.enabled || !catalog?.tools.length) return toast('请先读取当前配置的工具目录。');
  if (!state.app.roles.length) return toast('请先添加角色。');
  dialog('授权一个具体工具', `<p class="text">连接：${e(server.name)}</p>` +
    field('roleId', '授予角色', '', { choices: state.app.roles.map((role) => [role.id, role.name]) }) +
    field('toolName', '具体工具', '', { choices: catalog.tools.map((tool) => [tool.name, tool.name]) }) +
    field('mode', '执行方式', 'approve', { choices: [['approve', '每次执行前请我审批'], ['allow', '允许执行（Mission 要求审批时仍需审批）']] }) +
    '<div class="notice">工具说明是外部数据，不是安全保证。此授权不会改变独立验收要求。配置或工具定义变化会让旧审批失效。</div>' +
    check('acknowledge', '若选择允许执行，我理解它可能在不逐次确认的情况下修改文件或外部系统'), async (data) => {
    if (data.get('mode') === 'allow' && !data.has('acknowledge')) throw new Error('请确认允许执行的风险，或改为每次审批。');
    const role = state.app.roles.find((item) => item.id === data.get('roleId'));
    if (!role) throw new Error('角色已变更，请关闭后重试。');
    const grant = { serverId: id, toolName: data.get('toolName'), mode: data.get('mode') };
    const permissions = (role.mcpPermissions || []).filter((item) => item.serverId !== id || item.toolName !== grant.toolName);
    await api('/api/roles', 'POST', { ...role, mcpPermissions: [...permissions, grant] });
    toast('已保存单项授权；其他工具仍默认拒绝。');
  }, '保存授权');
}

function revokeMcp(encoded) {
  const [roleId, serverId, toolName] = JSON.parse(encoded);
  const role = state.app.roles.find((item) => item.id === roleId);
  if (!role) return toast('角色不存在，请刷新。');
  dialog('撤销工具授权？', `<p class="text">${e(role.name)} · ${e(toolName)}</p><div class="notice">撤销今后的调用权限，不撤销已经发生的外部操作，也不删除审批和回执。角色正在工作时，请先暂停相关 Mission。</div>`, async () => {
    const latest = state.app.roles.find((item) => item.id === roleId);
    if (!latest) throw new Error('角色已变更，请刷新。');
    await api('/api/roles', 'POST', { ...latest, mcpPermissions: (latest.mcpPermissions || []).filter((item) => item.serverId !== serverId || item.toolName !== toolName) });
    toast('授权已撤销，历史证据保留。');
  }, '确认撤销');
}

function disableMcp(id) {
  const server = (state.app.mcpServers || []).find((item) => item.id === id);
  if (!server) return;
  dialog('停用工具连接？', `<p class="text">${e(server.name)}</p><div class="notice">拒绝后续调用，并中止当前连接。已经发出的工具操作不保证能撤回；拿不到确定结果时将保留不确定记录，绝不自动重做。</div>`, async () => {
    const input = { id: server.id, name: server.name, enabled: false, transport: server.transport, timeoutMs: server.timeoutMs, expectedRevision: server.revision,
      ...(server.transport === 'stdio' ? { command: server.command, args: server.args, envRefs: server.envRefs } : { url: server.url, headerRefs: server.headerRefs }) };
    await api('/api/mcp-servers', 'POST', input);
    mcpCatalogs.delete(id);
    toast('连接已停用。历史授权与审批记录仍保留。');
  }, '确认停用');
}

function roleDialog(id) {
  if (!state.app.profiles.length) return toast('请先添加模型连接。');
  const r = state.app.roles.find((item) => item.id === id) || { name: '', kind: 'worker', profileId: state.app.profiles[0].id, instructions: '' };
  dialog(id ? '编辑角色' : '添加角色', field('name', '角色名称', r.name, { required: true }) + field('kind', '职责类型', r.kind, { choices: Object.entries(roleNames) }) + field('profileId', '默认模型', r.profileId, { choices: state.app.profiles.map((p) => [p.id, `${p.name} · ${p.modelId}`]) }) + field('instructions', '职责与要求', r.instructions, { required: true, multiline: true, rows: 5, placeholder: '例如：负责实现；必须运行测试并发布交付物。不验收自己的工作。' }), async (data) => { await api('/api/roles', 'POST', { ...Object.fromEntries(data), ...(id ? { id } : {}) }); toast('角色已保存。'); });
}

function missionDialog() {
  const localWorkspaces = state.app.workspaces.filter((workspace) => workspace.machineId === 'local');
  if (!localWorkspaces.length) { location.hash = '#workspaces'; return toast('先添加一个本地交付工作区，再创建 Mission。'); }
  if (!state.app.roles.some((r) => r.kind === 'orchestrator')) { location.hash = '#roles'; return toast('先配置负责人角色与模型。'); }
  const fields = field('title', 'Mission 名称', '', { required: true, placeholder: '例如：实现可导出的书签管理器' }) +
    field('goal', '需要交付什么？', '', { required: true, multiline: true, rows: 4, placeholder: '描述要做的产品、范围，以及不能改变的约束。' }) +
    field('acceptance', '怎样才算真正完成？', '', { required: true, multiline: true, placeholder: '写明真实用户流程、测试命令和交付文件。' }) +
    field('assertionLines', '另外单列的验收要求（每行一条，可留空）', '', { multiline: true, rows: 3, help: '上面的完整标准始终保留为 REQ-001。这些补充要求也必须被任务认领并独立验证，不能遗漏。' }) +
    field('workspaceId', '本地主交付工作区', localWorkspaces[0].id, { choices: localWorkspaces.map((w) => [w.id, `${w.name} · ${w.path}`]) }) +
    field('workspaceStrategy', '代理如何使用工作目录？', 'worktree', { choices: [['worktree', '独立 Git 工作树（推荐：并行开发互不覆盖）'], ['shared', '共享目录（可用于非 Git 目录，需要协调修改）']], help: '独立模式需要已有提交、没有待提交改动的 Git 仓库根目录。启动后各自使用本地分支，最终必须合并并独立验收；不会切换原目录或推送远端。子模块、LFS 等特殊检出方式目前不支持，检查不通过不会偷偷改成共享模式。' }) +
    `<fieldset class="role-fieldset"><legend>参与角色</legend><div class="role-choices">${state.app.roles.map((r) => `<label class="check"><input type="checkbox" name="roleIds" value="${e(r.id)}" checked>${e(r.name)} · ${e(profileName(r.profileId))}</label>`).join('')}</div></fieldset>` +
    `<div class="form-grid">${field('maxTurns', '最大执行轮次', 60, { type: 'number', min: 1, required: true })}${field('maxCost', '模型费用上限（美元）', 0, { type: 'number', min: 0, step: 'any', required: true, help: '0 表示不设费用上限，仍限制轮次。有费用上限时，所有参与模型必须填写费率。' })}</div>` +
    field('autonomy', '工具权限', 'approve', { choices: [['approve', '逐次审批写入与命令（推荐）'], ['trusted', '可信自主执行（允许本机命令）']], help: '自主执行不是沙箱，只能用于你信任的任务。费用为按配置费率估算，并非供应商账单。' });
  dialog('给团队一个明确的目标', fields, async (data) => {
    const selected = state.app.roles.filter((role) => data.getAll('roleIds').includes(role.id));
    if (selected.filter((role) => role.kind === 'orchestrator').length !== 1) throw new Error('请选择且只选择一个负责人角色。');
    if (!selected.some((role) => role.kind === 'worker') || !selected.some((role) => role.kind === 'validator')) throw new Error('请同时选择执行者和独立验收者，才能完成交付闭环。');
    const payload = Object.fromEntries(data);
    const additional = String(data.get('assertionLines')).split('\n').map((line) => line.trim()).filter(Boolean);
    delete payload.assertionLines;
    const assertions = [String(data.get('acceptance')), ...additional].map((description, index) => ({ id: `REQ-${String(index + 1).padStart(3, '0')}`, description }));
    const mission = await api('/api/missions', 'POST', { ...payload, assertions, roleIds: data.getAll('roleIds'), maxTurns: Number(data.get('maxTurns')), maxCost: Number(data.get('maxCost')) });
    location.hash = `#missions/${mission.id}`;
    toast('Mission 已保存。确认后点击启动。');
  }, '创建 Mission');
}

function messageDialog(agentId) {
  const agents = state.detail.agents;
  const requestId = crypto.randomUUID();
  const missionId = state.missionId;
  if (!agents.length) return toast('请先启动 Mission 或添加代理。');
  dialog('给持久代理发送消息', field('recipientId', '收件人', agentId || state.detail.mission.orchestratorId || agents[0].id, { choices: agents.map((a) => [a.id, `${a.title} · ${statusNames[a.status] || a.status}`]) }) + field('mode', '投递方式', 'followUp', { choices: [['followUp', '下一轮跟进：等当前工作结束'], ['steer', '运行中插话：下一个工具轮次生效']] }) + field('content', '消息内容', '', { required: true, multiline: true, rows: 5 }), async (data) => { await api(`/api/missions/${missionId}/messages`, 'POST', { ...Object.fromEntries(data), requestId }); toast('消息已持久保存；接收不等于完成。'); }, '发送消息');
}

async function action(name, id) {
  const requestId = crypto.randomUUID();
  if (name === 'new-machine') return machineDialog();
  if (['probe-machine', 'view-node-probe', 'node-instructions', 'revoke-machine', 'node-history'].includes(name)) return machineAction(name, id);
  if (name === 'reload') return load(true);
  if (name === 'new-profile' || name === 'edit-profile') return profileDialog(id);
  if (name === 'new-role' || name === 'edit-role') return roleDialog(id);
  if (name === 'new-mcp' || name === 'edit-mcp') return mcpDialog(id);
  if (name === 'discover-mcp') return discoverMcp(id);
  if (name === 'grant-mcp') return grantMcp(id);
  if (name === 'revoke-mcp') return revokeMcp(id);
  if (name === 'disable-mcp') return disableMcp(id);
  if (name === 'new-mission') return missionDialog();
  if (name === 'edit-contract') return contractDialog();
  if (name === 'edit-limits') return limitsDialog();
  if (name === 'configure-watchdog') return watchdogDialog();
  if (name === 'new-schedule') return scheduleDialog();
  if (name === 'edit-schedule') return scheduleDialog(id);
  if (name === 'hold-schedule') return scheduleAction('hold', id);
  if (name === 'resume-schedule') return scheduleAction('resume', id);
  if (name === 'delete-schedule') return scheduleAction('delete', id);
  if (name === 'view-validation') { state.tab = 'artifacts'; render(); return; }
  if (name === 'new-workspace') return dialog('添加工作区', field('name', '工作区名称', '', { required: true }) + field('path', '绝对目录路径', '', { required: true, placeholder: '/Users/you/projects/my-app', help: '目录必须存在；不要选个人主目录或含敏感文件的目录。' }), async (data) => { await api('/api/workspaces', 'POST', { ...Object.fromEntries(data), machineId: 'local' }); toast('工作区已添加。'); });
  if (name === 'message' || name === 'message-agent') return messageDialog(id);
  if (name === 'rename') return dialog('重命名 Mission', field('title', '名称', state.detail.mission.title, { required: true }), async (data) => { await api(`/api/missions/${state.missionId}`, 'PATCH', Object.fromEntries(data)); });
  if (name === 'spawn-agent') return dialog('添加持久代理', field('title', '代理名称', '', { required: true }) + field('roleId', '角色', '', { choices: state.app.roles.filter((r) => r.kind !== 'orchestrator' && state.detail.mission.roleIds.includes(r.id)).map((r) => [r.id, `${r.name} · ${profileName(r.profileId)}`]) }) + field('prompt', '第一条工作指令', '', { required: true, multiline: true, rows: 5, help: '代理不会继承负责人的完整对话，请提供必要上下文。' }), async (data) => { await api(`/api/missions/${state.missionId}/agents`, 'POST', { ...Object.fromEntries(data), requestId }); toast('代理已创建，首条消息进入持久队列。'); }, '创建代理');
  if (name === 'agent-profile') {
    const agent = state.detail.agents.find((a) => a.id === id);
    return dialog('切换代理模型', `<div class="notice">仅在代理空闲、未完成工具已处理后切换。不会迁移一个执行到一半的请求。</div>` + field('profileId', '模型连接', agent.profileId, { choices: state.app.profiles.map((p) => [p.id, `${p.name} · ${p.modelId}`]) }), async (data) => { await api(`/api/agents/${id}`, 'PATCH', Object.fromEntries(data)); toast('模型切换已保存。'); });
  }
  if (name === 'transcript') {
    const { entries } = await api(`/api/agents/${id}/transcript`);
    return dialog(`${agentName(id)} · 持久对话`, `<div class="modal-transcript">${entries.length ? entries.map((entry) => `<article class="message"><div class="message-head"><b>${e(entry.role)}</b><small>${date(entry.createdAt)}</small></div><pre>${e(entry.text)}</pre></article>`).join('') : '<p class="text">还没有对话记录。</p>'}</div>`, null);
  }
  if (name === 'approve' || name === 'deny') { await api(`/api/approvals/${id}`, 'POST', { decision: name === 'approve' ? 'approved' : 'denied' }); toast(name === 'approve' ? '仅本次操作已批准。' : '操作已拒绝。'); return load(true); }
  if (name === 'resolve-blocker') {
    const blocker = state.detail.blockers.find((item) => item.id === id);
    return dialog(blocker.kind === 'user_input' ? '回答团队' : '记录处理结果', `<p class="text">${e(blocker.text)}</p>` + field('resolution', '你的回答或已核对的处置结果', '', { required: true, multiline: true, rows: 5, help: blocker.kind === 'unsafe_execution' ? '请写明外部操作是否已完成、如何核实，以及是否允许新的执行尝试。不要直接假定原操作没有发生。' : '内容会写入持久事件记录。暂停状态下不会自动继续派工。' }), async (data) => {
      await api(`/api/blockers/${encodeURIComponent(id)}/resolve`, 'POST', { resolution: data.get('resolution') });
      toast('处理结果已保存。');
    }, '保存回答');
  }
  if (name === 'interrupt-agent') { await api(`/api/agents/${id}/interrupt`, 'POST', {}); toast('中断请求已提交，代理身份与历史保留。'); return load(true); }
  if (['start', 'pause', 'resume', 'cancel'].includes(name)) {
    if (name === 'cancel') return dialog('取消这个 Mission？', '<p class="text">停止继续派工，保留任务、对话、失败与交付证据。取消不等于撤销已经发生的外部操作。</p>', async () => { await api(`/api/missions/${state.missionId}/cancel`, 'POST', {}); toast('Mission 已取消。'); }, '确认取消');
    await api(`/api/missions/${state.missionId}/${name}`, 'POST', {});
    toast({ start: 'Mission 已启动，后台开始工作。', pause: '暂停请求已保存，正在停止派工。', resume: '已请求继续，后台会重新校验运行条件。' }[name]);
    return load(true);
  }
}

$('#main').addEventListener('click', async (event) => {
  const tab = event.target.closest('[data-tab]');
  if (tab) { state.tab = tab.dataset.tab; render(); return; }
  const filter = event.target.closest('[data-filter]');
  if (filter) { state.filter = filter.dataset.filter; render(); return; }
  const target = event.target.closest('[data-action]');
  if (!target || state.busy) return;
  state.busy = true;
  target.disabled = true;
  try { await action(target.dataset.action, target.dataset.id); } catch (error) { toast(error.message); }
  finally { state.busy = false; target.disabled = false; }
});
$('#main').addEventListener('input', (event) => { if (event.target.id === 'mission-search') { state.query = event.target.value; render(); } });

function route() {
  const [section, missionId] = location.hash.slice(1).split('/');
  state.section = navItems.some(([key]) => key === section) ? section : 'missions';
  state.missionId = state.section === 'missions' && missionId ? missionId : null;
  state.detail = null;
  state.tab = 'overview';
  routeVersion += 1;
  void load(true);
}
window.addEventListener('hashchange', route);
window.addEventListener('focus', () => { void load(); });
route();
setInterval(() => { if (!document.hidden && !state.busy) void load(); }, 3000);
