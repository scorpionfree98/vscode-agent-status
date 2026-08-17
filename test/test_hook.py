import importlib.util
import json
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


if __name__ == "__main__":
    unittest.main()
