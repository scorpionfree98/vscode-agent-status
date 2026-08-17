'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const test = require('node:test');

const executedCommands = [];
const configuration = new Map();
const defaultShowQuickPick = async () => undefined;
const vscode = {
  StatusBarAlignment: { Right: 2 },
  ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
  commands: {
    executeCommand: async (...args) => { executedCommands.push(args); },
    registerCommand: () => ({ dispose() {} }),
  },
  window: {
    activeTerminal: undefined,
    terminals: [],
    state: { focused: true },
    createStatusBarItem: () => ({ hide() {}, show() {}, dispose() {} }),
    onDidChangeActiveTerminal: () => ({ dispose() {} }),
    onDidChangeWindowState: () => ({ dispose() {} }),
    showInformationMessage: async () => undefined,
    showQuickPick: defaultShowQuickPick,
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({
      get: (key, fallback) => configuration.has(key) ? configuration.get(key) : fallback,
    }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { AgentStatusController } = require('../src/extension');
Module._load = originalLoad;

function context() {
  const storage = new Map();
  return {
    subscriptions: [],
    workspaceState: {
      get: (key) => storage.get(key),
      update: async (key, value) => storage.set(key, value),
    },
  };
}

async function temporaryState(value) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-status-test-'));
  const filePath = path.join(directory, 'state.json');
  await fs.promises.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return { directory, filePath };
}

test.beforeEach(() => {
  executedCommands.length = 0;
  configuration.clear();
  vscode.window.activeTerminal = undefined;
  vscode.window.terminals = [];
  vscode.window.state.focused = true;
  vscode.window.showQuickPick = defaultShowQuickPick;
  vscode.workspace.workspaceFolders = [];
});

test('focus read receipt only applies to the actually active terminal', async () => {
  const original = {
    version: 1,
    source: 'codex',
    sessionId: 'terminal-a',
    terminalTty: '/dev/pts/10',
    status: 'completed',
    unread: true,
    updatedAt: '2026-08-17T12:00:00Z',
  };
  const { directory, filePath } = await temporaryState(original);
  try {
    const controller = new AgentStatusController(context());
    const terminalA = { name: 'A' };
    const terminalB = { name: 'B' };
    vscode.window.activeTerminal = terminalB;
    controller.states = [{ ...original, _filePath: filePath }];
    controller.selectedStateKey = 'codex:terminal-a';
    controller.terminalForState = async () => terminalA;

    await controller.markSelectedRead(true);

    const saved = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    assert.equal(saved.unread, true);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('read receipt never overwrites a newer hook transition', async () => {
  const selected = {
    version: 1,
    source: 'codex',
    sessionId: 'race',
    status: 'completed',
    unread: true,
    updatedAt: '2026-08-17T12:00:00Z',
  };
  const newer = {
    ...selected,
    status: 'waiting_input',
    detail: 'new event',
    updatedAt: '2026-08-17T12:00:01Z',
  };
  const { directory, filePath } = await temporaryState(newer);
  try {
    const controller = new AgentStatusController(context());
    await controller.markStateRead({ ...selected, _filePath: filePath });

    const saved = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    assert.deepEqual(saved, newer);
    const effective = await controller.applyReadReceipt({ ...newer, _filePath: filePath });
    assert.equal(effective.unread, true);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('read receipt applies only to the exact hook transition it acknowledges', async () => {
  const state = {
    version: 1,
    source: 'claude',
    sessionId: 'receipt',
    status: 'waiting_input',
    unread: true,
    updatedAt: '2026-08-17T12:00:00Z',
  };
  const { directory, filePath } = await temporaryState(state);
  try {
    const controller = new AgentStatusController(context());
    const selected = { ...state, _filePath: filePath };
    await controller.markStateRead(selected);
    const effective = await controller.applyReadReceipt(selected);
    assert.equal(effective.unread, false);
    assert.ok(effective.readAt);

    const nextTransition = { ...selected, updatedAt: '2026-08-17T12:00:01Z' };
    assert.equal((await controller.applyReadReceipt(nextTransition)).unread, true);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('aborted transcript reconciles running state without mutating source file', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-transcript-test-'));
  const transcriptPath = path.join(directory, 'rollout.jsonl');
  try {
    await fs.promises.writeFile(transcriptPath, [
      JSON.stringify({ timestamp: '2026-08-17T12:00:00Z', type: 'event_msg', payload: { type: 'task_started' } }),
      JSON.stringify({ timestamp: '2026-08-17T12:00:02Z', type: 'event_msg', payload: { type: 'turn_aborted' } }),
    ].join('\n'));
    const controller = new AgentStatusController(context());
    const reconciled = await controller.reconcileState({
      source: 'codex',
      status: 'running',
      unread: false,
      updatedAt: '2026-08-17T12:00:01Z',
      transcriptPath,
    });
    assert.equal(reconciled.status, 'interrupted');
    assert.equal(reconciled.lifecycleAt, '2026-08-17T12:00:02Z');
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('IDE session opens Codex sidebar while terminal session uses its terminal', async () => {
  const controller = new AgentStatusController(context());
  controller.switchToState = async (state) => Boolean(state.terminalTty);

  assert.equal(await controller.openState({ source: 'codex' }), 'ide');
  assert.deepEqual(executedCommands.at(-1), ['chatgpt.openSidebar']);
  assert.equal(await controller.openState({ source: 'codex', terminalTty: '/dev/pts/1' }), 'terminal');
});

test('refresh loads only protocol states and merges an exact read receipt', async () => {
  const state = {
    version: 1,
    source: 'codex',
    sessionId: 'refresh',
    cwd: '/work/repo',
    status: 'completed',
    unread: true,
    updatedAt: '2026-08-17T12:00:00Z',
  };
  const { directory, filePath } = await temporaryState(state);
  try {
    await fs.promises.writeFile(`${filePath}.read`, JSON.stringify({
      version: 1,
      source: 'codex',
      sessionId: 'refresh',
      stateUpdatedAt: state.updatedAt,
      readAt: '2026-08-17T12:00:01Z',
    }));
    await fs.promises.writeFile(path.join(directory, 'ignored.json'), JSON.stringify({ version: 99 }));
    configuration.set('stateDirectory', directory);
    const controller = new AgentStatusController(context());
    controller.refreshIdeContexts = async () => {};

    await controller.refresh();

    assert.equal(controller.states.length, 1);
    assert.equal(controller.states[0].sessionId, 'refresh');
    assert.equal(controller.states[0].unread, false);
    assert.equal(controller.states[0].readAt, '2026-08-17T12:00:01Z');
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('active terminal selects its own session instead of a newer background session', async () => {
  const controller = new AgentStatusController(context());
  const terminal = { name: 'active' };
  controller.states = [
    { source: 'codex', sessionId: 'own', terminalTty: '/dev/pts/7', updatedAt: '2026-08-17T12:00:00Z' },
    { source: 'codex', sessionId: 'background', terminalTty: '/dev/pts/8', updatedAt: '2026-08-17T12:01:00Z' },
  ];
  controller.terminalTty = async (candidate) => candidate === terminal ? '/dev/pts/7' : undefined;

  assert.equal(await controller.syncSelectionToActiveTerminal(terminal, false), true);
  assert.equal(controller.selectedStateKey, 'codex:own');
});

test('task picker pins the chosen session and records an explicit IDE read receipt', async () => {
  const state = {
    version: 1,
    source: 'codex',
    sessionId: 'picked',
    cwd: '/work/repo',
    status: 'completed',
    unread: true,
    updatedAt: '2026-08-17T12:00:00Z',
  };
  const { directory, filePath } = await temporaryState(state);
  try {
    configuration.set('stateDirectory', directory);
    vscode.window.showQuickPick = async (items) => items[0];
    const controller = new AgentStatusController(context());
    controller.states = [{ ...state, _filePath: filePath }];
    controller.refreshIdeContexts = async () => {};
    controller.openState = async () => 'ide';

    await controller.showTasks();

    assert.equal(controller.selectedStateKey, 'codex:picked');
    assert.equal(fs.existsSync(`${filePath}.read`), true);
    assert.equal(controller.states[0].unread, false);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('clearing read completed tasks removes both state and receipt but keeps running tasks', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-clear-test-'));
  const completedPath = path.join(directory, 'completed.json');
  const runningPath = path.join(directory, 'running.json');
  try {
    await fs.promises.writeFile(completedPath, '{}');
    await fs.promises.writeFile(`${completedPath}.read`, '{}');
    await fs.promises.writeFile(runningPath, '{}');
    configuration.set('stateDirectory', directory);
    const controller = new AgentStatusController(context());
    controller.refreshIdeContexts = async () => {};
    controller.states = [
      { source: 'codex', sessionId: 'done', status: 'completed', unread: false, _filePath: completedPath },
      { source: 'codex', sessionId: 'live', status: 'running', unread: false, _filePath: runningPath },
    ];

    await controller.clearReadCompleted();

    assert.equal(fs.existsSync(completedPath), false);
    assert.equal(fs.existsSync(`${completedPath}.read`), false);
    assert.equal(fs.existsSync(runningPath), true);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});
