'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const {
  matchesWorkspace,
  selectForTty,
  selectPinned,
  sourceLabel,
  stateKey,
  statusBarText,
  statusLabel,
  terminalTitle,
} = require('./state');

class AgentStatusController {
  constructor(context) {
    this.context = context;
    this.states = [];
    this.watchHandle = undefined;
    this.refreshTimer = undefined;
    this.readTimer = undefined;
    this.pollTimer = undefined;
    this.selectedStateKey = context.workspaceState.get('agentStatus.selectedStateKey');
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBar.command = 'agentStatus.showTasks';
    this.context.subscriptions.push(this.statusBar);
  }

  configuration() {
    return vscode.workspace.getConfiguration('agentStatus');
  }

  stateDirectory() {
    const configured = this.configuration().get('stateDirectory', '~/.agent-status');
    if (configured === '~') return os.homedir();
    if (configured.startsWith('~/')) return path.join(os.homedir(), configured.slice(2));
    return path.resolve(configured);
  }

  workspaceRoots() {
    return (vscode.workspace.workspaceFolders || [])
      .map((folder) => folder.uri.fsPath);
  }

  async start() {
    await fs.promises.mkdir(this.stateDirectory(), { recursive: true, mode: 0o700 });
    await this.refresh();
    await this.syncSelectionToActiveTerminal(vscode.window.activeTerminal, false);
    this.startWatcher();
    this.pollTimer = setInterval(() => this.scheduleRefresh(), 3000);
    this.context.subscriptions.push({ dispose: () => clearInterval(this.pollTimer) });
  }

  startWatcher() {
    if (this.watchHandle) this.watchHandle.close();
    try {
      this.watchHandle = fs.watch(this.stateDirectory(), () => this.scheduleRefresh());
      this.context.subscriptions.push({ dispose: () => this.watchHandle?.close() });
    } catch (error) {
      console.warn('Agent Status: state watcher unavailable; polling remains active.', error);
    }
  }

  scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), 100);
  }

  async refresh() {
    const directory = this.stateDirectory();
    let names = [];
    try {
      names = (await fs.promises.readdir(directory)).filter((name) => name.endsWith('.json'));
    } catch (error) {
      console.warn('Agent Status: cannot read state directory.', error);
      return;
    }

    const states = [];
    for (const name of names) {
      const filePath = path.join(directory, name);
      try {
        const state = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
        if (state && state.version === 1 && state.source && state.sessionId) {
          states.push({ ...state, _filePath: filePath });
        }
      } catch (error) {
        if (error.code !== 'ENOENT') console.warn(`Agent Status: ignoring ${filePath}.`, error);
      }
    }

    this.states = states;
    this.render();
  }

  relevantStates() {
    const roots = this.workspaceRoots();
    return this.states.filter((state) => matchesWorkspace(state, roots));
  }

  selectedState() {
    return selectPinned(this.states, this.workspaceRoots(), this.selectedStateKey);
  }

  async pinState(state) {
    this.selectedStateKey = stateKey(state);
    await this.context.workspaceState.update('agentStatus.selectedStateKey', this.selectedStateKey);
  }

  render() {
    const visible = this.configuration().get('showStatusBar', true);
    const selected = this.selectedState();
    if (!visible || !selected) {
      this.statusBar.hide();
      return;
    }

    this.statusBar.text = statusBarText(selected);
    this.statusBar.tooltip = this.tooltip(selected);
    this.statusBar.backgroundColor = selected.unread
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    this.statusBar.show();
  }

  tooltip(selected) {
    const lines = [
      `${sourceLabel(selected.source)}｜${statusLabel(selected.status)}${selected.unread ? '｜未读' : ''}`,
      selected.task || '当前任务',
    ];
    if (selected.cwd) lines.push(selected.cwd);
    if (selected.terminalTty) lines.push(`终端：${selected.terminalTty}`);
    lines.push('点击选择 session 并切换到对应终端');
    return lines.join('\n');
  }

  scheduleMarkRead() {
    clearTimeout(this.readTimer);
    const delay = this.configuration().get('markReadDelayMs', 1200);
    this.readTimer = setTimeout(() => this.markSelectedRead(), delay);
  }

  async markSelectedRead() {
    if (!vscode.window.state.focused) return;
    const selected = this.selectedState();
    if (!selected?.unread) return;
    await this.markStateRead(selected);
    await this.refresh();
  }

  async markStateRead(state) {
    const readAt = new Date().toISOString();
    const updated = { ...state, unread: false, readAt };
    delete updated._filePath;
    const temporary = `${state._filePath}.${process.pid}.tmp`;
    try {
      await fs.promises.writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
      await fs.promises.rename(temporary, state._filePath);
    } catch (error) {
      console.warn(`Agent Status: cannot mark ${state._filePath} read.`, error);
      try { await fs.promises.unlink(temporary); } catch (_) { /* ignore */ }
      return;
    }

    const terminal = await this.terminalForState(state);
    if (terminal && terminal === vscode.window.activeTerminal) {
      await this.renameTerminal(terminal, terminalTitle(state, true));
    }
  }

  async renameTerminal(terminal, title) {
    if (!terminal || !this.configuration().get('renameActiveTerminal', true)) return;
    const previous = vscode.window.activeTerminal;
    if (previous !== terminal) terminal.show(true);
    try {
      await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: title });
    } catch (error) {
      console.warn('Agent Status: terminal rename command is unavailable.', error);
    }
  }

  async terminalTty(terminal) {
    if (!terminal) return undefined;
    let pid;
    try {
      pid = await terminal.processId;
    } catch (_) {
      return undefined;
    }
    if (!pid) return undefined;
    for (const descriptor of [0, 1, 2]) {
      try {
        const target = await fs.promises.readlink(`/proc/${pid}/fd/${descriptor}`);
        if (target.startsWith('/dev/pts/') || target.startsWith('/dev/tty')) return target;
      } catch (_) { /* descriptor may not exist */ }
    }
    return undefined;
  }

  async terminalForState(state) {
    if (!state?.terminalTty) return undefined;
    for (const terminal of vscode.window.terminals) {
      if (await this.terminalTty(terminal) === state.terminalTty) return terminal;
    }
    return undefined;
  }

  async syncSelectionToActiveTerminal(terminal, markRead = true) {
    const tty = await this.terminalTty(terminal);
    const state = selectForTty(this.states, this.workspaceRoots(), tty);
    if (!state) return false;
    await this.pinState(state);
    this.render();
    if (markRead && vscode.window.state.focused) this.scheduleMarkRead();
    return true;
  }

  async switchToState(state) {
    const terminal = await this.terminalForState(state);
    if (!terminal) return false;
    terminal.show(false);
    await this.renameTerminal(terminal, terminalTitle(state));
    return true;
  }

  async showTasks() {
    const states = this.relevantStates().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    if (states.length === 0) {
      vscode.window.showInformationMessage('当前工作区没有 Codex 或 Claude Code 任务状态。');
      return;
    }
    const picked = await vscode.window.showQuickPick(states.map((state) => ({
      label: `${state.unread ? '$(bell-dot)' : '$(check)'} ${sourceLabel(state.source)}｜${statusLabel(state.status)}`,
      description: state.task,
      detail: [state.terminalTty ? `终端 ${state.terminalTty}` : '未关联集成终端', state.cwd]
        .filter(Boolean).join(' · '),
      state,
    })), { placeHolder: '选择 session，并切换到它对应的集成终端' });
    if (!picked?.state) return;
    await this.pinState(picked.state);
    this.render();
    const switched = await this.switchToState(picked.state);
    if (picked.state.unread) await this.markStateRead(picked.state);
    await this.refresh();
    if (!switched) {
      vscode.window.showInformationMessage('已固定该 session，但它没有可切换的集成终端。');
    }
  }

  async clearReadCompleted() {
    const targets = this.relevantStates().filter((state) => state.status === 'completed' && !state.unread);
    await Promise.all(targets.map(async (state) => {
      try { await fs.promises.unlink(state._filePath); } catch (error) {
        if (error.code !== 'ENOENT') console.warn(`Agent Status: cannot remove ${state._filePath}.`, error);
      }
    }));
    await this.refresh();
  }

  dispose() {
    clearTimeout(this.refreshTimer);
    clearTimeout(this.readTimer);
    if (this.watchHandle) this.watchHandle.close();
  }
}

async function activate(context) {
  const controller = new AgentStatusController(context);
  context.subscriptions.push(controller);
  context.subscriptions.push(
    vscode.commands.registerCommand('agentStatus.markRead', () => controller.markSelectedRead()),
    vscode.commands.registerCommand('agentStatus.showTasks', () => controller.showTasks()),
    vscode.commands.registerCommand('agentStatus.clearReadCompleted', () => controller.clearReadCompleted()),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) controller.scheduleMarkRead();
      else clearTimeout(controller.readTimer);
    }),
    vscode.window.onDidChangeActiveTerminal((terminal) => {
      if (terminal) controller.syncSelectionToActiveTerminal(terminal);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('agentStatus')) controller.refresh();
    }),
  );
  await controller.start();
}

function deactivate() {}

module.exports = { activate, deactivate };
