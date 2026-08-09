# Architecture

pi-herdr 把 Agent 建模为 herdr workspace 中可长期复用的独立 pi session。某个 Primary Agent 负责创建它，但创建关系不形成 Team、通信边界或默认 worktree 隔离。

## Runtime Structure

```text
Herdr workspace
├── Tab: primary
│   └── Pane: Primary pi session + pi-herdr supervisor
├── Tab: code-explorer
│   └── Managed pane
│       ├── createdBy: Primary
│       ├── shared workspace and cwd
│       ├── persistent pi session
│       └── agent extension
├── Tab: implementer
│   └── Managed pane
│       ├── createdBy: Primary
│       ├── persistent pi session
│       └── agent extension
└── Other tabs and reachable pi peers
```

一个长期 Agent 对应一个 herdr tab。tab 是用户看到、命名、聚焦和关闭的容器；tab 内的受管 pane 才是 pi 进程和 herdr Agent 状态的实际 endpoint。Agent 创建时 tab 只有一个受管 pane，用户之后在该 tab 中创建的其他 pane 不属于 Agent runtime。

Agent definition 只是角色模板。pi session name 是逻辑 Agent 的持久身份；运行时把它同步为 herdr Agent name 和 tab label。tab ID、pane ID、进程、cwd 和可选 worktree 是 runtime 信息。`createdBy` 用于追踪创建来源、恢复和管理权限，不用于决定 `ListAgents` 的可见范围。

pi session name 原生写入 session JSONL，并通过 `session_info_changed` 通知扩展。herdr 要求 name 在 live agents 中唯一，并用 name 或宿主 `pane_id` 解析所有 Agent 命令。pi-herdr 把 herdr 的格式与唯一性要求应用到 spawned Agent 的 pi session name，避免恢复时撞名。

## Components

建议实现保持少量深模块：

```text
src/
├── index.ts
├── agent-supervisor.ts
├── agent-registry.ts
├── agent-runtime.ts
├── agent-extension.ts
├── agent-definitions.ts
├── herdr-client.ts
├── tools.ts
└── ui.ts
```

- `index.ts`：扩展入口，只负责装配模块和注册生命周期。
- `agent-supervisor.ts`：创建、查找、恢复和停止 Agent，对外隐藏 tab、pane 与 session 时序。
- `agent-registry.ts`：以 pi session reference 为键持久化 `createdBy`、tab/pane runtime 引用和待投递消息；name 直接从 pi session 读取。
- `agent-runtime.ts`：启动或恢复 pi session，并向交互式 Agent 投递 prompt。
- `agent-extension.ts`：为被创建的 Agent 提供受限消息能力，并报告 session identity。
- `agent-definitions.ts`：发现、解析和合并 Markdown definition。
- `herdr-client.ts`：封装 socket RPC、事件订阅、重连和状态 reconciliation。
- `tools.ts`：注册 Primary 与 spawned Agent 各自可见的工具。
- `ui.ts`：widget、通知和 `/agents` 命令。

## Persistence

每个 Agent 使用普通持久 pi session。pi-herdr 另外保存一个 herdr session 范围的 registry：

```text
Herdr session
└── agents
    └── pi session reference
        ├── createdBy
        ├── definition name
        ├── pi session reference
        ├── current tab/pane/workspace/cwd
        ├── optional worktree provenance
        └── lifecycle state
```

Registry 不保存“任务结果”。Agent 的工作结论直接作为消息发送；只有暂时无法投递给持久 Agent 的消息需要等待 runtime 恢复。

Supervisor 启动或 socket 重连时：

1. 读取当前 herdr session 的 Agent registry。
2. 调用 herdr `agent.list` / `agent.get` 查询全部可达 runtime。
3. 从 pi session 读取 name，并将受管 pane 与 session reference 关联。
4. 已存在的 tab/pane 重新 attach；缺失的 runtime 标记为 `unavailable`。
5. 下一次向 unavailable Agent 发消息时，用原 session 创建新 tab 和 pane，并把 pi session name 重新绑定为 herdr name 与 tab label。

## Discovery

`ListAgents` 返回 herdr 当前可到达的全部 Agent 和 peer，并从 registry 补充 runtime 暂时 unavailable 的持久 Agent。Registry 同时提供 `createdBy` 和 session 信息；name 来自 pi session 与 herdr live alias，不按创建关系或 workspace 过滤结果。

工作目录和 worktree 只作为列表元数据，帮助调用方选择合适的 Agent。

## Runtime State

herdr 状态来自 tab 内的受管 pane，描述当前 Agent 活动，不代表逻辑 Agent 生命周期：

| herdr 状态 | pi-herdr 状态 | 处理方式 |
| --- | --- | --- |
| `working` | `working` | Agent 正在处理消息 |
| `blocked` | `blocked` | 等待批准或输入 |
| `idle` | `idle` | 可接收下一条消息 |
| `done` | `idle` | 后台工作已 settle、尚未被查看 |
| `unknown` | 保留最近状态或 `unavailable` | 不能据此判断成功 |

Supervisor 通过 socket 事件订阅更新状态，并在重连后主动 reconciliation。它不把一次 `agent.wait` 返回解释为 Agent 退出。

## Messaging

所有请求和结果都走同一个消息模型：

```text
sender -- SendMessage --> any reachable Agent or peer
       <-- reply -------
```

消息 envelope 包含 sender、reply 地址和 delivery mode。接收方不需要访问发送方 session 或 transcript。

## Worktrees

Agent 默认在创建者当前 workspace 中建立新 tab，并继承 cwd，不创建 worktree。只有 `Agent({ isolation: "worktree" })` 才先创建独立 worktree workspace，再在其中建立 Agent tab；该 worktree 在 Agent 空闲后继续保留。

关闭 runtime 时保留 session。移除带 worktree 的 Agent 时，如果存在未提交或未合并变更，操作必须保留现场并向用户说明。

## Safety Limit

系统不设置 active/running 并发限制。当前 herdr workspace 默认最多保留 16 个由 pi-herdr 创建的 Agent，防止循环 spawn 造成大量 tab、session 和模型调用。普通 peer 不计入这个上限。
