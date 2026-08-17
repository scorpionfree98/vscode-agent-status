import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "scripts" / "agent-status-hook.py"
SPEC = importlib.util.spec_from_file_location("agent_status_hook", SCRIPT)
HOOK = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(HOOK)


class HookTests(unittest.TestCase):
    def test_compact_task(self):
        self.assertEqual(HOOK.compact_task("请帮我配置 Codex 通知"), "配置 Codex 通知")

    def test_codex_lifecycle_preserves_task(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            started = HOOK.update_state("codex", {
                "hook_event_name": "UserPromptSubmit",
                "session_id": "s1",
                "cwd": "/work/repo",
                "prompt": "实现 VS Code 已读插件",
            }, root)
            self.assertEqual(started["status"], "running")
            self.assertFalse(started["unread"])

            completed = HOOK.update_state("codex", {
                "hook_event_name": "Stop",
                "session_id": "s1",
                "cwd": "/work/repo",
                "last_assistant_message": "完成",
            }, root)
            self.assertEqual(completed["task"], "实现 VS Code 已读插件")
            self.assertEqual(completed["status"], "completed")
            self.assertTrue(completed["unread"])

            saved = json.loads(next(root.glob("*.json")).read_text(encoding="utf-8"))
            self.assertEqual(saved["sessionId"], "s1")

    def test_extension_host_pid_walks_process_ancestry(self):
        with tempfile.TemporaryDirectory() as directory:
            proc = Path(directory)
            for pid, parent, command in [
                (20, 10, "sh -c hook"),
                (10, 2, "node bootstrap-fork --type=extensionHost"),
                (2, 1, "server-main"),
            ]:
                process = proc / str(pid)
                process.mkdir()
                (process / "cmdline").write_bytes(command.replace(" ", "\0").encode())
                (process / "stat").write_text(f"{pid} (process) S {parent} 0 0 0 0", encoding="utf-8")
            with mock.patch.object(HOOK.os, "getppid", return_value=20):
                self.assertEqual(HOOK.extension_host_pid(proc), 10)

    def test_ide_context_uses_vscode_ipc_socket(self):
        with mock.patch.dict(HOOK.os.environ, {"VSCODE_IPC_HOOK_CLI": "/tmp/vscode-ipc.sock"}):
            self.assertEqual(HOOK.ide_context_id(), "/tmp/vscode-ipc.sock")

    def test_claude_notification_needs_attention(self):
        status, unread, _ = HOOK.event_status("claude", {
            "hook_event_name": "Notification",
            "notification_type": "permission_prompt",
        })
        self.assertEqual(status, "waiting_permission")
        self.assertTrue(unread)

    def test_terminal_tty_is_recorded_and_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with mock.patch.object(HOOK, "controlling_tty", return_value="/dev/pts/42"):
                started = HOOK.update_state("codex", {
                    "hook_event_name": "UserPromptSubmit",
                    "session_id": "tty-session",
                    "cwd": "/work/repo",
                    "prompt": "终端绑定",
                }, root)
            self.assertEqual(started["terminalTty"], "/dev/pts/42")

            with mock.patch.object(HOOK, "controlling_tty", return_value=""):
                completed = HOOK.update_state("codex", {
                    "hook_event_name": "Stop",
                    "session_id": "tty-session",
                    "cwd": "/work/repo",
                }, root)
            self.assertEqual(completed["terminalTty"], "/dev/pts/42")

    def test_all_attention_and_lifecycle_events_have_expected_read_state(self):
        cases = [
            ({"hook_event_name": "UserPromptSubmit"}, "running", False),
            ({"hook_event_name": "PermissionRequest"}, "waiting_permission", True),
            ({"hook_event_name": "PreToolUse", "tool_name": "request_user_input"}, "waiting_input", True),
            ({"hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion"}, "waiting_input", True),
            ({"hook_event_name": "Notification", "notification_type": "permission_prompt"}, "waiting_permission", True),
            ({"hook_event_name": "Notification", "notification_type": "idle_prompt"}, "waiting_input", True),
            ({"hook_event_name": "PostToolUse"}, "running", False),
            ({"hook_event_name": "Stop"}, "completed", True),
            ({"type": "agent-turn-complete"}, "completed", True),
            ({"hook_event_name": "SessionEnd"}, "session_ended", False),
        ]
        for payload, expected_status, expected_unread in cases:
            with self.subTest(payload=payload):
                status, unread, _ = HOOK.event_status("codex", payload)
                self.assertEqual(status, expected_status)
                self.assertEqual(unread, expected_unread)

    def test_atomic_state_write_has_private_mode_and_no_temporary_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = HOOK.update_state("codex", {
                "hook_event_name": "UserPromptSubmit",
                "session_id": "../../unsafe/session",
                "cwd": "/work/repo",
                "prompt": "test atomic output",
            }, root)
            files = list(root.iterdir())
            self.assertEqual(len(files), 1)
            self.assertTrue(files[0].name.startswith("codex-"))
            self.assertNotIn("unsafe", files[0].name)
            self.assertEqual(os.stat(files[0]).st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(files[0].read_text())["sessionId"], "../../unsafe/session")
            self.assertEqual(state["task"], "test atomic output")

    def test_new_hook_transition_resets_previous_read_receipt_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = HOOK.update_state("codex", {
                "hook_event_name": "Stop", "session_id": "s2", "cwd": "/work/repo",
            }, root)
            state_file = next(root.glob("*.json"))
            first["unread"] = False
            first["readAt"] = "2026-08-17T00:00:00Z"
            HOOK.atomic_write(state_file, first)

            next_state = HOOK.update_state("codex", {
                "hook_event_name": "PermissionRequest", "session_id": "s2", "cwd": "/work/repo",
            }, root)
            self.assertTrue(next_state["unread"])
            self.assertIsNone(next_state["readAt"])


if __name__ == "__main__":
    unittest.main()
