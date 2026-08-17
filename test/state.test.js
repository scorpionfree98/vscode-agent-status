'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  isPathInside,
  matchesWorkspace,
  selectMostRelevant,
  statusBarText,
  terminalTitle,
} = require('../src/state');

test('matches nested workspace paths without prefix collisions', () => {
  assert.equal(isPathInside('/work/repo/subdir', '/work/repo'), true);
  assert.equal(isPathInside('/work/repository', '/work/repo'), false);
  assert.equal(matchesWorkspace({ cwd: '/work/repo/subdir' }, ['/work/repo']), true);
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
});

