# Agent Definitions

Agent definition 是带 YAML frontmatter 的 Markdown 文件。Frontmatter 决定创建时的模型、工具和资源配置，正文追加到公共 Agent system prompt，用于定义角色行为。

Definition 只在 `Agent` 创建时解析。文件之后发生变化不会热更新已经 live 的 Agent。

## Discovery

pi-herdr 先确定 Primary 创建时的 definition root：位于 Git worktree 中时使用 `git rev-parse --show-toplevel` 的结果，否则使用当前 cwd。随后按以下优先级查找：

1. `<root>/.pi/agents/<name>.md`
2. `<root>/.agents/agents/<name>.md`
3. `~/.pi/agent/agents/<name>.md`
4. npm 包内 `agents/<name>.md`

文件名去掉 `.md` 后作为 `agent_type`，匹配大小写不敏感。高优先级文件完整覆盖低优先级定义，不做字段合并。

同一层级出现大小写重名、选中的文件包含未知字段、类型错误或非法值时，该 definition 不可用并产生明确诊断；pi-herdr 不回退到低优先级同名文件，避免配置错误静默改变角色或权限。

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
| `extensions` | boolean / string[] | `true` 发现普通 extensions，`false` 禁用，数组显式加载指定资源 |
| `skills` | boolean / string[] | `true` 发现 skills，`false` 禁用，数组显式加载指定资源 |
| `disallowed_tools` | string[] | 从最终工作工具中移除的工具 |
| `enabled` | boolean | `false` 时该角色不可创建 |

集合字段只接受 YAML 数组，不解析 CSV。`extensions` 与 `skills` 数组中的相对路径以当前选中的 definition 文件目录为基准；绝对路径保持不变。

Frontmatter 是封闭 schema，表格之外的字段全部报错。Worktree 是单次 `Agent` 调用的文件系统选择，不属于角色 definition。

## Runtime Roles and Resources

Primary 与 Spawned 运行同一个 pi-herdr extension。创建命令注入 Spawned role，使同一入口只注册 `ListAgents`、`SendMessage` 与 name 同步；无论 definition 如何配置普通 extensions，pi-herdr 都不会在 Spawned 模式注册 `Agent` 或 `StopAgent`。

Bundled explorer 使用明确的只读工具数组，并设置 `extensions: false`、`skills: false`。pi-herdr 的 Spawned 模式仍作为创建命令显式指定的 extension 加载，不属于“普通 extensions”发现范围。

Bundled general-purpose 使用 `tools: [all]`、`extensions: true`、`skills: true`，让 pi 按原生信任与资源发现规则加载普通能力。

## Model Resolution

模型在创建时按以下优先级解析：

1. `Agent({ model })` 显式参数。
2. 选中的自定义 definition。
3. bundled definition。
4. Primary 当前模型。

候选必须已经认证、存在于 pi model registry，并符合当前 scoped/enabled models。ID 匹配把 `.` 与 `-` 视为等价；多个 provider 命中同一 ID 时使用 registry 顺序中的第一个可用项。

显式 `Agent({ model })` 候选全部不可用时创建失败。Definition 的默认候选全部不可用时静默继承 Primary 当前模型。

model 和 thinking 只是初始配置。Agent 启动后，用户通过 `/model` 或其他 pi 原生能力进行的显式修改正常写入 session，后续消息继续使用新状态。

## Packaging

Bundled definitions 位于 npm 包根目录的 `agents/`：

```text
agents/
├── explorer.md
└── general-purpose.md
```

未来 `package.json#files` 必须同时包含 `dist` 和 `agents`；运行时通过 `import.meta.url` 定位 bundled 目录。发布前使用 `npm pack --dry-run` 或 `npm pack --json` 验证两份 Markdown 进入 tarball。
