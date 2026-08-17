import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


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


if __name__ == "__main__":
    unittest.main()

