# ADR-003: Agent Definitions and Discovery

- 状态：提议（Proposed）
- 日期：2026-08-09

## 上下文

pi-herdr 需要定义内置 agent，同时允许用户和项目自定义 agent。定义方式应尽可能复用 pi-subagents 已验证的 markdown + frontmatter 方案，减少新概念的引入。

## 参考

- [pi-subagents @tintinweb](https://github.com/tintinweb/pi-subagents)
  - `src/default-agents.ts` — 内置 `general-purpose`、`Explore`、`Plan`
  - `src/custom-agents.ts` — 从 `.pi/agents/*.md`、`.agents/agents/*.md`、`~/.pi/agent/agents/*.md` 加载
  - `src/types.ts` — `AgentConfig` 字段定义

## 决策

### 1. 内置 agent

pi-herdr 内置两个 agent：

- `explorer`：只读搜索 agent。
- `general-purpose`：通用执行 agent，可改文件。

它们 hardcoded 在扩展代码中，用户可通过同名自定义 markdown 文件覆盖。

### 2. 自定义 agent 发现路径

按优先级从高到低：

1. 项目级：`.pi/agents/<name>.md`
2. 工作区级：`.agents/agents/<name>.md`
3. 全局级：`~/.pi/agent/agents/<name>.md`

项目级覆盖工作区级和全局级；工作区级覆盖全局级；同名文件覆盖内置 agent。

### 3. Markdown 文件格式

文件包含 YAML frontmatter + Markdown body。Body 作为 system prompt。

```markdown
---
model: deepseek/deepseek-v4-flash
thinking: low
max_turns: 20
tools: read, bash, grep, find, ls
inherit_context: false
run_in_background: false
isolated: false
---

你是一个专注于 API 兼容性的只读审查 agent。
```

### 4. 支持的 frontmatter 字段

复用 pi-subagents 的字段，去除当前不需要的项：

| 字段 | 类型 | 说明 |
| ---- | ---- | ---- |
| `model` | string / string[] | 默认模型，如 `deepseek/deepseek-v4-flash`；数组表示偏好列表 |
| `thinking` | string | `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` |
| `max_turns` | number | 0 表示无限制 |
| `tools` | CSV | 内置工具白名单；`*` 或 `all` 表示全部 |
| `extensions` | boolean / CSV | `true` 继承全部；`false` 或 `none` 不给扩展；CSV 为允许列表 |
| `exclude_extensions` | CSV | 扩展黑名单 |
| `skills` | boolean / CSV | 同 `extensions` |
| `disallowed_tools` | CSV | 即使 `tools` 包含也要移除的工具 |
| `inherit_context` | boolean | 是否 fork 父会话历史 |
| `run_in_background` | boolean | 是否默认后台运行 |
| `isolated` | boolean | 是否只给内置工具 |
| `isolation` | `"worktree"` | 是否在临时 git worktree 中运行 |
| `persist_session` | boolean | 是否落盘会话；默认 `false`（non-persistent），`true` 时支持 `resume` |
| `session_dir` | string | 自定义会话目录；默认 `.pi/subagents/` |
| `output_transcript` | boolean | 是否写 `.output` transcript |
| `enabled` | boolean | `false` 禁用该 agent |

### 5. 命名与匹配

- 文件名（不含 `.md`）作为 `subagent_type` 名称，大小写不敏感匹配。
- 自定义 `explorer.md` 覆盖内置 `explorer`；自定义 `general-purpose.md` 覆盖内置 `general-purpose`。
- 命名冲突时，先匹配项目级，再工作区级，再全局级，最后内置。

### 6. 无 JSON 配置文件

所有 per-agent 配置都走 markdown frontmatter。全局行为（如并发数）如需调整，也优先通过扩展自己的代码常量 + 环境变量处理，不引入 `.pi/herdr.json`。

### 7. 子 session 不加载 pi-herdr 扩展

subagent 的 pi 进程默认不加载 pi-herdr 扩展，因此子 agent 没有 `Agent` / `get_subagent_result` / `steer_subagent` / `ListAgents` / `SendMessage` 工具。这样实现两层效果：

- **防止自繁殖**：subagent 不能再 spawn 新的 subagent，避免无限递归。
- **最小工具集**：子 agent 只拿到它自己的 agent frontmatter 允许的工具，不会意外调用 pi-herdr 的控制面。

如果需要让 subagent 也能 spawn subagent（嵌套），需要显式开启并重新设计；本设计不做。

## 后果

## 备选方案

| 方案 | 说明 | 未采纳原因 |
| ---- | ---- | ---------- |
| JSON 配置文件（如 `.pi/herdr.json`） | 把 agent 配置、模型偏好、常量都放在一个 JSON 里 | 用户希望配置走 `.pi/agents/` / `.agents/agents/` / `~/.pi/agent/agents/` 的 markdown frontmatter |
| 只支持 `.pi/agents/` | 跟 pi 生态一致 | 用户希望支持跨项目共享的 `.agents/agents/` workspace |
| 只支持 `.agents/agents/` | 避免 `.pi` 目录 | 跟 pi-subagents 不一致，且项目级特化配置也是合理需求 |
| 内置 `Plan` agent | 跟 pi-subagents 一样内置三个默认 agent | 用户明确只要 `explorer` 和 `general-purpose` |
| 支持嵌套 subagent（`allowed_subagents`） | 让 subagent 也能 spawn subagent | 增加 supervisor 和工具所有权复杂度；当前设计不做 |
| 支持 `memory` 持久化记忆 | 跟 pi-subagents 的 `memory` 字段 | Claude Code 没有这个概念，且增加目录管理复杂度 |

### 正面

- 与 pi-subagents 对齐，用户迁移成本低。
- 同时支持项目级 `.pi/agents/` 和工作区级 `.agents/agents/`，兼顾项目特化与跨项目共享。
- 自定义 agent 可完全覆盖内置 agent，灵活度高。

### 负面

- 同时扫描 `.pi/agents/` 和 `.agents/agents/` 两处路径，加载逻辑比 pi-subagents 略复杂。
- frontmatter 字段较多，需要文档和校验错误提示。

### 未解决

- 无。
