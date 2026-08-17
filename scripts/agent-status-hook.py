#!/usr/bin/env python3
"""Shared Codex and Claude Code hook for VS Code task status/read receipts."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


STATE_VERSION = 1
SOURCE_LABELS = {"codex": "Codex", "claude": "Claude Code"}
STATUS_LABELS = {
    "running": "运行中",
    "waiting_permission": "等待授权",
    "waiting_input": "等待输入",
    "completed": "已完成",
    "session_ended": "会话结束",
}


def compact_task(prompt: str, limit: int = 26) -> str:
    prompt = re.sub(r"<environment_context>.*?</environment_context>", " ", prompt, flags=re.S)
    prompt = re.sub(r"```.*?```", " ", prompt, flags=re.S)
    prompt = re.sub(r"https?://\S+", " ", prompt)
    prompt = re.sub(r"[`#>*_~\[\]()]", " ", prompt)
    prompt = re.sub(r"\s+", " ", prompt).strip()
    prompt = re.sub(r"^(请帮我|麻烦帮我|可以帮我|请|麻烦|帮我|能否)\s*", "", prompt)
    if not prompt:
        return "当前任务"
    return prompt if len(prompt) <= limit else prompt[:limit].rstrip() + "…"


def safe_session_id(source: str, data: dict[str, Any]) -> str:
    session_id = str(data.get("session_id") or data.get("thread-id") or "").strip()
    if session_id:
        return session_id
    fallback = f"{source}:{data.get('cwd', '')}"
    return "fallback-" + hashlib.sha256(fallback.encode()).hexdigest()[:16]


def state_path(state_dir: Path, source: str, session_id: str) -> Path:
    digest = hashlib.sha256(session_id.encode()).hexdigest()[:24]
    return state_dir / f"{source}-{digest}.json"


def read_state(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {}


def atomic_write(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def controlling_tty() -> str:
    """Return the terminal device that launched the hook, when one exists."""
    try:
        stat_fields = Path("/proc/self/stat").read_text(encoding="utf-8").rpartition(")")[2].split()
        device = int(stat_fields[4])
        if device == 0:
            return ""
        major = os.major(device)
        minor = os.minor(device)
        if 136 <= major <= 143:
            candidate = f"/dev/pts/{(major - 136) * 256 + minor}"
        elif major == 4:
            candidate = f"/dev/tty{minor}"
        else:
            return ""
        if os.stat(candidate).st_rdev == device:
            return candidate
    except (OSError, ValueError, IndexError):
        return ""
    return ""


def extension_host_pid(proc_root: Path = Path("/proc")) -> int | None:
    """Find the VS Code extension host that owns an IDE-launched agent."""
    pid = os.getppid()
    for _ in range(20):
        if pid <= 1:
            return None
        try:
            command = (proc_root / str(pid) / "cmdline").read_bytes().replace(b"\0", b" ").decode()
            stat_tail = (proc_root / str(pid) / "stat").read_text(encoding="utf-8").rpartition(")")[2].split()
            if "bootstrap-fork" in command and "--type=extensionHost" in command:
                return pid
            pid = int(stat_tail[1])
        except (OSError, ValueError, IndexError, UnicodeDecodeError):
            return None
    return None


def ide_context_id() -> str | None:
    """Identify the VS Code app-server instance that emitted this hook."""
    value = os.environ.get("VSCODE_IPC_HOOK_CLI", "").strip()
    return value or None


def event_status(source: str, data: dict[str, Any]) -> tuple[str | None, bool, str]:
    event = str(data.get("hook_event_name") or data.get("type") or "")
    tool = str(data.get("tool_name") or "")
    notification_type = str(data.get("notification_type") or "")

    if event == "UserPromptSubmit":
        return "running", False, ""
    if event == "PermissionRequest":
        return "waiting_permission", True, _tool_detail(data)
    if event == "PreToolUse" and tool in {"request_user_input", "AskUserQuestion"}:
        return "waiting_input", True, "Agent 正在等待你回答问题"
    if event == "Notification":
        if notification_type in {"permission_prompt", "permission_request"}:
            return "waiting_permission", True, str(data.get("message") or "")
        return "waiting_input", True, str(data.get("message") or "")
    if event == "PostToolUse":
        return "running", False, ""
    if event in {"Stop", "agent-turn-complete"}:
        return "completed", True, str(
            data.get("last_assistant_message")
            or data.get("last-assistant-message")
            or data.get("message")
            or ""
        )
    if event == "SessionEnd":
        return "session_ended", False, ""
    return None, False, ""


def _tool_detail(data: dict[str, Any]) -> str:
    tool_input = data.get("tool_input")
    if not isinstance(tool_input, dict):
        return ""
    return str(tool_input.get("description") or tool_input.get("command") or "")


def update_state(source: str, data: dict[str, Any], state_dir: Path) -> dict[str, Any] | None:
    status, unread, detail = event_status(source, data)
    if status is None:
        return None

    session_id = safe_session_id(source, data)
    path = state_path(state_dir, source, session_id)
    previous = read_state(path)
    prompt = str(data.get("prompt") or "")
    task = compact_task(prompt) if prompt else str(previous.get("task") or "当前任务")
    cwd = str(data.get("cwd") or previous.get("cwd") or "")
    terminal_tty = controlling_tty() or str(previous.get("terminalTty") or "")
    host_pid = extension_host_pid() or previous.get("hostPid")
    context_id = ide_context_id() or previous.get("ideContextId")
    transcript_path = str(data.get("transcript_path") or previous.get("transcriptPath") or "")
    detail = re.sub(r"\s+", " ", detail).strip()
    if len(detail) > 240:
        detail = detail[:240].rstrip() + "…"

    state = {
        "version": STATE_VERSION,
        "source": source,
        "sessionId": session_id,
        "cwd": cwd,
        "terminalTty": terminal_tty or None,
        "hostPid": host_pid,
        "ideContextId": context_id,
        "transcriptPath": transcript_path or None,
        "task": task,
        "status": status,
        "unread": unread,
        "detail": detail,
        "lastEvent": str(data.get("hook_event_name") or data.get("type") or ""),
        "updatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        # Every hook event is a fresh state transition. Running states are not
        # notifications, so they are neither unread nor previously "read".
        "readAt": None,
    }
    atomic_write(path, state)
    return state


def terminal_title(state: dict[str, Any]) -> str:
    return f"{SOURCE_LABELS[state['source']]}｜{STATUS_LABELS[state['status']]}｜{state['task']}"


def write_terminal_title(title: str) -> None:
    try:
        with open("/dev/tty", "w", encoding="utf-8", errors="ignore") as tty:
            tty.write(f"\033]0;{title}\007")
            tty.flush()
    except OSError:
        pass


def webhook_url() -> str:
    configured = os.environ.get("CODEX_WEBHOOK_URL", "").strip()
    if configured:
        return configured
    try:
        script = Path(os.environ.get("CLAUDE_NOTIFY_SCRIPT", "~/.claude/notify.sh")).expanduser()
        match = re.search(r"curl .*?POST\s+'([^']+)'", script.read_text(encoding="utf-8"))
        return match.group(1) if match else ""
    except OSError:
        return ""


def send_codex_webhook(state: dict[str, Any]) -> None:
    if os.environ.get("AGENT_STATUS_DRY_RUN") == "1" or not state.get("unread"):
        return
    url = webhook_url()
    if not url:
        return
    lines = [f"[{dt.datetime.now():%Y-%m-%d %H:%M:%S}] {terminal_title(state)}"]
    if state.get("detail"):
        lines.append(f"详情: {state['detail']}")
    if state.get("cwd"):
        lines.append(f"目录: {state['cwd']}")
    payload = json.dumps({"msg_type": "text", "content": {"text": "\n".join(lines)}}, ensure_ascii=False)
    try:
        subprocess.Popen(
            [
                "curl", "-fsS", "--connect-timeout", "2", "--max-time", "5",
                "-X", "POST", url, "-H", "Content-Type: application/json", "-d", payload,
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError:
        pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", choices=("codex", "claude"), required=True)
    args = parser.parse_args()
    try:
        data = json.load(sys.stdin)
    except (ValueError, TypeError):
        data = {}

    state_dir = Path(os.environ.get("AGENT_STATUS_DIR", "~/.agent-status")).expanduser()
    state = update_state(args.source, data, state_dir)
    if state:
        write_terminal_title(terminal_title(state))
        if args.source == "codex":
            send_codex_webhook(state)

    # Both Codex Stop and Claude command hooks accept an empty JSON object as a no-op.
    print("{}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
