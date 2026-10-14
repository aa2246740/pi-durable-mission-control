import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const warning = '需要人工核对远端进程与未结清的工作，系统不会自动重放';

function fixture() {
  const elements = new Map();
  const context = {
    document: {
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, {
          dataset: {}, classList: { add() {}, remove() {} },
          addEventListener() {}, querySelectorAll() { return []; }
        });
        return elements.get(selector);
      }
    },
    window: { addEventListener() {} }, location: { hash: '' },
    fetch: () => new Promise(() => {}), setInterval() {}, setTimeout() {}, clearTimeout() {}
  };
  runInNewContext(source + `\n globalThis.ui = {
    state, renderDetail, renderRemoteRuntimes, timeline, load, renderMessages, api, toast,
    setApi: (handler) => { api = handler; loading = false; },
    invalidateRoute: () => { routeVersion += 1; state.missionId = null; }
  };`, context);
  const { ui } = context;
  ui.state.app = { missions: [], machines: [{ id: 'linux', name: 'Linux <远端>' }],
    workspaces: [{ id: 'workspace', name: '工作区' }], profiles: [] };
  ui.state.missionId = 'runtime-mission';
  ui.state.detail = {
    mission: { id: 'runtime-mission', title: '远端任务', goal: '实现目标', acceptance: '独立验收',
      status: 'failed', workspaceId: 'workspace', workspaceStrategy: 'shared', turns: 0, maxTurns: 60 },
    agents: [{ id: 'worker', title: '执行者 <甲>', kind: 'worker', epoch: 3 }],
    tasks: [], events: [], approvals: [], blockers: []
  };
  return { ui, elements, context };
}

function runtime(overrides = {}) {
  return {
    binding: { agentId: 'worker', machineId: 'linux', runtimeId: 'abcd1234-long-runtime', epoch: 3 },
    state: 'closed', desired: 'stop', stopProvenance: 'controlled', report: { outcome: 'stopped' },
    createdAt: '2026-10-14T01:00:00Z', updatedAt: '2026-10-14T02:00:00Z', ...overrides
  };
}

test('mission detail hides remote runtimes when absent or empty', () => {
  const { ui } = fixture();
  assert.doesNotMatch(ui.renderDetail(), /远端运行时/);
  ui.state.detail.runtimes = [];
  assert.doesNotMatch(ui.renderDetail(), /远端运行时/);
});

test('mission detail renders remote binding, statuses, outcome and timestamps', () => {
  const { ui } = fixture();
  ui.state.detail.runtimes = [runtime()];
  const html = ui.renderDetail();
  for (const text of ['远端运行时', '执行者 &lt;甲&gt;', '机器：Linux &lt;远端&gt;',
    'title="abcd1234-long-runtime">abcd1234', '执行代次（epoch）：3',
    '状态：<span class="badge closed">已关闭', '期望状态：<span class="badge stop">停止',
    '停止来源：<span class="badge controlled">受控停止',
    '最后报告结果：<span class="badge stopped">已停止', '创建时间：', '更新时间：']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /创建时间：—|更新时间：—/);
  assert.ok(!html.includes(warning));
});

for (const stopProvenance of ['unexpected', 'uncertain']) {
  test(`${stopProvenance} stop renders an attention card and manual reconciliation warning`, () => {
    const { ui } = fixture();
    ui.state.detail.runtimes = [runtime({ stopProvenance })];
    const html = ui.renderRemoteRuntimes();
    assert.match(html, /class="agent-card error-panel"/);
    assert.ok(html.includes(`class="badge ${stopProvenance}"`));
    assert.ok(html.includes(stopProvenance === 'unexpected' ? '意外停止' : '状态不确定'));
    assert.ok(html.includes(warning));
  });
}

test('runtime display escapes all external fields and falls back to binding IDs', () => {
  const { ui } = fixture();
  const unsafe = '<img src=x onerror="boom">&\'';
  ui.state.detail.runtimes = [runtime({ binding: {
    agentId: unsafe, machineId: unsafe, runtimeId: unsafe, epoch: unsafe
  }, state: unsafe, desired: unsafe, stopProvenance: unsafe, report: { outcome: unsafe } })];
  const html = ui.renderRemoteRuntimes();
  assert.ok(!html.includes(unsafe));
  assert.doesNotMatch(html, /<img|onerror="boom"/);
  assert.ok(html.includes('&lt;img src=x onerror=&quot;boom&quot;&gt;&amp;&#39;'));
  ui.state.detail.runtimes = [runtime({ report: undefined, stopProvenance: 'unproven', state: 'offered', desired: 'run' })];
  const noReport = ui.renderRemoteRuntimes();
  for (const text of ['尚无报告', '尚未证实', '已下发', '>运行<']) assert.ok(noReport.includes(text));
  assert.ok(!noReport.includes(warning));
});

