# ADR-004: Herdr Socket Integration

- 状态：提议（Proposed）
- 日期：2026-08-09

## 上下文

pi-herdr 扩展需要和 herdr 交互来：

- 创建 pane 并启动 subagent。
- 等待 subagent 完成或失败。
- 查询 pane / agent 状态。
- 向运行中的 pane 发送 steering 消息。
- 创建/清理用于隔离的 git worktree。

herdr 提供两套接口：CLI wrappers 和 raw socket API。需要决定扩展主要用哪一套。

## 参考

- [herdr socket API docs](https://herdr.dev/docs/socket-api/)
  - `agent.list`, `agent.get`, `agent.wait`
  - `pane.split`, `pane.run`, `pane.get`, `pane.read`, `pane.send_text`
  - `worktree.create`, `worktree.remove`
- [herdr agent guide](https://herdr.dev/agent-guide.md) — 环境变量 `HERDR_SOCKET_PATH`、`HERDR_WORKSPACE_ID`、`HERDR_TAB_ID`、`HERDR_PANE_ID`
- [pi-herdr-subagents (0xRichardH)](https://github.com/0xRichardH/pi-herdr-subagents) — 通过 herdr CLI / socket 创建 tab、启动 pi 子会话、轮询完成

## 决策

### 1. 控制面用 raw socket API 作为 RPC client

pi-herdr 的核心控制面通过 herdr 的 raw socket API 实现，而不是 CLI wrappers。但**不把它当成事件总线**，而是当作一组请求/响应 RPC：每个操作发一个请求，等一个响应，出错就报错。

原因：

- **结构化响应**：socket 返回 JSON，直接解析 `pane_id`、`agent_status`、`workspace_id` 等字段；CLI 输出是给人类看的文本，解析脆弱。
- **低延迟**：spawn、steer、状态查询都是一次 request/response，不需要反复 fork 子进程。
- **复用现有连接**：socket 连接在 `session_start` 时建立，后续 RPC 复用同一条连接。
- **herdr 官方推荐**：socket API 文档明确说明，需要 direct request/response 时应使用 socket。

### 2. 完成检测用 `agent.wait`，不用事件订阅

background subagent 的完成检测不使用 `events.subscribe` 等持久订阅，而是对**每个 subagent 单独调用 `agent.wait`**：

```json
{"id":"wait_1","method":"agent.wait","params":{"pane_id":"w1:p2","until":"done","timeout_ms":0}}
```

- `agent.wait` 是 herdr 内置的长轮询 RPC，agent settle 后返回；从 supervisor 视角看就是一次会阻塞的 RPC 调用。
- 不需要维护 `events.subscribe` 的订阅状态，也不需要重连后重新订阅。
- socket 断开时，`agent.wait` 会报错，supervisor 把该 subagent 标记为 `error`，让 primary agent 决定下一步。

`agent.wait` 只是完成检测的**主证据**；sidecar 文件和 sentinel 仍作为辅助证据（见 ADR-001）。

### 3. CLI 作为调试和人工降级手段

CLI（`herdr agent list`、`herdr pane run` 等）保留用于：

- 一次性查询（如 `ListAgents` 工具可以快速走 CLI `--json`）。
- socket 不可用时的人为降级路径。
- 开发和本地调试。

当前不要求 socket 断开时无缝切换到 CLI；如果 socket 连接不上，扩展返回错误并提示用户检查 herdr 状态。

### 4. Socket client 设计

扩展内部实现一个轻量 TypeScript socket client：

- 读取 `HERDR_SOCKET_PATH`；若未设置，回退到 `~/.config/herdr/herdr.sock`。
- 使用 newline-delimited JSON over Unix domain socket / named pipe。
- 每个请求带唯一 `id`；服务端响应也带相同 `id`。
- 请求/响应一一对应；**不实现持久事件订阅**。
- 连接在 `session_start` 时建立，在 `session_shutdown` 时关闭。

### 5. 核心方法映射

| pi-herdr 功能 | herdr socket 方法 | 说明 |
| ------------- | ----------------- | ---- |
| 列出可到达会话 | `agent.list` | 返回 herdr 当前 workspace/agent 列表 |
| 创建 subagent pane | `pane.split` + `pane.run` 或 `agent.start` | 在新 pane 中启动 pi 子进程 |
| 等待 subagent 完成 | `agent.wait` | 长轮询 RPC，agent settle 后返回 |
| 查询 pane 状态 | `pane.get`, `agent.get` | 读 `agent_status`, `cwd`, `foreground_cwd` |
| 读取 pane 输出 | `pane.read` | 用于 sentinel 检测或提取结果 |
| 向 pane 发消息 | `pane.send_text` | 实现 `steer_subagent` |
| worktree 隔离 | `worktree.create`, `worktree.remove` | 复用 herdr 原生 worktree workspace |

### 6. 错误处理

- socket 连接失败：返回 `Herdr socket not available` 错误；核心路径上的关键调用（如 spawn）失败即失败。
- herdr 返回 `not_found` / `invalid_params`：直接透传给 LLM/user。
- `agent.wait` 因 socket 断开而失败：标记对应 subagent 为 `error`，primary agent 决定重试或放弃。
- pane 运行命令返回非零 exit code：supervisor 读 sidecar / sentinel 判定，不依赖 herdr 的进程退出码 alone。

### 7. 安全

- socket 是本地 Unix domain socket / named pipe，不暴露到网络。
- 只连接 `HERDR_SOCKET_PATH` 指向的当前 session socket，不跨 session 操作。
- 不通过 socket 发送用户凭证或敏感 prompt；只发送 herdr 控制命令和已脱敏的元数据。

## 后果

## 备选方案

| 方案 | 说明 | 未采纳原因 |
| ---- | ---- | ---------- |
| herdr CLI wrappers 作为核心接口 | 用 `herdr agent wait`、`herdr pane run` 等命令 | CLI 输出文本解析脆弱；频繁 fork 开销大；不如 socket 结构化 |
| socket 事件订阅驱动 | 用 `events.subscribe` 监听 pane/agent 状态变化 | 需要维护订阅列表和重连后重新订阅；`agent.wait` + 轮询更简单 |
| socket 断开后自动重连 | 断连时指数退避重试，恢复订阅和请求 | 重连后请求生命周期、订阅状态同步复杂；当前选择 fail-fast |
| socket client 作为独立 npm 模块发布 | 把 client 拆出去供其他扩展复用 | 用户明确不需要；当前内嵌在 pi-herdr 里 |
| 跨 herdr session 通信 | 通过不同 session socket 发现和操作 subagent | 需要跨 session 路由；当前限定在同一 herdr session |

### 正面

- 没有持久事件订阅，状态机简单；socket 断开只需报错，不需要复杂的重连/重新订阅逻辑。
- JSON 响应稳定，不容易被 herdr CLI 输出格式变化影响。
- 能直接复用 herdr 的 `worktree.*` 原生能力。

### 负面

- 每个 background subagent 都需要一个 `agent.wait` 长轮询连接/请求，数量等于并发 subagent 数。
- 状态查询需要自己轮询或调用 `agent.wait`，不能像事件订阅那样被动推送。
- 调试比 CLI 麻烦，需要额外日志记录 sent/received JSON。

### 未解决

- 是否需要在 socket 断开后自动重连？当前先不做；断开即报错，让 primary agent 决定。
