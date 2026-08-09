# ADR-001: Background Subagent Supervisor

- 状态：提议（Proposed）
- 日期：2026-08-09

## 上下文

pi-herdr 的 subagent 运行在独立 herdr pane 中。主 agent 通过 `Agent` 工具 spawn 一个子任务后，可以选择：

- **foreground**：阻塞等待结果；
- **background**：立即返回 agent ID，子 agent 在 pane 里继续运行，完成后再把结果送回主会话。

background 模式需要一个 supervisor 来完成两件事：

1. 可靠地检测子 agent 是否完成（或失败/被中止）。
2. 把结果以消息形式投递回主会话，触发主 agent 的新 turn。

## 参考

- [Claude Code Cross-Session Messaging](https://claudefa.st/blog/guide/mechanics/cross-session-messaging) — SendMessage / ListAgents、inbound 三态、跨会话消息设计
- [Claude Code Agent SDK (Python)](https://code.claude.com/docs/en/agent-sdk/python) — `Agent` 工具官方 schema
- [pi-subagents (@tintinweb)](https://github.com/tintinweb/pi-subagents) — 完成通知（customType + followUp + triggerTurn）、nudge 可取消、group join debounce
  - `src/index.ts` — `pi.sendMessage` 投递 + 200ms nudge hold
  - `src/agent-runner.ts` — in-memory session、session jsonl
- [pi-herdr-subagents (0xRichardH)](https://github.com/0xRichardH/pi-herdr-subagents) — herdr pane 内跑子代理、完成检测四路证据
  - `pi-extension/subagents/completion.ts` — exit sidecar / sentinel / pane status / jsonl 增量
  - `pi-extension/subagents/index.ts` — launch / watch / deliver 全流程
- [herdr](https://herdr.dev/docs/) — pane / agent / socket API；`agent wait` 等的是 semantic agent state，非进程退出
  - `docs/next/api/herdr-api.schema.json` — socket API schema
  - `skills/herdr/SKILL.md` — agent 生命周期状态（idle/working/blocked/done/unknown）

## 决策

### 1. 运行载体：herdr pane

每个 background subagent 都通过 herdr socket API 创建一个新 pane（`pane run` 或 `agent start`），在里面启动一个独立的 pi 会话。该 pane 对 user 可见但默认不聚焦（`--no-focus`），用户可以随时切进去观察或聊天。

### 2. 完成检测：两个信号

supervisor 判断 subagent 是否跑完主要看两个信号：

| 证据来源 | 判定依据 | 可信度 | 说明 |
| -------- | -------- | ------ | ---- |
| **herdr `agent.wait`** | `agent.wait` 返回，`agent_status` 为 `done` / `error` / `unknown` | 高 | 主证据；长轮询 RPC，agent settle 后返回 |
| **临时 session jsonl** | subagent 的临时 pi 会话文件出现新的 assistant 最终消息 | 高 | 跨进程结果传递；结果读出来后缓存到内存，临时文件保留 10 分钟用于排错 |

判定规则：

- `agent.wait` 返回且状态为 `done` / `error` 即视为完成。
- 状态为 `unknown` 时，检查临时 session jsonl；如果里面已经有新的 assistant 最终消息，也视为完成。
- 结果从临时 session jsonl 读取后缓存到 supervisor 内存；`get_subagent_result` 读内存，不依赖临时文件。
- 读取失败则标记为 `error`。

subagent 默认 non-persistent。只有 `persist_session: true` 时 session 文件才会长期保留并支持 `resume`。

### 3. Widget 状态更新

widget 状态尽量跟 herdr `agent list` / `agent.get` 返回的 `agent_status` 对齐，只在必要时做一层映射：

| herdr `agent_status` | widget 显示 | 含义 |
| -------------------- | ----------- | ---- |
| `idle` | `idle` | agent 没在干活；如果 subagent 还没结束，就是等下一轮输入 |
| `working` | `working` | agent 正在处理 |
| `blocked` | `blocked` | agent 被阻塞，等用户批准/回答 |
| `done` | `done` | agent 已经完成 |
| `unknown` | `unknown` | herdr 无法判断状态；supervisor 会检查临时 session jsonl，决定最终是 `done` 还是 `error` |
| （agent 还没被 herdr 识别） | `starting` | pane 刚创建，herdr 还没检测到 agent |
| （socket 断开） | `error` | 连接失败，无法继续观察 |

supervisor 每秒轮询一次 `agent.get` / `pane.get`，把 herdr 状态同步到 widget。轮询有 1s 左右延迟，但实现简单，断了就报错。

### 4. 结果投递：消息回主会话

完成并读取结果后，supervisor 调用：

```typescript
pi.sendMessage(
  {
    customType: "subagent_result",
    content: formattedResult,
    details: { agentId, status, toolUses, tokens, durationMs },
  },
  { deliverAs: "followUp", triggerTurn: true }
);
```

- `triggerTurn: true`：主 agent 空闲时立即开新 turn。
- `deliverAs: "followUp"`：主 agent 正在执行工具时，等当前工具结束后再交付，不打断现有工作。
- 通知延迟 200ms 发送；如果主 agent 在这期间用 `get_subagent_result` 消费了结果，则取消通知。

### 5. foreground 模式

foreground spawn 不经过 supervisor 的消息投递。父工具调用直接等待 pane  settle，并同步返回结果。

### 6. worktree 隔离

`isolation: "worktree"` 不自己调用 `git worktree`，而是复用 herdr 的 worktree 功能：

1. supervisor 通过 herdr socket API 调用 `worktree.create`，从当前 workspace 创建一个新 worktree 和一个新 workspace。
2. worktree branch 命名规则：
   - 默认：`pi-herdr/<agentId>`（例如 `pi-herdr/a1b2c3d4`）。
   - 如果调用方显式提供了合法的 `name`，可生成 `pi-herdr/<slug>-<agentId>`（例如 `pi-herdr/refactor-auth-a1b2c3d4`）。
   - 如果 branch 已存在，在 `agentId` 后追加 `-<n>`。
3. 在该新 workspace 中创建 pane 并启动 subagent。
4. subagent 完成后，根据是否有变更决定：
   - 有变更：保留 worktree/workspace，结果中返回 branch 名，供用户后续 merge。
   - 无变更：调用 `worktree.remove` 清理。

这样用户可以在 herdr sidebar 里直接看到隔离的 worktree workspace，且 herdr 负责 git worktree 的生命周期。

### 7. 失败/中止

- 用户按 Esc 或调用 `steer_subagent` 发送中止消息：子 agent 收到 steering 消息后自行结束当前 turn；`agent.wait` 返回或 sidecar 写入 `aborted` 后，supervisor 投递 `status: aborted`。
- `agent.wait` 因 socket 断开等原因失败：supervisor 把该 subagent 标记为 `error`，让 primary agent 决定下一步。
- pane 消失或 herdr 报告 `error`：投递 `status: error`，结果中携带最后可用输出。

### 8. 常量与默认值

参考 pi-subagents 的数值，采用以下默认值：

- `maxConcurrent`：4 个并发 background subagent。
- nudge hold：200ms，给 `get_subagent_result` 消费结果的时间窗口。
- grace turns：5（超过 `max_turns` 后的缓冲 turn 数）。

这些值在代码中作为常量存在，不暴露为配置文件。如需调整，再通过 frontmatter 或环境变量扩展。

### 9. Group join（并行 agent 批量通知）

参考 pi-subagents，同一 turn 内并行 spawn 的多个 background subagent 进入同一个 batch。supervisor 在第一个 agent 完成后启动 100ms debounce 窗口；窗口关闭时，如果该 batch 有 2 个或更多 agent 完成，则合并为一条 `subagent_result` 通知发回主会话。

- 每个 agent 的 `AgentRecord` 记录 `groupId`。
- 合并通知包含每个 agent 的摘要、状态、tool uses、tokens。
- 如果某 agent 已被 `get_subagent_result` 消费，则不加入该 batch 通知。
- `get_subagent_result` 消费单个 agent 结果同样会抑制该 batch 的合并通知中对应条目。

join mode 由 agent frontmatter 或调用参数决定：

| 模式 | 行为 |
| ---- | ---- |
| `async` | 始终单独通知 |
| `group` | 始终合并通知 |
| `smart`（默认）| 同 batch 完成数 >= 2 时合并，否则单独通知 |

```typescript
Agent({
  ...,
  join_mode?: "async" | "group" | "smart",
})
```

## 备选方案

| 方案 | 说明 | 未采纳原因 |
| ---- | ---- | ---------- |
| 同进程运行（pi-subagents 方式） | 在父 pi 进程里创建 `AgentSession`，不依赖 herdr | 失去 herdr pane UI、隔离、worktree 原生支持，违背项目初衷 |
| herdr CLI 作为核心接口 | 用 `herdr agent wait`、`herdr pane run` 等 CLI 命令 | CLI 输出是给人类看的文本，解析脆弱；频繁 fork 子进程开销大；无法做结构化请求 |
| 事件订阅驱动 | 用 `events.subscribe` 监听 `pane.agent_status_changed` | 需要维护订阅状态、重连后重新订阅；轮询 + `agent.wait` 更简单 |
| sidecar/sentinel 作为主要完成证据 | 要求 subagent 主动写 `.done.json` 或打印 sentinel | 增加 subagent 侧责任；持久 session jsonl + `agent.wait` 足够 |
| 跨 herdr session spawn | 把 subagent 放到另一个 herdr session 里 | 需要跨 session 发现和路由，复杂度明显高于同 session |

### 正面

- herdr pane 作为运行载体天然提供 UI、日志、用户介入能力。
- 多路证据避免单点误判（pane 残留、sidecar 未写、sentinel 丢失等情况）。
- `followUp + triggerTurn` 与 pi-subagents 一致，主 agent 无需轮询。

### 负面

- supervisor 需要维持一组 pane watcher，增加实现复杂度。
- 必须处理 herdr pane 状态与 pi 会话状态的时序差异（例如 pane 已 `done` 但 session jsonl 还没 flush）。

### 未解决

- 无。
