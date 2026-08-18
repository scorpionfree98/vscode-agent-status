'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  compactLabel,
  effectiveStatus,
  isActionableState,
  isIdeState,
  isPathInside,
  latestTurnLifecycle,
  matchesHost,
  matchesWorkspace,
  selectForTty,
  selectMostRelevant,
  selectPinned,
  sessionGroup,
  resumeCommand,
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
  const state = { source: 'codex', status: 'completed', unread: true, task: '配置通知', terminalAlive: true };
  assert.equal(terminalTitle(state), 'Codex｜配置通知｜已完成');
  assert.match(statusBarText(state), /Codex: 配置通知/);
  assert.equal(terminalTitle({ ...state, status: 'waiting_input', unread: true }), 'Codex｜配置通知｜等待输入');
  assert.equal(terminalTitle({ ...state, status: 'waiting_input', unread: false }), 'Codex｜配置通知｜等待输入');
});

test('sanitizes terminal task labels and prefers custom names', () => {
  assert.equal(compactLabel('  hello\n\x1b]0;bad｜title  '), 'hello ]0;bad·title');
  const long = compactLabel('x'.repeat(60));
  assert.equal(Array.from(long).length, 48);
  assert.ok(long.endsWith('…'));
  assert.equal(terminalTitle({
    source: 'claude', status: 'running', task: 'generated', customName: '我的会话', terminalAlive: true,
  }), 'Claude Code｜我的会话｜运行中');
});

test('derives disconnected lifecycle without overwriting the hook status', () => {
  const state = { status: 'running', terminalTty: '/dev/pts/9', terminalAlive: false };
  assert.equal(effectiveStatus(state), 'disconnected');
  assert.equal(state.status, 'running');
  assert.equal(isActionableState(state), false);
  assert.equal(sessionGroup(state), 'disconnected');
  assert.equal(sessionGroup({ status: 'completed', unread: true }), 'attention');
  assert.equal(sessionGroup({ status: 'running', terminalAlive: true }), 'running');
});

test('treats historical Codex records as terminal sessions unless explicitly marked IDE', () => {
  const historical = { source: 'codex', status: 'completed' };
  const ide = { source: 'codex', surface: 'ide', status: 'completed' };
  assert.equal(effectiveStatus(historical), 'disconnected');
  assert.equal(isActionableState(historical), false);
  assert.equal(isIdeState(historical), false);
  assert.equal(effectiveStatus(ide), 'completed');
  assert.equal(isActionableState(ide), true);
  assert.equal(isIdeState(ide), true);
});

test('builds only whitelisted resume commands for UUID sessions', () => {
  const id = '01a00eb8-d86e-7520-a334-7d30dff8de92';
  assert.equal(resumeCommand({ source: 'codex', sessionId: id }), `codex resume ${id}`);
  assert.equal(
    resumeCommand({ source: 'codex', sessionId: id }, { codex: 'codex-sp-happy' }),
    `codex-sp-happy resume ${id}`,
  );
  assert.equal(
    resumeCommand(
      { source: 'codex', sessionId: id, launchProfile: 'happy' },
      { codex: 'codex', codexProfiles: { happy: 'codex-sp-happy' } },
    ),
    `codex-sp-happy resume ${id}`,
  );
  assert.equal(
    resumeCommand(
      { source: 'codex', sessionId: id },
      { codex: 'codex', codexProfiles: { happy: 'codex-sp-happy' }, defaultCodexProfile: 'happy' },
    ),
    `codex-sp-happy resume ${id}`,
  );
  assert.equal(resumeCommand({ source: 'claude', sessionId: id }), `claude --resume ${id}`);
  assert.equal(resumeCommand({ source: 'codex', sessionId: 'x; rm -rf /' }), undefined);
  assert.equal(resumeCommand({ source: 'codex', sessionId: id }, { codex: 'codex;bad' }), undefined);
  assert.equal(resumeCommand(
    { source: 'codex', sessionId: id, launchProfile: 'unsafe profile' },
    { codex: 'codex', codexProfiles: { 'unsafe profile': 'bad;command' } },
  ), `codex resume ${id}`);
  assert.equal(resumeCommand({ source: 'unknown', sessionId: id }), undefined);
});
