# Change Log

## 0.2.0

- Bind Codex and Claude Code sessions to integrated terminals by TTY.
- Switch to a session's terminal from the status bar task picker.
- Pin the selected session so background updates do not replace it.
- Mark only the selected session read and select sessions when terminals change.

## 0.1.1

- Keep new waiting/completed states unread while VS Code is already focused.
- Mark read only after the window regains focus or the active terminal changes.
- Clear stale read timestamps on new task-state transitions.

## 0.1.0

- Initial local release.
- Codex and Claude Code shared task-state protocol.
- VS Code focus-based read receipts and terminal-title updates.
