'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { NONBLOCKING_TTY_FLAGS, TerminalManager } = require('../src/terminal-manager');

function fakeFs(links = new Map()) {
  const writes = [];
  return {
    writes,
    promises: {
      readlink: async (target) => {
        if (!links.has(target)) {
          const error = new Error('missing');
          error.code = 'ENOENT';
          throw error;
        }
        return links.get(target);
      },
      open: async (target, mode) => ({
        write: async (text) => writes.push({ target, mode, text }),
        close: async () => {},
      }),
    },
  };
}

test('maps only exact live VS Code terminals to safe TTY paths', async () => {
  const terminalA = { processId: Promise.resolve(101) };
  const terminalB = { processId: Promise.resolve(102) };
  const files = fakeFs(new Map([
    ['/proc/101/fd/0', '/dev/pts/41'],
    ['/proc/102/fd/0', '/tmp/not-a-tty'],
  ]));
  const manager = new TerminalManager({ window: { terminals: [terminalA, terminalB] } }, files);
  const bindings = await manager.refreshBindings();
  assert.equal(bindings.get('/dev/pts/41'), terminalA);
  assert.equal(bindings.size, 1);
  assert.deepEqual(manager.annotate([
    { terminalTty: '/dev/pts/41' },
    { terminalTty: '/dev/pts/99' },
    {},
  ]).map((state) => state.terminalAlive), [true, false, undefined]);
});

test('renames the correct background TTY without showing a terminal', async () => {
  let shown = 0;
  const terminal = { processId: Promise.resolve(201), show: () => { shown += 1; } };
  const files = fakeFs(new Map([['/proc/201/fd/0', '/dev/pts/51']]));
  const manager = new TerminalManager({ window: { terminals: [terminal] } }, files);
  await manager.refreshBindings();
  const state = {
    terminalTty: '/dev/pts/51', terminalAlive: true, updatedAt: '2026-01-01T00:00:00Z',
  };
  await manager.syncTitles([state], () => 'Codex｜测试｜运行中');
  await manager.syncTitles([state], () => 'Codex｜测试｜运行中');
  assert.equal(shown, 0);
  assert.equal(files.writes.length, 1);
  assert.deepEqual(files.writes[0], {
    target: '/dev/pts/51', mode: NONBLOCKING_TTY_FLAGS, text: '\x1b]0;Codex｜测试｜运行中\x07',
  });
});

test('reapplies a cached title after the shell resets the terminal name', async () => {
  const terminal = { processId: Promise.resolve(301), name: 'bash' };
  const files = fakeFs(new Map([['/proc/301/fd/0', '/dev/pts/61']]));
  const manager = new TerminalManager({ window: { terminals: [terminal] } }, files);
  await manager.refreshBindings();
  const state = { terminalTty: '/dev/pts/61', terminalAlive: true, updatedAt: '1' };
  await manager.syncTitles([state], () => 'Codex｜任务｜运行中');
  terminal.name = 'Codex｜任务｜运行中';
  await manager.syncTitles([state], () => 'Codex｜任务｜运行中');
  terminal.name = 'bash';
  await manager.syncTitles([state], () => 'Codex｜任务｜运行中');
  assert.equal(files.writes.length, 2);
});

test('does not write titles to unverified terminal paths', async () => {
  const files = fakeFs();
  const manager = new TerminalManager({ window: { terminals: [] } }, files);
  assert.equal(await manager.writeTitle('/tmp/terminal', 'bad'), false);
  assert.equal(files.writes.length, 0);
});
