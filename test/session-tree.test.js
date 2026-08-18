'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { AgentSessionsProvider } = require('../src/session-tree');

class EventEmitter {
  constructor() {
    this.event = () => ({ dispose() {} });
  }
  fire() {}
  dispose() {}
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class ThemeIcon {
  constructor(id) { this.id = id; }
}

const vscode = {
  EventEmitter,
  TreeItem,
  ThemeIcon,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
};

test('groups sessions into attention, running, disconnected, and recent buckets', () => {
  const provider = new AgentSessionsProvider(vscode);
  provider.update([
    { source: 'codex', surface: 'ide', sessionId: 'a', task: 'ask', status: 'waiting_input', unread: true, updatedAt: '4' },
    { source: 'claude', sessionId: 'b', task: 'work', status: 'running', terminalAlive: true, updatedAt: '3' },
    { source: 'codex', sessionId: 'c', task: 'closed', status: 'running', terminalTty: '/dev/pts/1', terminalAlive: false, updatedAt: '2' },
    { source: 'codex', surface: 'ide', sessionId: 'd', task: 'done', status: 'completed', unread: false, updatedAt: '1' },
  ]);
  const groups = provider.getChildren();
  assert.deepEqual(groups.map((group) => group.id), ['attention', 'running', 'disconnected', 'recent']);
  assert.deepEqual(groups.map((group) => group.states.length), [1, 1, 1, 1]);
  assert.equal(provider.getTreeItem(groups[0]).label, '需要处理 (1)');
});

test('disconnected items resume while live items open exact sessions', () => {
  const provider = new AgentSessionsProvider(vscode);
  const closed = {
    source: 'codex', sessionId: 'c', task: '关闭任务', status: 'running',
    terminalTty: '/dev/pts/1', terminalAlive: false,
  };
  const live = { source: 'claude', sessionId: 'l', task: '运行任务', status: 'running', terminalAlive: true };
  const closedItem = provider.getTreeItem({ kind: 'session', state: closed });
  const liveItem = provider.getTreeItem({ kind: 'session', state: live });
  assert.equal(closedItem.command.command, 'agentStatus.resumeSession');
  assert.equal(closedItem.contextValue, 'agentStatus.session.disconnected');
  assert.equal(liveItem.command.command, 'agentStatus.openSession');
  assert.match(liveItem.description, /Claude Code/);
});

test('historical Codex records without TTY are offered as resumable terminals', () => {
  const provider = new AgentSessionsProvider(vscode);
  const state = {
    source: 'codex', sessionId: 'old', task: 'old task', status: 'completed', unread: false,
  };
  const item = provider.getTreeItem({ kind: 'session', state });
  assert.equal(item.command.command, 'agentStatus.resumeSession');
  assert.equal(item.contextValue, 'agentStatus.session.disconnected');
});