test('failed mission shows latest worker-start diagnostic escaped at the top', () => {
  const { ui } = fixture();
  ui.state.detail.events = [
    { type: 'worker_start_failed', text: '旧错误', data: { diagnostic: 'old diagnostic' } },
    { type: 'worker_start_failed', text: '新错误', data: { diagnostic: 'unexpected stop <script>"&\'' } },
    { type: 'other', text: '其他活动', data: { diagnostic: 'unrelated' } }
  ];
  const html = ui.renderDetail();
  assert.ok(html.indexOf('恢复诊断') < html.indexOf('class="stats"'));
  assert.ok(html.includes('unexpected stop &lt;script&gt;&quot;&amp;&#39;'));
  assert.ok(html.includes('修复原因后可再次恢复'));
  assert.doesNotMatch(html, /<script>|old diagnostic|unrelated/);
});

const unrecoverableExplanation = '这是远端运行时的意外或无法证明的停止。当前版本不支持可信对账，此 Mission 无法继续。请先核对远端工作区和未结清的工作，再新建 Mission。系统不会重放任何工作。';

for (const reason of ['remote_runtime_unexpected_stop', 'remote_runtime_uncertain', 'remote_runtime_unproven', 'remote_runtime_rejected']) {
  test(`${reason} explains permanent failure and disables resume accessibly`, () => {
    const { ui } = fixture();
    ui.state.detail.events = [
      { type: 'worker_start_failed', data: { diagnostic: 'old', recoverable: true } },
      { type: 'worker_start_failed', data: { diagnostic: '<script>"&\'', recoverable: false, reason } },
      { type: 'other', data: { recoverable: true } }
    ];
    const html = ui.renderDetail();
    const resume = html.match(/<button[^>]*data-action="resume"[^>]*>/)?.[0];
    assert.ok(resume);
    assert.match(resume, / disabled /);
    assert.match(resume, /aria-disabled="true"/);
    assert.match(resume, /aria-describedby="recovery-diagnostic"/);
    assert.ok(resume.includes(`title="${unrecoverableExplanation}"`));
    assert.ok(html.includes(`&lt;script&gt;&quot;&amp;&#39;</p>${unrecoverableExplanation}`));
    assert.match(html, /id="recovery-diagnostic"/);
    assert.doesNotMatch(html, /<script>|修复原因后可再次恢复/);
  });
}

for (const recoverable of [true, undefined, 'false']) {
  test(`latest failure with recoverable=${recoverable} keeps resume enabled and overrides older permanent failure`, () => {
    const { ui } = fixture();
    ui.state.detail.events = [
      { type: 'worker_start_failed', data: { diagnostic: 'old', recoverable: false } },
      { type: 'worker_start_failed', data: { diagnostic: 'timeout <img>"&\'', recoverable } }
    ];
    const html = ui.renderDetail();
    assert.ok(html.includes('修复原因后可再次恢复'));
    assert.ok(html.includes('timeout &lt;img&gt;&quot;&amp;&#39;'));
    assert.doesNotMatch(html, /<img>|此 Mission 无法继续/);
    const resume = html.match(/<button[^>]*data-action="resume"[^>]*>/)?.[0];
    assert.ok(resume);
    assert.doesNotMatch(resume, /disabled|aria-describedby|title=/);
  });
}

test('permanent failure without diagnostic still explains the disabled resume button', () => {
  const { ui } = fixture();
  ui.state.detail.events = [{ type: 'worker_start_failed', data: { recoverable: false, reason: '<img>"&\'' } }];
  const html = ui.renderDetail();
  assert.ok(html.includes(unrecoverableExplanation));
  assert.match(html, /id="recovery-diagnostic"/);
  assert.match(html, /data-action="resume" disabled aria-disabled="true"/);
  assert.doesNotMatch(html, /<img>|修复原因后可再次恢复/);
});

