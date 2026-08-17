'use strict';

const path = require('path');

const SOURCE_LABELS = {
  codex: 'Codex',
  claude: 'Claude Code',
};

const STATUS_LABELS = {
  running: '运行中',
  waiting_permission: '等待授权',
  waiting_input: '等待输入',
  completed: '已完成',
  session_ended: '会话结束',
};

function sourceLabel(source) {
  return SOURCE_LABELS[source] || source || 'Agent';
}

function statusLabel(status) {
  return STATUS_LABELS[status] || status || '未知状态';
}

function isPathInside(candidate, root) {
  if (!candidate || !root) {
    return false;
  }
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function matchesWorkspace(state, workspaceRoots) {
  if (!Array.isArray(workspaceRoots) || workspaceRoots.length === 0) {
    return true;
  }
  return workspaceRoots.some((root) => isPathInside(state.cwd, root) || isPathInside(root, state.cwd));
}

function relevanceScore(state) {
  let score = 0;
  if (state.unread && state.status === 'waiting_permission') score += 600;
  else if (state.unread && state.status === 'waiting_input') score += 590;
  else if (state.unread && state.status === 'completed') score += 500;
  else if (state.status === 'waiting_permission' || state.status === 'waiting_input') score += 400;
  else if (state.status === 'running') score += 300;
  else if (state.status === 'completed') score += 200;
  return score;
}

function selectMostRelevant(states, workspaceRoots) {
  return states
    .filter((state) => matchesWorkspace(state, workspaceRoots))
    .sort((a, b) => {
      const scoreDiff = relevanceScore(b) - relevanceScore(a);
      if (scoreDiff !== 0) return scoreDiff;
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    })[0];
}

function stateKey(state) {
  return state ? `${state.source}:${state.sessionId}` : undefined;
}

function selectPinned(states, workspaceRoots, pinnedKey) {
  const relevant = states.filter((state) => matchesWorkspace(state, workspaceRoots));
  const pinned = pinnedKey
    ? relevant.find((state) => stateKey(state) === pinnedKey)
    : undefined;
  return pinned || selectMostRelevant(relevant, []);
}

function selectForTty(states, workspaceRoots, tty) {
  if (!tty) return undefined;
  return states
    .filter((state) => matchesWorkspace(state, workspaceRoots) && state.terminalTty === tty)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
}

function terminalTitle(state, readOverride = false) {
  const read = readOverride || state.unread === false;
  let status = statusLabel(state.status);
  if (read && state.status === 'completed') {
    status = '已读';
  } else if (read && (state.status === 'waiting_input' || state.status === 'waiting_permission')) {
    status += '（已读）';
  }
  return `${sourceLabel(state.source)}｜${status}｜${state.task || '当前任务'}`;
}

function statusBarText(state) {
  let icon = '$(pulse)';
  if (state.unread) icon = '$(bell-dot)';
  else if (state.status === 'running') icon = '$(loading~spin)';
  else if (state.status === 'completed') icon = '$(check)';
  else if (state.status === 'waiting_input' || state.status === 'waiting_permission') icon = '$(question)';
  return `${icon} ${sourceLabel(state.source)}: ${state.task || '当前任务'}`;
}

module.exports = {
  isPathInside,
  matchesWorkspace,
  selectForTty,
  selectMostRelevant,
  selectPinned,
  sourceLabel,
  stateKey,
  statusBarText,
  statusLabel,
  terminalTitle,
};
