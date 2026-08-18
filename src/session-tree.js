'use strict';

const {
  effectiveStatus,
  sessionGroup,
  sourceLabel,
  statusLabel,
} = require('./state');

const GROUPS = [
  { id: 'attention', label: '需要处理', icon: 'bell-dot', expanded: true },
  { id: 'running', label: '运行中', icon: 'loading~spin', expanded: true },
  { id: 'disconnected', label: '终端已关闭', icon: 'debug-disconnect', expanded: false },
  { id: 'recent', label: '最近记录', icon: 'history', expanded: false },
];

function iconForState(state) {
  if (state.unread) return 'bell-dot';
  const status = effectiveStatus(state);
  if (status === 'running') return 'loading~spin';
  if (status === 'completed') return 'check';
  if (status === 'disconnected') return 'debug-disconnect';
  if (status === 'waiting_input' || status === 'waiting_permission') return 'question';
  if (status === 'interrupted') return 'debug-pause';
  return 'clock';
}

class AgentSessionsProvider {
  constructor(vscode) {
    this.vscode = vscode;
    this.states = [];
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }

  update(states) {
    this.states = [...states].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    this.emitter.fire(undefined);
  }

  getChildren(element) {
    if (!element) {
      return GROUPS.map((group) => ({
        kind: 'group',
        ...group,
        states: this.states.filter((state) => sessionGroup(state) === group.id),
      })).filter((group) => group.states.length > 0);
    }
    if (element.kind === 'group') {
      return element.states.map((state) => ({ kind: 'session', state }));
    }
    return [];
  }

  getTreeItem(element) {
    const { vscode } = this;
    if (element.kind === 'group') {
      const collapsible = element.expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
      const item = new vscode.TreeItem(`${element.label} (${element.states.length})`, collapsible);
      item.iconPath = new vscode.ThemeIcon(element.icon);
      item.contextValue = `agentStatus.group.${element.id}`;
      return item;
    }

    const { state } = element;
    const item = new vscode.TreeItem(state.customName || state.task || '当前任务', vscode.TreeItemCollapsibleState.None);
    const status = effectiveStatus(state);
    item.description = `${sourceLabel(state.source)} · ${statusLabel(status)}${state.unread ? ' · 未读' : ''}`;
    item.iconPath = new vscode.ThemeIcon(iconForState(state));
    item.tooltip = [
      `${sourceLabel(state.source)}｜${statusLabel(status)}${state.unread ? '｜未读' : ''}`,
      state.task || '当前任务',
      state.cwd || '',
      state.terminalTty ? `终端：${state.terminalTty}` : '',
      `Session：${state.sessionId}`,
    ].filter(Boolean).join('\n');
    const disconnected = status === 'disconnected';
    item.contextValue = disconnected
      ? 'agentStatus.session.disconnected'
      : state.unread ? 'agentStatus.session.unread' : 'agentStatus.session';
    item.command = {
      command: disconnected ? 'agentStatus.resumeSession' : 'agentStatus.openSession',
      title: disconnected ? '恢复会话' : '打开会话',
      arguments: [element],
    };
    return item;
  }

  dispose() {
    this.emitter.dispose();
  }
}

module.exports = { AgentSessionsProvider, GROUPS, iconForState };
