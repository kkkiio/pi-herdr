# ADR-003: Agent Definitions and Single-extension Roles

- 状态：提议（Proposed）
- 日期：2026-08-09

## Context

pi-herdr 需要发布 Explorer 和 General Purpose 两个角色，并允许项目、workspace convention 和用户目录覆盖。角色配置必须可阅读、可验证，并映射到 pi 原生模型、工具、extensions 和 skills 能力。

Primary 与 Spawned 需要不同工具表面，但它们属于同一个 npm extension，不应被实现成两个独立 extension 包或互相漂移的入口。

## Decision

### 1. Markdown definitions

Bundled definitions 位于 npm 包的 `agents/` 目录，由 YAML frontmatter 和 Markdown body 组成。Body 追加到公共 Spawned system prompt，不替换 identity、reply、live lifecycle 和禁止递归 spawn 等控制面规则。

运行时通过 `import.meta.url` 定位 bundled 资源。未来 `package.json#files` 同时包含 `dist` 与 `agents`，发布检查断言两份 Markdown 进入 tarball。

### 2. Root and precedence

在 Git worktree 中，definition root 是 Primary 创建时的 Git top-level；非 Git 环境使用当前 cwd。优先级为：

1. `<root>/.pi/agents/<name>.md`
2. `<root>/.agents/agents/<name>.md`
3. `~/.pi/agent/agents/<name>.md`
4. bundled `agents/<name>.md`

文件名匹配大小写不敏感，同名高优先级文件完整覆盖低优先级文件。Definition 只在创建时解析，不热更新 live Agent。

### 3. Strict schema

支持字段只有：

| Field | Type |
| --- | --- |
| `description` | string |
| `model` | string / string[] |
| `thinking` | valid thinking string |
| `tools` | string[] |
| `extensions` | boolean / string[] |
| `skills` | boolean / string[] |
| `disallowed_tools` | string[] |
| `enabled` | boolean |

集合不接受 CSV。Extension/skill 数组中的相对路径以当前 definition 文件目录为基准。

未知字段、非法类型、非法值或同层级大小写重名会使当前选中的 definition 不可用并产生明确诊断，不回退低优先级同名文件。

Frontmatter 是封闭 schema，表格之外的字段全部报错。Agent 始终后台、使用全新持久 session；worktree 只由单次 `Agent` 参数决定。

### 4. One extension, two runtime roles

Primary 与 Spawned 显式加载同一个 pi-herdr extension。创建 Agent 时通过 extension flag/启动参数注入 Spawned role：

- Primary 注册 `Agent`、`StopAgent`、`ListAgents`、`SendMessage` 与 UI。
- Spawned 只注册 `ListAgents`、`SendMessage` 与 name 同步。

角色判断发生在同一个入口，不通过“工具可见但执行时报权限错误”模拟权限。普通 extension/skill 发现不能使 Spawned 获得 pi-herdr 的 Primary 工具。

### 5. Bundled resource policies

Explorer 使用 `tools: [read, bash, grep, find, ls]`、`extensions: false`、`skills: false`。特殊 pi-herdr extension 是创建命令显式加载的控制面，不受普通 extension discovery 开关影响。

General Purpose 使用 `tools: [all]`、`extensions: true`、`skills: true`，并遵循 pi 原生项目信任与资源发现规则。

`disallowed_tools` 映射到 pi 的工具 denylist。需要精确限制普通 extension 时使用显式 extensions allowlist。

## Alternatives

| Alternative | Why not chosen |
| --- | --- |
| TypeScript hardcode definitions | 不利于阅读、覆盖和 npm 资源验证 |
| Primary/Spawned 分成两个 extension | 容易造成协议、工具和版本漂移 |
| 所有 runtime 注册全部工具后运行时拒绝 | 模型仍能看到无权使用的 Agent/StopAgent，工具表面不真实 |
| CSV 与数组同时支持 | 扩大解析与诊断表面，没有未发布兼容需求 |
| Extension blacklist | 需要复制 pi 的 extension discovery，显式 allowlist 已能表达边界 |

## Consequences

### Positive

- 单入口确保消息、identity 和 rename 行为一致。
- Definition schema 小且严格，可直接映射 pi 原生启动参数。
- Bundled 与自定义角色使用相同解析路径。

### Negative

- 自定义 definition 的旧式 CSV 或未知字段会直接失败。
- General Purpose 加载普通 extensions/skills 时仍受用户项目信任与第三方资源质量影响。

### Unresolved

- 无。
