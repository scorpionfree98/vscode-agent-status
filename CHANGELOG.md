# Change Log

## 0.5.0

- Add a shell launch registry that binds Codex sessions to the originating TTY and VS Code IPC context even when hooks run in a shared app-server.
- Capture a safe launch Profile name per session without persisting proxy credentials or the complete process environment.
- Resolve Codex resume launchers by session Profile, default Profile, configured command, then the built-in `codex` fallback.
- Require exact resume-session matches or a single live unclaimed launch in the same working directory to prevent cross-terminal switches.
- Wrap local interactive `codex` launches in `.bashrc` and tag proxy, happy, and direct aliases with distinct Profiles.

## 0.4.1

- Classify Codex sessions explicitly as integrated-terminal or IDE sessions so historical CLI records no longer open the unrelated Codex client.
- Treat closed and legacy Codex CLI sessions as resumable terminal sessions even when their old state lacks a TTY.
- Add safe configurable Codex and Claude Code launchers for resume workflows, including shell aliases such as `codex-sp-happy`.
- Configure the local installation to restore Codex sessions with `codex-sp-happy resume <session-id>`.

## 0.4.0

- Add an Agent Sessions activity-bar view grouped by attention, running, disconnected, and recent sessions.
- Detect closed terminals from the current VS Code terminal-to-TTY map while preserving session history.
- Resume closed Codex and Claude Code sessions in a new integrated terminal with duplicate and input guards.
- Synchronize exact background terminal titles as `Agent｜Task｜Status` without stealing focus.
- Keep read state separate from the terminal lifecycle status and remove competing hook-side OSC title writes.
- Add lifecycle, tree view, resume safety, OSC naming, shell-title reset, and duplicate suppression tests.

## 0.3.2

- Resolve Codex TUI sessions to their live terminal PID through the local Codex log index.
- Record the exact terminal TTY and VS Code IPC context even when hooks execute in the background app-server.
- Reject stale PID reuse and add synthetic SQLite/process-tree regression tests.

## 0.3.1

- Prevent window focus from marking a non-active terminal session read.
- Store read receipts separately so an older UI action cannot overwrite a newer hook transition.
- Compare transcript lifecycle timestamps by instant across timezone offsets.
- Add controller, hook integration, process-context, race, permission, and filesystem safety tests.

## 0.3.0

- Bind Codex IDE sessions to their VS Code IPC context when available, with Extension Host and workspace fallbacks.
- Keep pinned sessions stable across background updates and isolate nested workspaces in one direction.
- Detect aborted Codex turns from transcripts and downgrade stale running states to unknown.
- Avoid automatically marking IDE sessions read on window focus; terminal sessions still use focused-terminal read receipts.
- Open the Codex sidebar for IDE sessions and switch terminals only for TTY-bound sessions.

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
