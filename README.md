# pi-herdr

![pi-herdr logo](assets/pi-herdr-logo.png)

pi-herdr 把 [herdr](https://herdr.dev) 原生的 live Agent 控制面接入 pi，让 Primary Agent 可以创建、发现和继续驱动独立 tab 中的持久后台 Agent。每个 Agent 使用正常落盘的 pi session，可以在 tab 存活期间长期空闲并反复复用；tab 或进程消失后，session 与可选 worktree 仍保留，但不再由 pi-herdr 自动恢复或管理。

pi-herdr 只在 `HERDR_ENV=1` 且当前 herdr socket 可用时注册控制面；普通终端中的 pi 会静默跳过该扩展。

## Installation

项目尚未发布到 npm。发布后可通过 pi 安装：

```bash
pi install @kkkiio/pi-herdr
```

## Usage

在 Primary Agent 中创建一个具名 Explorer：

```text
创建一个名为 code-explorer 的 explorer Agent，调查认证逻辑在哪里实现，并把结论回复给我。
```

`Agent` 工具会列出可直接使用的用户级与 bundled definitions。项目角色优先由 Primary 在目标仓库的 `.pi/agents/`、`.agents/agents/` 或项目 `AGENTS.md` 中发现，并把选中的 Markdown 路径显式传给 `definition`；找不到合适的项目角色时再使用 `explorer` 或 `general-purpose`。`definition` 只选择角色；需要在其他目录工作时通过独立的 `cwd` 指定。

Agent 回复后会保持 idle。需要继续调查时，Primary Agent 通过 `ListAgents` 找到它，再用 `SendMessage` 发送后续请求：

```text
让 code-explorer 再检查刷新令牌的错误处理，并回复新增发现。
```

关闭 Agent pane 或 tab 会停止该 live Agent。pi-herdr 保留其 pi session 和可选 worktree，但不会自动恢复；后续清理、合并或原生恢复由用户或 Primary Agent 使用 pi、Git 与 herdr 完成。

内置角色：

- `explorer`：只读搜索与代码定位，默认优先选择成本较低的可用模型。
- `general-purpose`：通用执行，可读取、创建和修改文件，初始模型继承 Primary Agent。

## Herdr RPC Support

下表描述 pi-herdr 如何使用与 Agent 生命周期相关的 herdr RPC。“不由插件暴露”表示 herdr 原生可能提供该能力，但 pi-herdr 不把它封装成 Agent 工具或自动行为。

| Herdr RPC | pi-herdr 工具或自动行为 |
| --- | --- |
| `agent.list` | `ListAgents`；返回 live herdr `AgentInfo` |
| `agent.get` | `SendMessage`、`StopAgent` 的目标解析与回执快照 |
| `agent.start` | `Agent`；在新 tab 的受管 pane 中启动交互式 pi |
| `agent.prompt` | `Agent` 的初始请求与 `SendMessage` |
| `agent.rename` | Spawned 模式监听 `/name` 后同步 live 路由名 |
| `tab.create` | `Agent`；共享当前 workspace 时创建 Agent tab |
| `tab.rename` | Spawned 模式监听 `/name` 后同步 tab label |
| `tab.close` | 仅用于 `Agent` 创建失败回滚 |
| `pane.current` | 识别调用者并阻止 `StopAgent` 关闭自身 |
| `pane.get` | 查询目标 runtime 与 tab/pane 关系 |
| `pane.close` | `StopAgent`；也用于 `Agent` 创建失败回滚 |
| `worktree.create` | `Agent({ isolation: "worktree" })`；直接复用返回的 tab/root pane |
| `worktree.remove` | 仅用于移除创建失败且仍安全的新 worktree |
| `events.subscribe` | 跟踪 live pane/tab、状态、rename 与名额释放 |
| `session.snapshot` | socket 重连后重新核对 live runtime；不恢复已消失 Agent |

以下相关 herdr 能力不由 pi-herdr 暴露：

| Herdr RPC | 边界 |
| --- | --- |
| 其余 `agent.*` | 除上表的 list/get/start/prompt/rename 外，不提供终端操控、等待、诊断或 Agent view 工具 |
| 其余 `tab.*` | 除创建与 name 同步、失败回滚外，不提供通用 tab 管理工具 |
| 其余 `pane.*` | 除调用者/目标查询、StopAgent 和失败回滚外，不提供任意输入、布局、移动或 metadata 管理 |
| `worktree.list`、`worktree.open`、常规 `worktree.remove` | 不负责已有 worktree 的合并、恢复或清理 |
| `events.wait` | 持久 Agent 使用事件订阅，不以 wait 结果表示生命周期结束 |
| `workspace.*` | 不提供通用 workspace 创建、关闭、聚焦或移动工具 |
| `layout.*`、`plugin.*`、`server.*`、`integration.*`、`notification.*`、`popup.*` | 与 pi-herdr Agent 控制面无关，不由插件封装 |

## Documentation

- [Agents](docs/agents.md) — Agent、StopAgent、生命周期与配置。
- [Messaging](docs/messaging.md) — `ListAgents`、`SendMessage` 与 reply envelope。
- [Agent definitions](docs/agent-definitions.md) — 项目路径、用户级与 bundled Agent Markdown。
- [Architecture](docs/architecture.md) — live runtime、单扩展双模式与 herdr 集成。
- [Architecture decisions](docs/adr/) — 关键设计选择及理由。
