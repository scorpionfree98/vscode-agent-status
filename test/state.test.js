'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  isPathInside,
  matchesWorkspace,
  selectForTty,
  selectMostRelevant,
  selectPinned,
  statusBarText,
  terminalTitle,
} = require('../src/state');

test('matches nested workspace paths without prefix collisions', () => {
  assert.equal(isPathInside('/work/repo/subdir', '/work/repo'), true);
  assert.equal(isPathInside('/work/repository', '/work/repo'), false);
  assert.equal(matchesWorkspace({ cwd: '/work/repo/subdir' }, ['/work/repo']), true);
});

test('pinned session is not replaced by a newer background session', () => {
  const states = [
    { source: 'codex', sessionId: 'selected', cwd: '/work/repo', status: 'running', updatedAt: '2026-01-01' },
    { source: 'codex', sessionId: 'background', cwd: '/work/repo', status: 'completed', unread: true, updatedAt: '2026-01-02' },
  ];
  assert.equal(selectPinned(states, ['/work/repo'], 'codex:selected').sessionId, 'selected');
});

test('active terminal tty resolves its own latest session', () => {
  const states = [
    { source: 'codex', sessionId: 'one', cwd: '/work/repo', terminalTty: '/dev/pts/4', updatedAt: '2026-01-01' },
    { source: 'claude', sessionId: 'two', cwd: '/work/repo', terminalTty: '/dev/pts/5', updatedAt: '2026-01-02' },
  ];
  assert.equal(selectForTty(states, ['/work/repo'], '/dev/pts/5').sessionId, 'two');
  assert.equal(selectForTty(states, ['/work/repo'], '/dev/pts/9'), undefined);
});

test('unread waiting state outranks running and completed states', () => {
  const selected = selectMostRelevant([
    { source: 'codex', status: 'running', unread: false, updatedAt: '2026-01-03' },
    { source: 'claude', status: 'completed', unread: true, updatedAt: '2026-01-02' },
    { source: 'codex', status: 'waiting_input', unread: true, updatedAt: '2026-01-01' },
  ], []);
  assert.equal(selected.status, 'waiting_input');
});

test('renders localized terminal and status bar titles', () => {
  const state = { source: 'codex', status: 'completed', unread: true, task: '配置通知' };
  assert.equal(terminalTitle(state), 'Codex｜已完成｜配置通知');
  assert.equal(terminalTitle(state, true), 'Codex｜已读｜配置通知');
  assert.match(statusBarText(state), /Codex: 配置通知/);
  assert.equal(terminalTitle({ ...state, status: 'waiting_input', unread: true }), 'Codex｜等待输入｜配置通知');
  assert.equal(terminalTitle({ ...state, status: 'waiting_input', unread: false }), 'Codex｜等待输入（已读）｜配置通知');
});
