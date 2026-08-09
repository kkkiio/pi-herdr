# Agent Definitions

Agent definition 是带 YAML frontmatter 的 Markdown 文件。Frontmatter 描述模型和工具配置，正文追加到持久 Agent 的公共 system prompt，用于定义角色行为。

公共 system prompt 负责 Agent identity、`createdBy`、reply 规则、持久生命周期和禁止递归创建 Agent。角色正文不需要重复这些控制面约束。

## Bundled Definitions

pi-herdr 从 npm 包的 `agents/` 目录加载两个内置定义：

```text
agents/
├── explorer.md
└── general-purpose.md
```

这些 Markdown 是运行时资源，发布包必须显式包含 `agents/`。实现应通过 `import.meta.url` 定位包内目录，不能依赖当前工作目录。

推荐的 `package.json` 发布白名单：

```json
{
  "files": ["dist", "agents"]
}
```

发布前使用 `npm pack --dry-run` 验证两个定义都进入 tarball。

## Custom Definitions

自定义文件按以下优先级加载：

1. 项目级：`.pi/agents/<name>.md`
2. 工作区级：`.agents/agents/<name>.md`
3. 全局级：`~/.pi/agent/agents/<name>.md`
4. bundled：npm 包内 `agents/<name>.md`

高优先级的同名文件完整覆盖低优先级定义。文件名去掉 `.md` 后作为 `agent_type`，匹配时大小写不敏感。

## Format

```markdown
---
description: Read-only API compatibility reviewer
model:
  - gpt-5.6-luna
  - deepseek-v4-flash
thinking: low
max_turns: 20
tools: read, bash, grep, find, ls
inherit_context: false
enabled: true
---

你是一个专注于 API 兼容性的只读审查 Agent。
```

支持的字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `description` | string | 用于工具说明和角色列表的简短描述 |
| `model` | string / string[] | 固定模型或按顺序尝试的模型偏好列表 |
| `thinking` | string | 默认 thinking level |
| `max_turns` | number | 每次收到消息后的运行上限；`0` 表示不限制 |
| `tools` | CSV | 工作工具白名单；`*` 或 `all` 表示全部 |
| `extensions` | boolean / CSV | 普通扩展的继承方式 |
| `exclude_extensions` | CSV | 普通扩展黑名单 |
| `skills` | boolean / CSV | skills 的继承方式 |
| `disallowed_tools` | CSV | 从允许工具中移除的工具 |
| `inherit_context` | boolean | 创建 Agent 时是否 fork 创建者会话历史 |
| `isolated` | boolean | 是否只加载允许的内置工作工具 |
| `isolation` | `"worktree"` | 是否默认使用独立 worktree |
| `enabled` | boolean | `false` 时不允许创建该类型 |

生命周期和存储策略不是角色属性，因此不支持 `run_in_background`、`persist_session`、`session_dir` 或 `output_transcript`。

`ListAgents` 和 `SendMessage` 属于 spawned Agent 控制面，不受 `tools`、`extensions` 或 `isolated` 影响。`Agent` 和 pane 管理工具不提供给 spawned Agent。

## Model Resolution

模型选择优先级：

1. `Agent({ model })` 的单次覆盖。
2. 自定义 definition 的 `model`。
3. bundled definition 的 `model`。
4. Primary Agent 当前模型。

数组按顺序选择第一个已认证、位于 pi model registry 且符合 `enabledModels` 的模型。匹配 model ID 时把 `.` 与 `-` 视为等价；多个 provider 提供相同 ID 时使用 registry 中第一个可用项。

`explorer` bundled definition 优先使用 `gpt-5.6-luna` 和 `deepseek-v4-flash`。`general-purpose` 不指定模型，因此默认继承 Primary Agent 当前模型。

## Explorer Tools

`explorer` 获得 Bash，以便使用 `rg`、Git 查询、文件统计和其他适合批量分析的命令，但不获得 edit 或 write。角色正文明确要求 Bash 只用于读取和分析，不创建、修改或删除文件。

自定义 definition 可以调整工具范围；加载器和 `/agents` UI 应展示最终有效工具集，使权限变化可见。