test('latest failure without diagnostic does not reuse an older diagnostic', () => {
  const { ui } = fixture();
  ui.state.detail.events = [
    { type: 'worker_start_failed', data: { diagnostic: 'stale' } },
    { type: 'worker_start_failed', text: '当前错误' }
  ];
  assert.doesNotMatch(ui.renderDetail(), /恢复诊断|修复原因后可再次恢复|stale/);
});

test('non-failed missions do not show a recovery diagnostic', () => {
  const { ui } = fixture();
  ui.state.detail.events = [{ type: 'worker_start_failed', data: { diagnostic: 'unexpected stop', recoverable: false } }];
  for (const status of ['active', 'paused', 'completed']) {
    ui.state.detail.mission.status = status;
    assert.doesNotMatch(ui.renderDetail(), /恢复诊断|修复原因后可再次恢复|aria-disabled="true"|此 Mission 无法继续/);
  }
});

test('reassigned timeline describes old and new runtime IDs in Chinese and escapes them', () => {
  const { ui } = fixture();
  const html = ui.timeline([{ seq: 1, type: 'remote_runtime_reassigned', text: 'English server text',
    data: { previousRuntimeId: 'old-1234-more', runtimeId: 'new-5678-more' } }]);
  assert.match(html, /受控停止后已重新分配远端运行时：旧 old-1234 → 新 new-5678/);
  assert.doesNotMatch(html, /English server text|-more/);
  const escaped = ui.timeline([{ type: 'remote_runtime_reassigned', data: { previousRuntimeId: '<old>"&', runtimeId: '<new>\'' } }]);
  assert.ok(escaped.includes('&lt;old&gt;&quot;&amp;'));
  assert.ok(escaped.includes('&lt;new&gt;&#39;'));
  assert.match(ui.timeline([{ type: 'other', text: '<ordinary>' }]), /&lt;ordinary&gt;/);
});

test('load refreshes runtimes and runtime-only changes repaint the detail', async () => {
  const { ui, elements } = fixture();
  const app = ui.state.app;
  const detail = ui.state.detail;
  const calls = [];
  let runtimes = [runtime()];
  ui.setApi(async (path) => {
    calls.push(path);
    if (path === '/api/state') return app;
    if (path.endsWith('/runtimes')) return runtimes;
    return { ...detail };
  });
  await ui.load(true);
  assert.deepEqual(calls, ['/api/state', '/api/missions/runtime-mission', '/api/missions/runtime-mission/runtimes']);
  assert.equal(elements.get('#connection').textContent, '后台已连接');
  assert.ok(!elements.get('#main').innerHTML.includes(warning));
  runtimes = [runtime({ stopProvenance: 'unexpected' })];
  await ui.load();
  assert.ok(elements.get('#main').innerHTML.includes(warning));
});

test('runtime request failure preserves mission rendering and retries on the next refresh', async () => {
  const { ui, elements } = fixture();
  const app = ui.state.app;
  const detail = ui.state.detail;
  let fail = true;
  ui.setApi(async (path) => {
    if (path === '/api/state') return app;
    if (path.endsWith('/runtimes')) {
      if (fail) throw new Error('runtime unavailable');
      return [runtime()];
    }
    return { ...detail };
  });
  await ui.load(true);
  assert.equal(elements.get('#connection').textContent, '后台已连接');
  assert.match(elements.get('#main').innerHTML, /远端任务/);
  assert.doesNotMatch(elements.get('#main').innerHTML, /无法读取当前状态|远端运行时/);
  fail = false;
  await ui.load();
  assert.match(elements.get('#main').innerHTML, /远端运行时/);
});

test('load does not request remote runtimes on the mission list', async () => {
  const { ui } = fixture();
  ui.state.missionId = null;
  const calls = [];
  ui.setApi(async (path) => { calls.push(path); return ui.state.app; });
  await ui.load(true);
  assert.deepEqual(calls, ['/api/state']);
  assert.equal(ui.state.detail, null);
});

test('a late runtime response cannot replace detail after navigation', async () => {
  const { ui } = fixture();
  const app = ui.state.app;
  const detail = ui.state.detail;
  let release;
  let requested;
  const runtimeRequested = new Promise((resolve) => { requested = resolve; });
  ui.setApi(async (path) => {
    if (path === '/api/state') return app;
    if (path.endsWith('/runtimes')) {
      requested();
      return new Promise((resolve) => { release = resolve; });
    }
    return { ...detail };
  });
  const loading = ui.load(true);
  await runtimeRequested;
  ui.invalidateRoute();
  ui.state.detail = null;
  release([runtime()]);
  await loading;
  assert.equal(ui.state.detail, null);
});

