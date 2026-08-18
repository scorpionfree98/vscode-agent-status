'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { scanIdeContexts } = require('./ide-context');
const { AgentSessionsProvider } = require('./session-tree');
const { TerminalManager } = require('./terminal-manager');
const {
  compactLabel,
  effectiveStatus,
  isActionableState,
  isIdeState,
  matchesWorkspace,
  latestTurnLifecycle,
  matchesHost,
  selectForTty,
  selectPinned,
  sourceLabel,
  stateKey,
  statusBarText,
  statusLabel,
  terminalTitle,
  resumeCommand,
  withStaleStatus,
} = require('./state');

class AgentStatusController {
  constructor(context) {
    this.context = context;
    this.states = [];
    this.watchHandle = undefined;
    this.refreshTimer = undefined;
    this.readTimer = undefined;
    this.pollTimer = undefined;
    this.refreshGeneration = 0;
    this.selectedStateKey = context.workspaceState.get('agentStatus.selectedStateKey');
    this.liveHostPids = new Set();
    this.ownedIdeContexts = new Set();
    this.liveIdeContexts = new Set();
    this.ideContextScannedAt = 0;
    this.terminalManager = new TerminalManager(vscode);
    this.resumeTerminals = new Map();
    this.treeProvider = undefined;
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
    const generation = ++this.refreshGeneration;
    await this.refreshIdeContexts();
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
          const withReceipt = await this.applyReadReceipt({ ...state, _filePath: filePath });
          states.push(await this.reconcileState(withReceipt));
        }
      } catch (error) {
        if (error.code !== 'ENOENT') console.warn(`Agent Status: ignoring ${filePath}.`, error);
      }
    }

    await this.terminalManager.refreshBindings();
    if (generation !== this.refreshGeneration) {
      this.scheduleRefresh();
      return;
    }
    this.states = this.terminalManager.annotate(states);
    this.liveHostPids = new Set(this.states
      .map((state) => Number(state.hostPid))
      .filter((pid) => pid && fs.existsSync(`/proc/${pid}`)));
    const relevant = this.relevantStates();
    await this.terminalManager.syncTitles(
      relevant,
      terminalTitle,
      this.configuration().get('renameActiveTerminal', true),
    );
    this.treeProvider?.update(relevant);
    this.render();
  }

  async refreshIdeContexts() {
    if (process.platform !== 'linux' || Date.now() - this.ideContextScannedAt < 5000) return;
    this.ideContextScannedAt = Date.now();
    const owned = new Set();
    const live = new Set();
    try {
      const scanned = await scanIdeContexts('/proc', process.pid);
      for (const contextId of scanned.owned) owned.add(contextId);
      for (const contextId of scanned.live) live.add(contextId);
    } catch (error) {
      console.warn('Agent Status: cannot inspect Codex IDE processes.', error);
      return;
    }
    this.ownedIdeContexts = owned;
    this.liveIdeContexts = live;
  }

  async reconcileState(state) {
    if (state.status === 'running' && state.transcriptPath) {
      try {
        const transcript = await this.readFileTail(state.transcriptPath);
        const lifecycle = latestTurnLifecycle(transcript, state.updatedAt);
        if (lifecycle?.status === 'interrupted') {
          return {
            ...state,
            status: 'interrupted',
            unread: false,
            detail: 'Codex turn 已中断',
            lifecycleAt: lifecycle.timestamp,
          };
        }
      } catch (error) {
        if (error.code !== 'ENOENT') console.warn('Agent Status: cannot inspect transcript.', error);
      }
    }
    const staleMinutes = this.configuration().get('staleAfterMinutes', 30);
    return withStaleStatus(state, Date.now(), staleMinutes * 60_000);
  }

  readReceiptPath(state) {
    return `${state._filePath}.read`;
  }

  async applyReadReceipt(state) {
    if (!state.unread) return state;
    try {
      const receipt = JSON.parse(await fs.promises.readFile(this.readReceiptPath(state), 'utf8'));
      if (
        receipt.version === 1
        && receipt.source === state.source
        && receipt.sessionId === state.sessionId
        && receipt.stateUpdatedAt === state.updatedAt
      ) {
        return { ...state, unread: false, readAt: receipt.readAt };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Agent Status: ignoring invalid read receipt.', error);
    }
    return state;
  }

  async readFileTail(filePath, maxBytes = 128 * 1024) {
    const normalized = filePath.startsWith('file://')
      ? decodeURIComponent(new URL(filePath).pathname)
      : filePath;
    const handle = await fs.promises.open(normalized, 'r');
    try {
      const metadata = await handle.stat();
      const length = Math.min(metadata.size, maxBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, metadata.size - length);
      return buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  }

  relevantStates() {
    const roots = this.workspaceRoots();
    return this.states.filter((state) => (
      matchesWorkspace(state, roots)
      && matchesHost(
        state,
        process.pid,
        this.liveHostPids,
        this.ownedIdeContexts,
        this.liveIdeContexts,
      )
    ));
  }

  selectedState(actionableOnly = false) {
    const states = actionableOnly
      ? this.relevantStates().filter(isActionableState)
      : this.relevantStates();
    return selectPinned(states, [], this.selectedStateKey);
  }

  async pinState(state) {
    this.selectedStateKey = stateKey(state);
    await this.context.workspaceState.update('agentStatus.selectedStateKey', this.selectedStateKey);
  }

  render() {
    const visible = this.configuration().get('showStatusBar', true);
    const selected = this.selectedState(true);
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
      `${sourceLabel(selected.source)}｜${statusLabel(effectiveStatus(selected))}${selected.unread ? '｜未读' : ''}`,
      selected.task || '当前任务',
    ];
    if (selected.cwd) lines.push(selected.cwd);
    if (selected.terminalTty) lines.push(`终端：${selected.terminalTty}`);
    else if (selected.source === 'codex') lines.push('Codex IDE 会话');
    lines.push('点击选择 session；终端会话可切换，IDE 会话会打开侧栏');
    return lines.join('\n');
  }

  scheduleMarkRead(terminalOnly = false) {
    clearTimeout(this.readTimer);
    const delay = this.configuration().get('markReadDelayMs', 1200);
    this.readTimer = setTimeout(() => this.markSelectedRead(terminalOnly), delay);
  }

  async markSelectedRead(terminalOnly = false) {
    if (!vscode.window.state.focused) return;
    const selected = this.selectedState();
    if (terminalOnly) {
      if (!selected?.terminalTty) return;
      const terminal = await this.terminalForState(selected);
      if (!terminal || terminal !== vscode.window.activeTerminal) return;
    }
    if (!selected?.unread) return;
    await this.markStateRead(selected);
    await this.refresh();
  }

  async markStateRead(state) {
    const readAt = new Date().toISOString();
    const receiptPath = this.readReceiptPath(state);
    const receipt = {
      version: 1,
      source: state.source,
      sessionId: state.sessionId,
      stateUpdatedAt: state.updatedAt,
      readAt,
    };
    const temporary = `${receiptPath}.${process.pid}.tmp`;
    try {
      await fs.promises.writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
      await fs.promises.rename(temporary, receiptPath);
    } catch (error) {
      console.warn(`Agent Status: cannot write ${receiptPath}.`, error);
      try { await fs.promises.unlink(temporary); } catch (_) { /* ignore */ }
      return;
    }

  }

  async terminalTty(terminal) {
    return this.terminalManager.terminalTty(terminal);
  }

  async terminalForState(state) {
    let terminal = this.terminalManager.terminalForState(state);
    if (terminal) return terminal;
    await this.terminalManager.refreshBindings();
    terminal = this.terminalManager.terminalForState(state);
    return terminal;
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
    return true;
  }

  setTreeProvider(provider) {
    this.treeProvider = provider;
    provider.update(this.relevantStates());
  }

  stateFromArgument(argument) {
    return argument?.state || argument;
  }

  async openSession(argument) {
    const state = this.stateFromArgument(argument);
    if (!state?.sessionId) return undefined;
    await this.pinState(state);
    this.render();
    const opened = await this.openState(state);
    if (opened && state.unread) await this.markStateRead(state);
    await this.refresh();
    if (!opened) vscode.window.showInformationMessage('该会话没有可打开的存活终端。');
    return opened;
  }

  async resumeSession(argument) {
    const state = this.stateFromArgument(argument);
    if (!state?.sessionId) return undefined;
    await this.pinState(state);
    this.render();
    if (await this.switchToState(state)) {
      if (state.unread) await this.markStateRead(state);
      await this.refresh();
      return 'terminal';
    }

    const key = stateKey(state);
    const pending = this.resumeTerminals.get(key);
    if (pending && vscode.window.terminals.includes(pending)) {
      pending.show(false);
      return 'pending';
    }
    this.resumeTerminals.delete(key);

    const command = resumeCommand(state, {
      codex: this.configuration().get('codexCommand', 'codex'),
      claude: this.configuration().get('claudeCommand', 'claude'),
    });
    if (!command) {
      vscode.window.showErrorMessage('无法恢复：session ID 格式不安全或 Agent 类型不受支持。');
      return undefined;
    }
    try {
      const metadata = await fs.promises.stat(state.cwd);
      if (!metadata.isDirectory()) throw new Error('工作目录不是文件夹');
    } catch (error) {
      vscode.window.showErrorMessage(`无法恢复：工作目录不可用 ${state.cwd || ''}`.trim());
      return undefined;
    }

    const terminal = vscode.window.createTerminal({
      name: `${sourceLabel(state.source)}｜${compactLabel(state.customName || state.task)}｜恢复中`,
      cwd: state.cwd,
    });
    this.resumeTerminals.set(key, terminal);
    terminal.show(false);
    terminal.sendText(command, true);
    if (state.unread) await this.markStateRead(state);
    await this.refresh();
    return 'created';
  }

  async markSessionRead(argument) {
    const state = this.stateFromArgument(argument);
    if (!state?.unread) return;
    await this.markStateRead(state);
    await this.refresh();
  }

  async openState(state) {
    if (await this.switchToState(state)) return 'terminal';
    if (isIdeState(state)) {
      try {
        await vscode.commands.executeCommand('chatgpt.openSidebar');
        return 'ide';
      } catch (error) {
        console.warn('Agent Status: cannot open Codex sidebar.', error);
      }
    }
    return undefined;
  }

  async showTasks() {
    const states = this.relevantStates().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    if (states.length === 0) {
      vscode.window.showInformationMessage('当前工作区没有 Codex 或 Claude Code 任务状态。');
      return;
    }
    const picked = await vscode.window.showQuickPick(states.map((state) => ({
      label: `${state.unread ? '$(bell-dot)' : '$(check)'} ${sourceLabel(state.source)}｜${statusLabel(effectiveStatus(state))}`,
      description: state.task,
      detail: [state.terminalTty
        ? `${state.terminalAlive === false ? '已关闭终端' : '终端'} ${state.terminalTty}`
        : state.source === 'codex' ? 'Codex IDE 会话' : '未关联集成终端', state.cwd]
        .filter(Boolean).join(' · '),
      state,
    })), { placeHolder: '选择 session；存活会话将切换，已关闭会话将恢复' });
    if (!picked?.state) return;
    await this.pinState(picked.state);
    this.render();
    const opened = effectiveStatus(picked.state) === 'disconnected'
      ? await this.resumeSession(picked.state)
      : await this.openState(picked.state);
    if (picked.state.unread) await this.markStateRead(picked.state);
    await this.refresh();
    if (!opened) {
      vscode.window.showInformationMessage('已固定该 session，但没有可打开的对应界面。');
    }
  }

  async clearReadCompleted() {
    const targets = this.relevantStates().filter((state) => state.status === 'completed' && !state.unread);
    await Promise.all(targets.map(async (state) => {
      try { await fs.promises.unlink(state._filePath); } catch (error) {
        if (error.code !== 'ENOENT') console.warn(`Agent Status: cannot remove ${state._filePath}.`, error);
      }
      try { await fs.promises.unlink(this.readReceiptPath(state)); } catch (error) {
        if (error.code !== 'ENOENT') console.warn(`Agent Status: cannot remove read receipt.`, error);
      }
    }));
    await this.refresh();
  }

  dispose() {
    clearTimeout(this.refreshTimer);
    clearTimeout(this.readTimer);
    if (this.watchHandle) this.watchHandle.close();
    this.treeProvider?.dispose?.();
  }
}

