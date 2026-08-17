# Agent Status for Codex & Claude Code

一个运行在 VS Code 远程扩展宿主中的轻量状态插件，同时支持 Codex CLI 和 Claude Code。

## 功能

- 状态栏显示 Agent、任务简称和当前状态。
- 支持 `运行中`、`等待授权`、`等待输入`、`已完成`。
- 等待参与或完成时标记为未读。
- 切回对应工作区的 VS Code 窗口后自动标记已读。
- 可选重命名当前集成终端为 `Codex｜已读｜任务简称` 或 `Claude Code｜已读｜任务简称`。
- 多会话按 Agent 类型和会话 ID 隔离。

## 数据协议

Codex/Claude Code Hook 将状态原子写入远端主机的 `~/.agent-status/*.json`。扩展声明为 workspace extension，因此在 Remote SSH 场景下运行于远端，并直接监听该目录。

## 命令

- `Agent Status: Mark Relevant Tasks Read`
- `Agent Status: Show Tasks`
- `Agent Status: Clear Read Completed Tasks`

## 设置

- `agentStatus.stateDirectory`：状态目录，默认 `~/.agent-status`
- `agentStatus.markReadDelayMs`：窗口聚焦后确认已读的延迟，默认 1200 ms
- `agentStatus.renameActiveTerminal`：是否重命名活动终端
- `agentStatus.showStatusBar`：是否显示状态栏项目

## 构建

```bash
npm test
python3 test/test_hook.py
npm run package
```
