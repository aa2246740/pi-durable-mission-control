import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function fixture() {
  const elements = new Map();
  const context = {
    document: {
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, {
          dataset: {}, classList: { add() {}, remove() {} },
          addEventListener() {}, showModal() { this.open = true; }
        });
        return elements.get(selector);
      }
    },
    window: { addEventListener() {} }, location: { hash: '' },
    fetch: () => new Promise(() => {}), setInterval() {}, setTimeout() {}, clearTimeout() {}
  };
  runInNewContext(source + `\n globalThis.ui = {
    state, missionDialog, worktreeCommit, remoteWorkspaceStatus,
    submit: (data) => submitHandler(data), setApi: (handler) => { api = handler; }
  };`, context);
  const { ui } = context;
  ui.state.app = {
    workspaces: [
      { id: 'local', name: 'Local', machineId: 'local', path: '/local' },
      { id: 'remote-one', name: '<Remote>', machineId: 'linux', path: '/remote/one', probe: {} },
      { id: 'remote-two', name: 'Other', machineId: 'linux', path: '/remote/two', probe: {} },
      { id: 'unverified', name: 'Not probed', machineId: 'linux', path: '/unverified' }
    ],
    machines: [{ id: 'linux', name: 'Linux', status: 'online', leaseExpiresAt: Date.now() + 60000,
      capabilities: { executionEnabled: true, executionMode: 'workspace-effects', artifactTransfers: true } }],
    profiles: [{ id: 'profile', name: 'Test model' }],
    roles: ['orchestrator', 'worker', 'validator'].map((kind) => ({ id: kind, name: kind, kind, profileId: 'profile' }))
  };
  const calls = [];
  ui.setApi(async (...args) => { calls.push(args); return { id: 'created' }; });
  ui.missionDialog();
  const form = new FormData();
  for (const [key, value] of Object.entries({ title: 'Mission', goal: 'Goal', acceptance: 'Acceptance',
    assertionLines: '', workspaceId: 'local', workspaceStrategy: 'shared', maxTurns: '60', maxCost: '0', autonomy: 'approve' })) form.set(key, value);
  for (const role of ['orchestrator', 'worker', 'validator']) form.append('roleIds', role);
  return { ui, elements, calls, form };
}

test('remote workspace selection is explicit, escaped and serialized as an array', async () => {
  const { ui, elements, calls, form } = fixture();
  const html = elements.get('#form-fields').innerHTML;
  assert.match(html, /&lt;Remote&gt;/);
  const inputs = html.match(/<input[^>]*name="remoteWorkspaceIds"[^>]*>/g);
  assert.equal(inputs.length, 2);
  assert.ok(inputs.every((input) => !input.includes('checked')));
  assert.ok(inputs.every((input) => !input.includes('unverified') && !input.includes('value="local"')));
  form.append('remoteWorkspaceIds', 'remote-one');
  form.append('remoteWorkspaceIds', 'remote-two');
  await ui.submit(form);
  assert.equal(calls[0][0], '/api/missions');
  assert.deepEqual(Array.from(calls[0][2].remoteWorkspaceIds), ['remote-one', 'remote-two']);
  assert.equal(calls[0][2].workspaceId, 'local');
});

test('worktree plus remote selection fails without changing selection or posting', async () => {
  const { ui, calls, form } = fixture();
  form.set('workspaceStrategy', 'worktree');
  form.append('remoteWorkspaceIds', 'remote-one');
  await assert.rejects(ui.submit(form), /远端工作区暂不支持独立 Git 工作树/);
  assert.equal(calls.length, 0);
  assert.deepEqual(form.getAll('remoteWorkspaceIds'), ['remote-one']);
  form.delete('remoteWorkspaceIds');
  await ui.submit(form);
  assert.deepEqual(Array.from(calls[0][2].remoteWorkspaceIds), []);
  assert.equal(calls[0][2].workspaceStrategy, 'worktree');
});

test('remote snapshot receipt displays integrity without a Git commit', () => {
  const { ui } = fixture();
  assert.equal(ui.worktreeCommit({ workspaceKind: 'shared' }), '');
  const html = ui.worktreeCommit({ workspaceKind: 'remote-snapshot', workspacePath: '/validation/<snapshot>', snapshotIntegrity: true });
  assert.match(html, /远端冻结成果/);
  assert.match(html, /已检查，输入未被改写/);
  assert.match(html, /&lt;snapshot&gt;/);
  assert.match(ui.worktreeCommit({ workspaceKind: 'remote-snapshot', snapshotIntegrity: false, snapshotError: '<changed>' }), /&lt;changed&gt;/);
  const machine = ui.state.app.machines[0];
  assert.match(ui.remoteWorkspaceStatus(ui.state.app.workspaces[1]), /成果传回/);
  machine.leaseExpiresAt = 0;
  assert.match(ui.remoteWorkspaceStatus(ui.state.app.workspaces[1]), /未在线/);
});
