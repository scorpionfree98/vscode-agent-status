'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');

const script = path.resolve(__dirname, '../scripts/agent-status-hook.py');
const python = process.env.PYTHON || 'python3';

function invoke(directory, source, payload) {
  const result = spawnSync(python, [script, '--source', source], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENT_STATUS_DIR: directory,
      AGENT_STATUS_DRY_RUN: '1',
      VSCODE_IPC_HOOK_CLI: '/tmp/vscode-test.sock',
    },
  });
  assert.equal(result.status, 0, result.stderr);
}

function readOnlyState(directory) {
  const names = fs.readdirSync(directory).filter((name) => name.endsWith('.json'));
  assert.equal(names.length, 1);
  return JSON.parse(fs.readFileSync(path.join(directory, names[0]), 'utf8'));
}

test('hook executable preserves task metadata across a full Codex turn', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-hook-e2e-'));
  try {
    const common = { session_id: 'e2e-session', cwd: '/work/repo' };
    invoke(directory, 'codex', {
      ...common,
      hook_event_name: 'UserPromptSubmit',
      prompt: '严格测试 VS Code 状态插件',
      transcript_path: '/tmp/rollout.jsonl',
    });
    let state = readOnlyState(directory);
    assert.equal(state.status, 'running');
    assert.equal(state.unread, false);
    assert.equal(state.task, '严格测试 VS Code 状态插件');
    assert.equal(state.transcriptPath, '/tmp/rollout.jsonl');
    assert.equal(state.ideContextId, '/tmp/vscode-test.sock');

    invoke(directory, 'codex', {
      ...common,
      hook_event_name: 'PermissionRequest',
      tool_input: { description: '允许执行构建' },
    });
    state = readOnlyState(directory);
    assert.equal(state.status, 'waiting_permission');
    assert.equal(state.unread, true);
    assert.equal(state.task, '严格测试 VS Code 状态插件');
    assert.equal(state.detail, '允许执行构建');
    assert.equal(state.transcriptPath, '/tmp/rollout.jsonl');

    invoke(directory, 'codex', {
      ...common,
      hook_event_name: 'Stop',
      last_assistant_message: '测试完成',
    });
    state = readOnlyState(directory);
    assert.equal(state.status, 'completed');
    assert.equal(state.unread, true);
    assert.equal(state.detail, '测试完成');
    assert.equal(state.lastEvent, 'Stop');
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});
