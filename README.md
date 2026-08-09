# pi-herdr

![pi-herdr logo](assets/pi-herdr-logo.png)

pi-herdr 把 [Herdr](https://herdr.dev) 原生的 live Agent 控制面接入 Pi，让 Primary Agent 可以创建、发现和继续驱动独立 tab 中的持久后台 Agent。每个 Spawned Agent 使用正常落盘的 Pi session；只要 pane 仍然 live，它就能保留上下文并反复接收任务。

当前实现可从源码安装，尚未发布到 npm。它面向 Herdr 0.7.5、socket protocol 17；在普通终端中启动 Pi 时，扩展不会注册 Herdr 控制面。

## Installation

先安装 [Herdr 0.7.5](https://github.com/herdrdev/herdr/releases/tag/v0.7.5)、Pi 0.83 或更高版本与 Node.js 22.19 或更高版本，再安装当前源码：

```bash
git clone https://github.com/kkkiio/pi-herdr.git
cd pi-herdr
npm ci
npm run build
pi install .
```

## Usage

从目标项目目录启动 Herdr：

```bash
herdr
```

在 pane 中运行 Pi：

```bash
pi
```

然后直接让 Primary 创建一个具名 Agent：

```text
创建一个名为 code-explorer 的 explorer Agent，调查认证逻辑在哪里实现，并把结论回复给我。
```

`Agent` 工具会列出可直接使用的用户级与 bundled definitions。需要项目专属角色时，推荐 Primary 检查目标仓库的 `.pi/agents/` 和 `.agents/agents/`，并把选中的 Markdown 路径显式传给 `definition`；没有合适角色时再使用 `explorer` 或 `general-purpose`。`definition` 只选择角色，需要改变工作目录时使用独立的 `cwd`。

Agent 回复后会保持 idle。继续使用同一上下文时，再告诉 Primary：

```text
让 code-explorer 再检查刷新令牌的错误处理，并回复新增发现。
```

内置 `explorer` 适合只读搜索与代码定位；`general-purpose` 适合实现、测试和开放式调查。关闭 Agent pane 或 tab 会结束 pi-herdr 对该 live runtime 的管理，但 Pi session 与可选 worktree 会保留，供用户通过 Pi、Git 和 Herdr 原生管理。

## Herdr RPC Support

pi-herdr 只把 `Agent`、`StopAgent`、`ListAgents` 和 `SendMessage` 暴露给 Pi；下列 Herdr RPC 是这些工具及其生命周期管理所依赖的控制面。

| Herdr RPC                               | pi-herdr 行为                                                             |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `ping`, `session.snapshot`              | 读取 Herdr version、校验 protocol 17，并在启动与重连时核对 live runtime   |
| `agent.list`, `agent.get`               | `ListAgents`、目标解析、启动就绪检查与回执快照                            |
| `tab.create`                            | 在解析后的 `cwd` 创建不抢焦点的共享 workspace Agent tab                    |
| `worktree.create`, `tab.rename`         | 从解析后的 `cwd` 创建 checkout，并显式同步返回 tab 的名称                   |
| `agent.start`, `agent.prompt`           | 启动持久 Pi session；确认交互就绪后发送初始请求与后续消息                 |
| `agent.rename`, `tab.get`, `tab.rename` | Spawned Agent 执行 `/name` 后同步 live route 与 tab label，并在失败时恢复 |
| `pane.current`                          | 识别调用者 pane，阻止 `StopAgent` 关闭自身                                |
| `pane.close`                            | `StopAgent` 与创建失败后的精确 pane 清理                                  |
| `tab.close`, `worktree.remove`          | 仅回滚本次失败创建的 tab/worktree，不清理既有用户资源                     |
| `events.subscribe`                      | 使用专用长连接跟踪 live pane、tab 和 Agent 状态；普通 RPC 不复用该连接    |

其余 workspace、tab、pane、terminal input、layout、worktree 管理及 `events.wait` 等 Herdr 能力不由 pi-herdr 封装。详细边界见 [Architecture](docs/architecture.md) 与 [Agents](docs/agents.md)。

## Documentation

- [Agents](docs/agents.md) — `Agent`、`StopAgent`、name、tab 与生命周期。
- [Messaging](docs/messaging.md) — `ListAgents`、`SendMessage` 与 reply envelope。
- [Agent definitions](docs/agent-definitions.md) — 项目路径、用户级与 bundled Agent Markdown。
- [Architecture](docs/architecture.md) — runtime 边界、socket 协议和创建事务。
- [Architecture decisions](docs/adr/) — 已接受的关键设计选择及理由。
