'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  isPathInside,
  latestTurnLifecycle,
  matchesHost,
  matchesWorkspace,
  selectForTty,
  selectMostRelevant,
  selectPinned,
  statusBarText,
  terminalTitle,
  withStaleStatus,
} = require('../src/state');

test('matches nested workspace paths without prefix collisions', () => {
  assert.equal(isPathInside('/work/repo/subdir', '/work/repo'), true);
  assert.equal(isPathInside('/work/repository', '/work/repo'), false);
  assert.equal(matchesWorkspace({ cwd: '/work/repo/subdir' }, ['/work/repo']), true);
  assert.equal(matchesWorkspace({ cwd: '/work/repo' }, ['/work/repo/subdir']), false);
});

test('host-bound live sessions stay in their owning VS Code window', () => {
  const live = new Set([100, 200]);
  assert.equal(matchesHost({ hostPid: 100 }, 100, live), true);
  assert.equal(matchesHost({ hostPid: 200 }, 100, live), false);
  assert.equal(matchesHost({ hostPid: 300 }, 100, live), true);
  assert.equal(matchesHost({}, 100, live), true);
});

test('IDE context binding takes priority over host fallback', () => {
  const liveContexts = new Set(['ipc-this', 'ipc-other']);
  assert.equal(matchesHost(
    { ideContextId: 'ipc-this' }, 100, new Set(), new Set(['ipc-this']), liveContexts,
  ), true);
  assert.equal(matchesHost(
    { ideContextId: 'ipc-other' }, 100, new Set(), new Set(['ipc-this']), liveContexts,
  ), false);
  assert.equal(matchesHost(
    { ideContextId: 'ipc-closed' }, 100, new Set(), new Set(['ipc-this']), liveContexts,
  ), true);
});

test('detects aborted turns after the last hook update', () => {
  const transcript = [
    JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type: 'event_msg', payload: { type: 'turn_aborted' } }),
    JSON.stringify({ timestamp: '2026-01-01T00:02:00Z', type: 'event_msg', payload: { type: 'turn_aborted' } }),
  ].join('\n');
  assert.deepEqual(latestTurnLifecycle(transcript, '2026-01-01T00:01:00Z'), {
    status: 'interrupted', timestamp: '2026-01-01T00:02:00Z',
  });
});

test('abort detection compares timestamps by instant rather than ISO text order', () => {
  const transcript = JSON.stringify({
    timestamp: '2026-01-01T00:30:00Z',
    type: 'event_msg',
    payload: { type: 'turn_aborted' },
  });
  assert.equal(
    latestTurnLifecycle(transcript, '2026-01-01T01:00:00+01:00').status,
    'interrupted',
  );
});

test('running sessions become stale after the configured threshold', () => {
  const state = { status: 'running', unread: false, updatedAt: '2026-01-01T00:00:00Z' };
  assert.equal(withStaleStatus(state, Date.parse('2026-01-01T00:29:00Z'), 30 * 60_000).status, 'running');
  assert.equal(withStaleStatus(state, Date.parse('2026-01-01T00:31:00Z'), 30 * 60_000).status, 'stale');
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
