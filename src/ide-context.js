'use strict';

const fs = require('fs');
const path = require('path');

async function scanIdeContexts(procRoot = '/proc', currentHostPid = process.pid) {
  const owned = new Set();
  const live = new Set();
  const entries = await fs.promises.readdir(procRoot, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map(async (entry) => {
      const procDir = path.join(procRoot, entry.name);
      try {
        const [commandBuffer, stat, environmentBuffer] = await Promise.all([
          fs.promises.readFile(path.join(procDir, 'cmdline')),
          fs.promises.readFile(path.join(procDir, 'stat'), 'utf8'),
          fs.promises.readFile(path.join(procDir, 'environ')),
        ]);
        const command = commandBuffer.toString('utf8').replaceAll('\0', ' ');
        if (!command.includes('codex') || !command.includes('app-server')) return;
        const contextEntry = environmentBuffer.toString('utf8').split('\0')
          .find((value) => value.startsWith('VSCODE_IPC_HOOK_CLI='));
        if (!contextEntry) return;
        const contextId = contextEntry.slice('VSCODE_IPC_HOOK_CLI='.length);
        if (!contextId) return;
        live.add(contextId);
        const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
        const parentPid = Number(fields[1]);
        if (parentPid === Number(currentHostPid)) owned.add(contextId);
      } catch (_) { /* processes may exit or hide their environment while scanning */ }
    }));
  return { owned, live };
}

module.exports = { scanIdeContexts };
