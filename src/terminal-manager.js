'use strict';

const fs = require('fs');

const SAFE_TTY = /^\/dev\/(?:pts\/\d+|tty\w*)$/;
const NONBLOCKING_TTY_FLAGS = fs.constants.O_WRONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY;

class TerminalManager {
  constructor(vscode, fileSystem = fs) {
    this.vscode = vscode;
    this.fs = fileSystem;
    this.bindings = new Map();
    this.lastTitles = new Map();
  }

  async terminalTty(terminal) {
    if (!terminal || process.platform !== 'linux') return undefined;
    let pid;
    try {
      pid = await terminal.processId;
    } catch (_) {
      return undefined;
    }
    if (!pid) return undefined;
    for (const descriptor of [0, 1, 2]) {
      try {
        const target = await this.fs.promises.readlink(`/proc/${pid}/fd/${descriptor}`);
        if (SAFE_TTY.test(target)) return target;
      } catch (_) { /* descriptor may not exist */ }
    }
    return undefined;
  }

  async refreshBindings() {
    const next = new Map();
    await Promise.all((this.vscode.window.terminals || []).map(async (terminal) => {
      const tty = await this.terminalTty(terminal);
      if (tty && !next.has(tty)) next.set(tty, terminal);
    }));
    this.bindings = next;
    for (const tty of this.lastTitles.keys()) {
      if (!next.has(tty)) this.lastTitles.delete(tty);
    }
    return next;
  }

  annotate(states) {
    return states.map((state) => ({
      ...state,
      terminalAlive: state.terminalTty ? this.bindings.has(state.terminalTty) : undefined,
    }));
  }

  terminalForState(state) {
    return state?.terminalTty ? this.bindings.get(state.terminalTty) : undefined;
  }

  async writeTitle(tty, title) {
    if (!SAFE_TTY.test(String(tty || ''))) return false;
    let handle;
    try {
      // A busy full-screen TUI can block a normal open/write indefinitely.
      // Non-blocking mode makes title synchronization best-effort and keeps
      // the extension refresh loop responsive under terminal backpressure.
      handle = await this.fs.promises.open(tty, NONBLOCKING_TTY_FLAGS);
      await handle.write(`\x1b]0;${title}\x07`);
      return true;
    } catch (error) {
      console.warn(`Agent Status: cannot rename terminal ${tty}.`, error);
      return false;
    } finally {
      try { await handle?.close(); } catch (_) { /* ignore close errors */ }
    }
  }

  async syncTitles(states, titleForState, enabled = true) {
    if (!enabled) return;
    const latestByTty = new Map();
    for (const state of states) {
      if (!state.terminalTty || state.terminalAlive !== true) continue;
      const previous = latestByTty.get(state.terminalTty);
      if (!previous || String(state.updatedAt || '') > String(previous.updatedAt || '')) {
        latestByTty.set(state.terminalTty, state);
      }
    }
    for (const [tty, state] of latestByTty) {
      const title = titleForState(state);
      const terminal = this.bindings.get(tty);
      const previous = this.lastTitles.get(tty);
      if (
        previous?.terminal === terminal
        && previous?.title === title
        && (terminal?.name === undefined || terminal.name === title)
      ) continue;
      if (await this.writeTitle(tty, title)) this.lastTitles.set(tty, { terminal, title });
    }
  }
}

module.exports = { NONBLOCKING_TTY_FLAGS, SAFE_TTY, TerminalManager };
