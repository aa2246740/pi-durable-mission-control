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
    state, renderDetail, renderRemoteRuntimes, timeline, load,
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
  return { ui, elements };
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
