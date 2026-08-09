# ADR-004: Herdr Socket Integration

- 状态：提议（Proposed）
- 日期：2026-08-09

## 上下文

pi-herdr 需要通过 herdr 创建 Agent tab 与受管 pane、识别 Agent、投递 prompt、监听活动状态、恢复 runtime，并管理可选 worktree。

一次性 subagent 可以为每个进程调用一次 `agent.wait`；持久 Agent 会在 `working`、`blocked`、`idle` 之间多次切换，因此需要长期状态流和断线后的 reconciliation。

## 决策

### 1. Raw socket API 是核心控制面

扩展实现轻量、类型化的 herdr socket client，核心功能使用结构化 RPC 和事件订阅。CLI 只用于开发、人工调试和一次性诊断。

Socket client：

- 从 `HERDR_SOCKET_PATH` 连接当前 herdr server。
- 使用 newline-delimited JSON 和唯一 request ID。
- 同一连接复用普通 RPC 与事件订阅。
- 断线后重新连接、恢复订阅并触发 reconciliation。
- Primary session 切换时更新当前调用者 identity；Agent registry 保持 herdr session 范围。

不回退到猜测的默认 socket 路径，避免控制错误的 herdr session。

### 2. 每个 Agent 使用独立 tab

每个 Agent 创建一个独立 herdr tab，并在 tab 的初始 pane 中运行可以反复接收 prompt 的交互式 pi 进程。tab 是 Agent 的 UI 和资源容器，初始 pane 是受管 runtime endpoint。

创建 Agent 时：

1. 根据 isolation 设置选择当前 workspace 或创建 worktree workspace。
2. 验证 pi session name 符合 `[a-z][a-z0-9_-]{0,31}`，且没有 live 或 offline 持久 Agent 占用。
3. 创建不抢焦点、以 pi session name 标记的 tab。
4. 使用 `agent.start <name>` 在 tab 初始 pane 中启动带持久 session 和 agent extension 的 pi。
5. 等待 herdr 识别 Agent，并记录 native pi session reference。
6. 投递初始 prompt。

恢复 Agent 时使用 registry 保存的 pi session reference 打开同一个 session，从中读取 name，再创建 tab 并绑定 herdr Agent alias。

Agent extension 监听 pi 的 `session_info_changed`。合法且唯一的新 session name 同步到 `agent.rename` 和 `tab.rename`；无效或冲突的名字恢复为上一个有效 session name，并向用户显示错误。

### 3. 使用 Agent 输入接口投递消息

向 Agent 发送新请求优先使用 herdr 的 Agent prompt/input 接口，因为它会验证目标 pane 当前确实由 Agent 控制，并正确处理终端 paste/Enter 语义。

原始 `pane.send_text` 只用于明确需要终端级控制的降级或调试路径。

消息的 `steer` / `followUp` 语义由 agent extension 与 pi message queue 实现；herdr 负责把输入送到正确 runtime。

### 4. 事件订阅负责状态更新

Supervisor 订阅 `tab.closed`、`pane.agent_status_changed`、`pane.agent_detected`、`pane.closed` 和 `pane.exited`：

- `working`、`blocked` 直接更新 Agent 状态。
- `idle`、`done` 统一更新为 Agent `idle`。
- Agent tab 或受管 pane 退出时将 runtime 标记为 `unavailable`，但保留逻辑 Agent 和 session。
- `unknown` 不作为工作成功的证据。

不为每个 Agent 维持永久 `agent.wait`。`agent.wait` 可以用于创建和恢复过程中的一次性同步，但它的返回不代表 Agent 生命周期结束。

### 5. 重连与 reconciliation

Socket 断开不把所有 Agent 永久标记为 error。Supervisor 进入 disconnected 状态并进行有界重连；恢复连接后：

1. 重新订阅生命周期事件。
2. 调用 `agent.list` 获取当前 runtime 快照。
3. 使用 native session reference、tab ID、pane ID 和 workspace provenance 与 registry 匹配。
4. 更新 tab/pane runtime 引用并投递待处理消息。

无法重新匹配的 Agent 标记为 `unavailable`，等待下一条消息触发 session 恢复。

### 6. 核心方法映射

| pi-herdr 功能 | herdr 能力 |
| --- | --- |
| 创建 Agent 容器 | `tab.create`，然后在初始 pane 调用 `agent.start <name>` |
| 投递新请求 | Agent prompt/input API |
| steering 与终端控制 | Agent input；必要时 `pane.send_text` |
| 查询 runtime | `agent.list`、`agent.get`、`pane.get` |
| 监听状态 | `events.subscribe` + pane Agent lifecycle events |
| 读取诊断输出 | `pane.read` |
| worktree 生命周期 | `worktree.create`、`worktree.remove` |

### 7. 安全边界

- 只连接 herdr 注入的当前 socket。
- name 是首选 Agent target；pane ID 只作为当前 runtime fallback，tab ID 只用于 UI。
- `ListAgents` 返回 herdr 的全部可达结果；registry 只补充 pi-herdr 创建的 Agent metadata。
- agent extension 不暴露 spawn、remove 或任意 pane 控制能力。
- prompt 和消息内容只发送到目标 Agent，不写入 UI 元数据。

## 备选方案

| 方案 | 未采纳原因 |
| --- | --- |
| CLI wrappers 作为核心实现 | 频繁 fork、文本解析和长期状态监听都不适合扩展控制面 |
| 每个 Agent 永久 `agent.wait` | wait 观察的是当前语义状态，不表示持久 Agent 结束；每轮都需要重新武装 |
| 每秒轮询所有 pane | 空闲 Agent 长期存在时产生无意义请求，并引入固定延迟 |
| socket 断开即永久 error | 持久 session 的目标就是允许 runtime 和 supervisor 恢复 |
| 直接向 pane 写原始文本 | 可能把输入发送给已不再由目标 Agent 控制的终端 |

## 后果

### 正面

- 状态流与持久 Agent 模型一致，不混淆 idle 和退出。
- 重连后可以从 registry 与 herdr 快照恢复，而不依赖内存 watcher。
- Agent 输入接口减少终端状态和 prompt 投递错误。

### 负面

- Socket client 必须实现事件订阅、重连和 reconciliation。
- 需要正确处理 Primary session 切换与仍在后台运行的 Agent。

### 未解决

- 无。
