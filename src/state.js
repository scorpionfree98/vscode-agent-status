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
  interrupted: '已中断',
  stale: '状态未知',
  session_ended: '会话结束',
  disconnected: '终端已关闭',
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
  return workspaceRoots.some((root) => isPathInside(state.cwd, root));
}

function matchesHost(
  state,
  currentHostPid,
  liveHostPids = new Set(),
  ownedIdeContexts = new Set(),
  liveIdeContexts = new Set(),
) {
  if (state.ideContextId) {
    if (ownedIdeContexts.has(state.ideContextId)) return true;
    if (liveIdeContexts.has(state.ideContextId)) return false;
  }
  if (!state.hostPid) return true;
  const hostPid = Number(state.hostPid);
  return hostPid === Number(currentHostPid) || !liveHostPids.has(hostPid);
}

function relevanceScore(state) {
  let score = 0;
  if (state.unread && state.status === 'waiting_permission') score += 600;
  else if (state.unread && state.status === 'waiting_input') score += 590;
  else if (state.unread && state.status === 'completed') score += 500;
  else if (state.status === 'waiting_permission' || state.status === 'waiting_input') score += 400;
  else if (state.status === 'running') score += 300;
  else if (state.status === 'completed') score += 200;
  else if (state.status === 'interrupted') score += 150;
  else if (state.status === 'stale') score += 100;
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

function latestTurnLifecycle(text, afterTimestamp) {
  let latest;
  let latestMs;
  const afterMs = Date.parse(afterTimestamp || '');
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const event = record?.type === 'event_msg' ? record.payload?.type : undefined;
      if (event !== 'turn_aborted') continue;
      const timestamp = String(record.timestamp || '');
      const timestampMs = Date.parse(timestamp);
      if (afterTimestamp) {
        const after = Number.isFinite(timestampMs) && Number.isFinite(afterMs)
          ? timestampMs > afterMs
          : timestamp > String(afterTimestamp);
        if (!after) continue;
      }
      const isNewer = !latest || (
        Number.isFinite(timestampMs) && Number.isFinite(latestMs)
          ? timestampMs > latestMs
          : timestamp > latest.timestamp
      );
      if (isNewer) {
        latest = { status: 'interrupted', timestamp };
        latestMs = timestampMs;
      }
    } catch (_) { /* incomplete transcript line */ }
  }
  return latest;
}

function withStaleStatus(state, nowMs, staleAfterMs) {
  if (state.status !== 'running' || !staleAfterMs) return state;
  const updatedMs = Date.parse(state.updatedAt || '');
  if (!Number.isFinite(updatedMs) || nowMs - updatedMs < staleAfterMs) return state;
  return { ...state, status: 'stale', unread: false, detail: '长时间没有收到 Agent 状态更新' };
}

function compactLabel(value, maxLength = 48) {
  const normalized = String(value || '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/｜/g, '·')
    .replace(/\s+/g, ' ')
    .trim();
  const characters = Array.from(normalized || '当前任务');
  return characters.length > maxLength
    ? `${characters.slice(0, Math.max(1, maxLength - 1)).join('')}…`
    : characters.join('');
}

function isTerminalState(state) {
  if (state?.surface === 'ide') return false;
  if (state?.surface === 'terminal') return true;
  return state?.source === 'codex' || state?.source === 'claude' || Boolean(state?.terminalTty);
}

function isIdeState(state) {
  return state?.source === 'codex' && state?.surface === 'ide';
}

function effectiveStatus(state) {
  return isTerminalState(state) && state.terminalAlive !== true ? 'disconnected' : state.status;
}

function isActionableState(state) {
  return !isTerminalState(state) || state.terminalAlive === true;
}

function sessionGroup(state) {
  const status = effectiveStatus(state);
  if (
    status === 'waiting_input'
    || status === 'waiting_permission'
    || (state.unread && status === 'completed')
  ) return 'attention';
  if (status === 'running') return 'running';
  if (status === 'disconnected') return 'disconnected';
  return 'recent';
}

function terminalTitle(state) {
  return [
    sourceLabel(state.source),
    compactLabel(state.customName || state.task),
    statusLabel(effectiveStatus(state)),
  ].join('｜');
}

function isSafeSessionId(sessionId) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(sessionId || ''));
}

function resumeCommand(state, launchers = {}) {
  if (!isSafeSessionId(state?.sessionId)) return undefined;
  const launcher = state.source === 'codex'
    ? String(launchers.codex || 'codex')
    : state.source === 'claude' ? String(launchers.claude || 'claude') : '';
  if (!/^[A-Za-z0-9_./:+-]+$/.test(launcher)) return undefined;
  if (state.source === 'codex') return `${launcher} resume ${state.sessionId}`;
  if (state.source === 'claude') return `${launcher} --resume ${state.sessionId}`;
  return undefined;
}

function statusBarText(state) {
  let icon = '$(pulse)';
  if (state.unread) icon = '$(bell-dot)';
  else if (state.status === 'running') icon = '$(loading~spin)';
  else if (state.status === 'completed') icon = '$(check)';
  else if (state.status === 'interrupted') icon = '$(debug-pause)';
  else if (state.status === 'stale') icon = '$(clock)';
  else if (state.status === 'waiting_input' || state.status === 'waiting_permission') icon = '$(question)';
  return `${icon} ${sourceLabel(state.source)}: ${state.task || '当前任务'}`;
}

module.exports = {
  isPathInside,
  compactLabel,
  effectiveStatus,
  isActionableState,
  isIdeState,
  isSafeSessionId,
  isTerminalState,
  latestTurnLifecycle,
  matchesHost,
  matchesWorkspace,
  selectForTty,
  selectMostRelevant,
  selectPinned,
  sessionGroup,
  sourceLabel,
  stateKey,
  statusBarText,
  statusLabel,
  terminalTitle,
  resumeCommand,
  withStaleStatus,
};
