'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { scanIdeContexts } = require('../src/ide-context');

async function fakeProcess(root, pid, parentPid, command, environment = {}) {
  const directory = path.join(root, String(pid));
  await fs.promises.mkdir(directory);
  await Promise.all([
    fs.promises.writeFile(path.join(directory, 'cmdline'), command.split(' ').join('\0')),
    fs.promises.writeFile(path.join(directory, 'stat'), `${pid} (command with spaces) S ${parentPid} 0 0 0`),
    fs.promises.writeFile(
      path.join(directory, 'environ'),
      Object.entries(environment).map(([key, value]) => `${key}=${value}`).join('\0'),
    ),
  ]);
}

test('process scan separates this VS Code host from other live IDE contexts', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-proc-test-'));
  try {
    await fakeProcess(root, 10, 100, '/extension/codex app-server', {
      VSCODE_IPC_HOOK_CLI: '/tmp/this-window.sock',
    });
    await fakeProcess(root, 20, 200, '/extension/codex app-server', {
      VSCODE_IPC_HOOK_CLI: '/tmp/other-window.sock',
    });
    await fakeProcess(root, 30, 100, '/usr/bin/unrelated server', {
      VSCODE_IPC_HOOK_CLI: '/tmp/not-codex.sock',
    });
    const disappearing = path.join(root, '40');
    await fs.promises.mkdir(disappearing);

    const result = await scanIdeContexts(root, 100);

    assert.deepEqual([...result.owned], ['/tmp/this-window.sock']);
    assert.deepEqual([...result.live].sort(), ['/tmp/other-window.sock', '/tmp/this-window.sock']);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