async function activate(context) {
  const controller = new AgentStatusController(context);
  const treeProvider = new AgentSessionsProvider(vscode);
  controller.setTreeProvider(treeProvider);
  context.subscriptions.push(controller);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('agentStatus.sessionsView', treeProvider),
    vscode.commands.registerCommand('agentStatus.markRead', () => controller.markSelectedRead()),
    vscode.commands.registerCommand('agentStatus.showTasks', () => controller.showTasks()),
    vscode.commands.registerCommand('agentStatus.clearReadCompleted', () => controller.clearReadCompleted()),
    vscode.commands.registerCommand('agentStatus.openSession', (item) => controller.openSession(item)),
    vscode.commands.registerCommand('agentStatus.resumeSession', (item) => controller.resumeSession(item)),
    vscode.commands.registerCommand('agentStatus.markSessionRead', (item) => controller.markSessionRead(item)),
    vscode.commands.registerCommand('agentStatus.refreshSessions', () => controller.refresh()),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) controller.scheduleMarkRead(true);
      else clearTimeout(controller.readTimer);
    }),
    vscode.window.onDidChangeActiveTerminal((terminal) => {
      if (terminal) controller.syncSelectionToActiveTerminal(terminal);
    }),
    vscode.window.onDidOpenTerminal(() => controller.scheduleRefresh()),
    vscode.window.onDidCloseTerminal((terminal) => {
      for (const [key, candidate] of controller.resumeTerminals) {
        if (candidate === terminal) controller.resumeTerminals.delete(key);
      }
      controller.scheduleRefresh();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('agentStatus')) controller.refresh();
    }),
  );
  await controller.start();
}

function deactivate() {}

module.exports = { AgentStatusController, activate, deactivate };
