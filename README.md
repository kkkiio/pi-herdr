# pi-herdr

![pi-herdr logo](assets/pi-herdr-logo.png)

pi-herdr 为运行在 [herdr](https://herdr.dev) 中的 pi 提供持久后台 Agent 和跨会话消息通信。每个 Agent 拥有独立 tab 和上下文，在空闲后可以继续通过消息复用，而不是为每次工作启动一个一次性进程。

pi-herdr 只在 herdr 环境中启用（`HERDR_ENV=1`）。

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

Agent 回复后会保持空闲。需要继续调查时，Primary Agent 通过 `ListAgents` 找到它，再用 `SendMessage` 发送后续请求：

```text
让 code-explorer 再检查刷新令牌的错误处理，并回复新增发现。
```

内置角色：

- `explorer`：只读搜索与代码定位，默认优先选择成本较低的可用模型。
- `general-purpose`：通用执行，可读取、创建和修改文件，默认继承 Primary Agent 的模型。

## Documentation

- [Agents](docs/agents.md) — Agent API、生命周期与复用方式。
- [Messaging](docs/messaging.md) — `ListAgents`、`SendMessage` 与 reply 语义。
- [Agent definitions](docs/agent-definitions.md) — bundled 与自定义 Agent Markdown。
- [Architecture](docs/architecture.md) — runtime、持久化和 herdr 集成。
- [Architecture decisions](docs/adr/) — 关键设计选择及理由。
