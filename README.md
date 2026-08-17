# Agent Status for Codex & Claude Code

一个运行在 VS Code 远程扩展宿主中的轻量状态插件，同时支持 Codex CLI 和 Claude Code。

## 功能

- 状态栏显示 Agent、任务简称和当前状态。
- 支持 `运行中`、`等待授权`、`等待输入`、`已完成`、`已中断` 和 `状态未知`。
- 等待参与或完成时标记为未读。
- 点击右下角状态可选择 session；终端会话切换到对应终端，Codex IDE 会话打开 Codex 侧栏。
- 当前 session 会固定显示；其他后台 session 的状态变化不会再抢占右下角状态。
- 手动切换集成终端时，会通过 TTY 反查并选中该终端中的 Codex/Claude Code session。
- 切回 VS Code 后只会自动读取当前终端对应的 session；IDE 会话必须在任务列表中点击，或执行显式已读命令，避免误读其他会话。
- 可选重命名匹配的集成终端为 `Codex｜已读｜任务简称` 或 `Claude Code｜已读｜任务简称`。
- 多会话按 Agent 类型、会话 ID、终端 TTY 和 VS Code IDE 上下文隔离；工作区匹配只接受当前工作区内部启动的任务，避免父目录任务泄漏到子工作区。
- Codex transcript 出现 turn abort 时显示 `已中断`；运行状态长时间未更新时显示 `状态未知`，不再永久卡在 `运行中`。

> Codex 扩展目前没有公开“按 session ID 打开指定 IDE 对话”的 VS Code 命令，因此 IDE 会话点击后会打开 Codex 侧栏，但不能保证自动选中那条历史对话。

## 数据协议

Codex/Claude Code Hook 将状态原子写入远端主机的 `~/.agent-status/*.json`。扩展把已读信息写入独立的 `*.json.read` 回执，避免已读操作覆盖 Hook 同时写入的新状态。扩展声明为 workspace extension，因此在 Remote SSH 场景下运行于远端，并直接监听该目录。

## 命令

- `Agent Status: Mark Selected Task Read`
- `Agent Status: Show Tasks`
- `Agent Status: Clear Read Completed Tasks`

## 设置

- `agentStatus.stateDirectory`：状态目录，默认 `~/.agent-status`
- `agentStatus.markReadDelayMs`：窗口聚焦后确认已读的延迟，默认 1200 ms
- `agentStatus.staleAfterMinutes`：运行状态多久未更新后显示为状态未知，默认 30 分钟
- `agentStatus.renameActiveTerminal`：是否重命名活动终端
- `agentStatus.showStatusBar`：是否显示状态栏项目

## 构建

```bash
npm test
python3 test/test_hook.py
npm run package
```
