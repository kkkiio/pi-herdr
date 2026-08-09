# Agent Definitions

Agent definition 是带 YAML frontmatter 的 Markdown 文件。Frontmatter 决定创建时的模型、工具和资源配置，正文追加到公共 Agent system prompt，用于定义角色行为。

Definition 只在 `Agent` 创建时解析。文件之后发生变化不会热更新已经 live 的 Agent。

## Selection and Discovery

`Agent({ definition })` 接受 catalog 名称或项目 definition 路径。

### Definition catalog

Primary 启动时，pi-herdr 从以下两个位置构建 definition catalog：

1. `~/.pi/agent/agents/<name>.md`
2. npm 包内 `agents/<name>.md`

用户级 definition 与 bundled definition 同名时完整覆盖 bundled definition，不做字段合并。显式禁用或格式错误的用户级 definition 同样保留该名字，不静默回退到 bundled 文件；它产生配置诊断且不能创建。Catalog 中每个有效、启用的名称和 description 会写入 `Agent` 工具的 `definition` 参数说明，让 Primary 直接选择，同时保留项目路径输入。Catalog 是当前 Primary 的工具表面，用户级目录变化后重新启动 Primary 才会刷新列表；实际创建时仍重新读取并严格校验选中的文件。

Catalog name 不包含 `/`、`\`，也不以 `.md` 结尾，匹配大小写不敏感。文件名去掉 `.md` 后是 definition name。

### Project paths

项目 definition 不进入全局 catalog，也不由 pi-herdr 自动扫描。需要项目专属角色时，推荐 Primary 使用普通文件搜索或 Git 查询检查任务相关仓库中的：

- `<project>/.pi/agents/*.md`
- `<project>/.agents/agents/*.md`

找到合适角色后，Primary 把绝对路径或以 `./`、`../` 开头的显式相对路径传给 `definition`。相对路径以 Primary 调用 `Agent` 时的 cwd 为基准；pi-herdr 规范化路径并要求目标是带 `.md` 后缀的普通文件。Definition 路径是精确选择，不参与 catalog 的覆盖或回退。没有合适项目角色时直接使用 catalog；项目目录检查不是创建前置条件。

Definition path 只决定角色配置，不隐式改变 Spawned Agent 的 workspace 或 cwd。`cwd` 是独立的 `Agent` 参数；它与相对 definition path 分别基于 Primary 调用时的 cwd 解析，二者不互相推导或校验。

## Format

```markdown
---
description: Read-only API compatibility reviewer
model:
  - gpt-5.6-luna
  - deepseek-v4-flash
thinking: low
tools:
  - read
  - bash
  - grep
  - find
  - ls
extensions: false
skills: false
enabled: true
---

你是一个专注于 API 兼容性的只读审查 Agent。
```

支持字段：

| Field | Type | Meaning |
| --- | --- | --- |
| `description` | string | 角色列表和 Agent 工具说明使用的简短描述 |
| `model` | string / string[] | 初始模型或按顺序尝试的候选列表 |
| `thinking` | string | 初始 thinking level |
| `tools` | string[] | 工作工具 allowlist；`[all]` 表示全部可用工作工具 |
| `extensions` | boolean | `true` 使用 Pi 原生发现，`false` 禁用 |
| `skills` | boolean | `true` 使用 Pi 原生发现，`false` 禁用 |
| `disallowed_tools` | string[] | 从最终工作工具中移除的工具 |
| `enabled` | boolean | `false` 时该角色不可创建 |

集合字段只接受 YAML 数组，不解析 CSV。所有来源的 `extensions` 与 `skills` 都只接受 boolean；`true` 不传显式资源或 `--no-*` flag，由 Spawned Pi 从实际 cwd 原生发现并应用 project trust，`false` 关闭对应发现。pi-herdr 不通过 definition 加载具体 extension 或 skill 路径。

Frontmatter 是封闭 schema，表格之外的字段全部报错。Worktree 是单次 `Agent` 调用的文件系统选择，不属于角色 definition。

## Runtime Roles and Resources

Primary 与 Spawned 运行同一个 pi-herdr extension。创建命令注入 Spawned role，使同一入口只注册 `ListAgents`、`SendMessage` 与 name 同步；无论 definition 如何配置普通 extensions，pi-herdr 都不会在 Spawned 模式注册 `Agent` 或 `StopAgent`。

Bundled explorer 使用明确的只读工具数组，并设置 `extensions: false`、`skills: false`。pi-herdr 的 Spawned 模式仍作为创建命令显式指定的 extension 加载，不属于“普通 extensions”发现范围。

Bundled general-purpose 使用 `tools: [all]`、`extensions: true`、`skills: true`，让 Pi 按原生信任与资源发现规则加载普通能力。

显式 definition path 本身是 `Agent` 的调用输入，不属于 Pi 自动发现的项目资源，也不经过 project trust。pi-herdr 不把 project trust 规则写入 Primary prompt，也不维护或覆盖 Pi 的 trust 决定。Spawned Pi 针对自己的实际 cwd 正常执行原生 project trust；启动参数不传 `--approve` 或 `--no-approve`。

## Model Resolution

模型在创建时按以下优先级解析：

1. `Agent({ model })` 显式参数。
2. 当前选中的 definition。
3. Primary 当前模型。

候选必须已经认证、存在于 Pi model registry，并符合当前 scoped/enabled models。ID 匹配把 `.` 与 `-` 视为等价；多个 provider 命中同一 ID 时使用 registry 顺序中的第一个可用项。

显式 `Agent({ model })` 候选全部不可用时创建失败。Definition 的默认候选全部不可用时静默继承 Primary 当前模型。

model 和 thinking 只是初始配置。Agent 启动后，用户通过 `/model` 或其他 Pi 原生能力进行的显式修改正常写入 session，后续消息继续使用新状态。

## Packaging

Bundled definitions 位于 npm 包根目录的 `agents/`：

```text
agents/
├── explorer.md
└── general-purpose.md
```

`package.json#files` 同时包含 `dist` 和 `agents`；运行时通过 `import.meta.url` 定位 bundled 目录。发布前使用 `npm run verify:package` 验证 Markdown 与编译入口进入 tarball。