for (const [type, text] of [
  ['coordinator_stopping', 'Mission 已暂停，等待远端运行时确认停止'],
  ['coordinator_stop_waiting', 'Mission 保持原状态'],
  ['coordinator_stop_unconfirmed', '恢复已被禁止，请核对旧进程'],
  ['coordinator_resume_queued', '代理将读取持久历史继续待办，不会重放旧操作'],
  ['local_worker_exit_confirmed', '仍需点击“继续执行”显式恢复']
]) {
  test(`${type} renders a Chinese explanation instead of server text`, () => {
    const { ui } = fixture();
    const html = ui.timeline([{ type, text: 'English server text', data: { runtimeId: '<old>"&' } }]);
    assert.ok(html.includes(text));
    assert.doesNotMatch(html, /English server text|<old>/);
    if (type === 'coordinator_stop_unconfirmed') assert.ok(html.includes('&lt;old&gt;&quot;&amp;'));
  });
}

test('coordinator recovery messages identify the system sender and escape durable content', () => {
  const { ui } = fixture();
  ui.state.detail.messages = [{ senderId: 'system:coordinator', recipientId: 'worker',
    content: '<script>history</script>', status: 'queued', mode: 'followUp', attempt: 1 }];
  const html = ui.renderMessages();
  assert.match(html, /<b>协调端恢复通知<\/b>/);
  assert.match(html, /&lt;script&gt;history&lt;\/script&gt;/);
  assert.match(html, /排队中/);
  assert.doesNotMatch(html, /<script>|system:coordinator/);
});

for (const status of ['paused', 'blocked', 'failed']) {
  test(`${status} local worker stop hold disables resume even after blocker resolution`, () => {
    const { ui } = fixture();
    ui.state.detail.mission.status = status;
    ui.state.detail.mission.localWorkerStops = [{ agentId: '<old>"&', epoch: '<epoch>', exit: 'unconfirmed' }];
    ui.state.detail.blockers = [{ id: 'worker-stop:old:1', kind: 'unsafe_execution', status: 'resolved', text: 'old blocker' }];
    const html = ui.renderDetail();
    assert.match(html, /data-action="resume" disabled aria-disabled="true" aria-describedby="local-worker-stop-diagnostic"/);
    assert.match(html, /需确认旧进程已退出后再显式恢复/);
    assert.match(html, /退出尚未确认，继续执行已禁用/);
    assert.ok(html.includes('&lt;old&gt;&quot;&amp;'));
    assert.ok(html.includes('&lt;epoch&gt;'));
    assert.doesNotMatch(html, /<old>|<epoch>|old blocker/);
    ui.state.detail.mission.localWorkerStops[0].exit = 'confirmed';
    const confirmed = ui.renderDetail();
    assert.match(confirmed, /已确认退出，可处理阻塞后显式恢复/);
    assert.doesNotMatch(confirmed.match(/<button[^>]*data-action="resume"[^>]*>/)[0], /disabled/);
    ui.state.detail.mission.localWorkerStops = [];
    assert.doesNotMatch(ui.renderDetail(), /本地进程停止门禁|需确认旧进程/);
  });
}

test('open local stop blocker has a Chinese explanation and preserves its resolution action', () => {
  const { ui } = fixture();
  ui.state.detail.blockers = [{ id: 'worker-stop:<old>:1', kind: 'unsafe_execution', status: 'open', text: 'Local worker exit was not confirmed' }];
  const html = ui.renderDetail();
  assert.match(html, /本地进程退出未确认。请先核对旧进程，再记录处理结果；排队输入尚未发送/);
  assert.match(html, /data-action="resolve-blocker" data-id="worker-stop:&lt;old&gt;:1"/);
  assert.doesNotMatch(html, /Local worker exit was not confirmed|<old>/);
});

for (const status of ['completed', 'cancelled']) {
  test(`${status} uncertain delivery is history without recovery controls or new blockers`, () => {
    const { ui } = fixture();
    ui.state.detail.mission.status = status;
    ui.state.detail.mission.localWorkerStops = [{ agentId: 'worker', epoch: 1, exit: 'unconfirmed' }];
    ui.state.detail.events = [{ type: 'delivery_uncertain', data: { messageId: '<message>"&' } }];
    const html = ui.renderDetail();
    assert.match(html, /Mission 已结束，此记录仅保留历史证据，不新增待处理问题，也不会重放消息/);
    assert.ok(html.includes('&lt;message&gt;&quot;&amp;'));
    assert.doesNotMatch(html, /data-action="resume"|data-action="resolve-blocker"|恢复诊断|本地进程停止门禁|<message>/);
  });
}

