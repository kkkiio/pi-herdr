# ADR-003: Explicit Project Agent Definitions and Single-extension Roles

- 状态：已接受（Accepted）
- 日期：2026-08-09

## Context

pi-herdr 需要发布 Explorer 一个开箱即用角色，并允许用户维护全局角色。调用方还应能发现当前或外部仓库提供的项目级角色，再显式选择适合任务的角色定义和初始指令。角色配置必须可阅读、可验证，并映射到 Pi 原生模型、工具、extensions 和 skills 能力。省略 definition 时使用 Pi 默认配置，不为默认值包装一个“通用”角色。

所有 Herdr 内的 Pi 会话属于同一个 npm extension，不应被实现成多个独立 extension 包或互相漂移的入口。

## Decision

### 1. Markdown definitions

Bundled definitions 位于 npm 包的 `agents/` 目录,由 YAML frontmatter 和 Markdown body 组成。Body 追加到新 Agent 的 system prompt;生命周期与消息规则由控制工具的 description 与 `promptGuidelines` 承载。投递机制见 ADR-005。

运行时通过 `import.meta.url` 定位 bundled 资源。`package.json#files` 同时包含 `dist` 与 `agents`；发布冒烟（`test/verify-package.mjs`）在干净安装中加载 catalog，验证 bundled Explorer 随包可用。

### 2. Definition selector and catalog

`Agent` 使用可选的 `definition?: string`，不使用只能表达裸名称的 `agent_type`；省略时以 Pi 默认配置启动（行为见 §6）。Selector 有两种无歧义形式：

- 不包含路径分隔符且不以 `.md` 结尾的名称，从 `~/.pi/agent/agents`、bundled `agents` 依次解析。
- 以 `.md` 结尾的绝对路径或 `./`、`../` 显式相对路径，精确选择项目 definition；相对路径基于调用时的 cwd。

会话启动时把有效、启用的用户级与 bundled definitions 及其 description 写入 `Agent` 工具的 `definition` 参数说明，形成可按名称选择的 catalog；`definition` 本身保持开放字符串，以同时接受项目路径。用户级同名文件完整覆盖 bundled 文件；显式禁用或格式错误的用户级文件阻止该名称回退。Catalog 在会话重启时刷新，创建时仍重新读取选中的文件。

### 3. The caller discovers project definitions

pi-herdr 不根据当前 Git root 自动选择项目角色，也不扫描外部仓库。`Agent` tool guideline 推荐调用方在项目角色有帮助时，用普通文件与 Git 工具检查任务相关项目的 `.pi/agents` 与 `.agents/agents`，然后传入选中的明确路径；catalog definition 只在列出的角色恰好匹配任务时使用（如只读 Explorer 或用户自定义角色）；没有合适角色时省略 `definition`，使用 Pi 默认 agent。项目目录检查是推荐流程，不是创建前置条件。

路径只选择 definition，不推断 Agent workspace 或 cwd。`Agent({ cwd })` 独立选择实际工作目录；相对 definition path 和相对 cwd 分别基于调用时的 cwd 解析，二者不互相推导或校验。角色定义的来源项目与 Agent 实际工作的项目是两个独立概念。

### 4. Strict schema

支持字段只有：

| Field | Type |
| --- | --- |
| `description` | string |
| `model` | string / string[] |
| `thinking` | valid thinking string |
| `tools` | string[] |
| `extensions` | boolean |
| `skills` | boolean |
| `disallowed_tools` | string[] |
| `enabled` | boolean |

集合不接受 CSV。所有 definition 的 extension/skill 都只接受 boolean：`true` 保留新 Pi 对实际 cwd 的原生资源发现与 project trust，`false` 关闭发现。Definition 不接受具体资源列表，避免把资源路径转换为绕过新会话 cwd discovery 与 project trust 的显式 CLI 输入。

未知字段、非法类型或非法值会使当前选中的 definition 不可用并产生明确诊断。Catalog 的同一来源中出现大小写重名时，该名称不可用；显式路径不存在名称冲突或回退。

Frontmatter 是封闭 schema，表格之外的字段全部报错。Agent 始终后台、使用全新持久 session；worktree 只由单次 `Agent` 参数决定。

### 5. One extension, uniform surface

所有运行在 Herdr 中的 Pi 会话加载同一个 pi-herdr extension 并获得相同的控制表面：`Agent`、`ListAgents`、`ReadAgent`、`SendMessage` 与 `/agents`。创建 Agent 时不再注入角色标记；被创建的 Agent 与创建者能力相同，可以继续创建别的 Agent。

递归创建不做限制：实践中 Agent 没有主动递归创建的倾向，Herdr 平台自身也不限制 pane/agent 创建，适配层不替平台防这种事。普通 extension/skill 发现不改变 pi-herdr 自己的工具表面。

### 6. Bundled resource policies

Explorer 使用 `tools: [read, bash, grep, find, ls]`、`extensions: false`、`skills: false`。特殊 pi-herdr extension 是创建命令显式加载的控制面，不受普通 extension discovery 开关影响。

省略 definition 的 Agent 不传 `--tools`、`--no-extensions`、`--no-skills` 或 prompt 文件，完全使用 Pi 原生默认与项目信任规则。

显式 definition path 是 `Agent` 调用输入，不属于 Pi 自动发现资源。pi-herdr 不向调用方 prompt 注入 project trust 规则，不读取或写入 Pi trust 状态，也不传 `--approve` / `--no-approve`。每个新 Pi 根据自己的实际 cwd 正常执行 Pi 原生 project trust。

`disallowed_tools` 映射到 Pi 的工具 denylist。

## Alternatives

| Alternative | Why not chosen |
| --- | --- |
| TypeScript hardcode definitions | 不利于阅读、覆盖和 npm 资源验证 |
| 自动从当前 Git root 选择项目 definition | 不能发现任务相关的外部项目，并会让同名文件隐式改变启动配置 |
| pi-herdr 扫描已知仓库并维护项目 catalog | 重复调用方已有的文件搜索能力，还需要额外索引、缓存和刷新语义 |
| Definition 显式加载 extension/skill 列表 | 会把资源路径转换为绕过新会话 cwd discovery 与 project trust 的 CLI 输入 |
| 双角色(Primary/Spawned)工具表面 | 防的是实践中不发生的行为;Herdr 自身不限制递归创建,适配层不应比平台更严 |
| 所有 runtime 注册全部工具后运行时拒绝 | 模型仍能看到无权使用的 Agent，工具表面不真实 |
| CSV 与数组同时支持 | 扩大解析与诊断表面，没有未发布兼容需求 |

## Consequences

### Positive

- 单入口确保消息、identity 和工具行为一致。
- Definition schema 小且严格，可直接映射 Pi 原生启动参数。
- 调用方可以从任意任务相关仓库显式选择项目角色，没有隐式 root 覆盖。
- 用户级与 bundled catalog 保留开箱即用体验，新 Pi 的 cwd 继续使用原生 project trust。

### Negative

- 自定义 definition 的旧式 CSV 或未知字段会直接失败。
- Definition 不能固定具体 extension/skill 资源，必须依赖新会话 cwd 的原生发现。
- Definition catalog 只在会话启动时刷新，运行中新增的用户级 definition 不会立即进入参数说明。
- 省略 definition 的 Agent 加载普通 extensions/skills 时仍受用户项目信任与第三方资源质量影响。

### Unresolved

- 无。