test('active uncertain delivery asks for reconciliation and does not call it terminal history', () => {
  const { ui } = fixture();
  ui.state.detail.mission.status = 'active';
  const html = ui.timeline([{ type: 'delivery_uncertain', data: { messageId: 'message-1' } }]);
  assert.match(html, /消息 message-1 的投递结果不确定/);
  assert.match(html, /处理对应阻塞后再继续/);
  assert.doesNotMatch(html, /Mission 已结束|仅保留历史证据/);
});

test('unexpected runtime stop report explains session reconnection without claiming a specific cause', () => {
  const { ui } = fixture();
  ui.state.detail.runtimes = [runtime({ stopProvenance: 'unexpected', report: { outcome: 'stopped', stopReason: 'unexpected' } })];
  const html = ui.renderRemoteRuntimes();
  assert.match(html, /报告停止原因：意外停止（包括节点会话失效后重连）/);
  assert.ok(html.includes(warning));
  ui.state.detail.runtimes[0].report.stopReason = '<reason>"&';
  const escaped = ui.renderRemoteRuntimes();
  assert.ok(escaped.includes('&lt;reason&gt;&quot;&amp;'));
  assert.doesNotMatch(escaped, /<reason>/);
  ui.state.detail.runtimes[0].report.stopReason = 'requested';
  assert.match(ui.renderRemoteRuntimes(), /报告停止原因：响应停止请求/);
});

for (const [error, expected] of [
  ['Workspace operations must finish before mission completion', '仍有工作区操作、shell 命令或验证在执行'],
  ['Local worker exit is not confirmed; explicit resume is refused and answers remain held. A coordinator restart cannot confirm an old process exit.', '无法继续执行：旧本地进程退出尚未确认'],
  ['Resolve mission blockers before resuming', '无法继续执行：请先处理所有未解决的阻塞']
]) {
  test(`API rejection translates ${error} and retains escaped contextual details`, async () => {
    const { ui, context, elements } = fixture();
    context.fetch = async () => ({ ok: false, text: async () => JSON.stringify({ error: error + ' <detail>"&' }) });
    await assert.rejects(ui.api('/api/missions/runtime-mission/resume', 'POST', {}), (failure) => {
      assert.ok(failure.message.includes(expected));
      assert.ok(failure.message.includes('<detail>"&'));
      ui.toast(failure.message);
      assert.equal(elements.get('#toast').textContent, failure.message);
      return true;
    });
    const html = ui.timeline([{ type: 'worker_failed', text: error + ' <detail>"&' }]);
    assert.ok(html.includes(expected));
    assert.ok(html.includes('&lt;detail&gt;&quot;&amp;'));
    assert.ok(!html.includes(error));
    assert.doesNotMatch(html, /<detail>/);
  });
}

for (const status of ['paused', 'blocked']) {
  test(`${status} without a local stop hold keeps ordinary resume available`, () => {
    const { ui } = fixture();
    ui.state.detail.mission.status = status;
    ui.state.detail.blockers = [{ id: 'question', kind: 'user_input', status: 'resolved', text: 'answered' }];
    const html = ui.renderDetail();
    assert.doesNotMatch(html.match(/<button[^>]*data-action="resume"[^>]*>/)[0], /disabled|aria-describedby/);
    assert.doesNotMatch(html, /本地进程停止门禁/);
  });
}

test('confirmed local exits do not hide a permanent remote failure or enable resume', () => {
  const { ui } = fixture();
  ui.state.detail.mission.localWorkerStops = [{ agentId: 'worker', epoch: 1, exit: 'confirmed' }];
  ui.state.detail.events = [{ type: 'worker_start_failed', data: { recoverable: false, diagnostic: '<remote>' } }];
  const html = ui.renderDetail();
  assert.match(html, /本地进程停止门禁/);
  assert.match(html, /id="recovery-diagnostic"/);
  assert.ok(html.includes(unrecoverableExplanation));
  assert.match(html, /data-action="resume" disabled aria-disabled="true" aria-describedby="recovery-diagnostic"/);
  assert.match(html, /&lt;remote&gt;/);
});
