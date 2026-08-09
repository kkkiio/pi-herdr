# ADR-003: Agent Definitions and Discovery

- 状态：提议（Proposed）
- 日期：2026-08-09

## 上下文

pi-herdr 需要提供 Explorer 和 General Purpose 两个内置角色，同时允许项目、工作区和用户覆盖角色。角色定义应该是可发布、可阅读的资源，不应散落在 TypeScript 字符串中。

持久 Agent 还需要一组公共协作规则。角色 prompt 与控制面 prompt 必须分离，避免自定义 definition 意外删除 identity、reply 和生命周期约束。

## 决策

### 1. Bundled definition 使用 Markdown 文件

npm 包根目录包含：

```text
agents/
├── explorer.md
└── general-purpose.md
```

文件由 YAML frontmatter 和 Markdown body 组成。Body 追加到公共 Agent system prompt，而不是替换整个 system prompt。

公共 prompt 负责：

- 当前 Agent identity 和 `createdBy`。
- sender 与 reply 地址的使用方法。
- 完成当前请求后回复并保持 idle。
- 禁止创建下级 Agent 或管理其他 Agent runtime。

角色 body 只描述专业职责、工作方式和输出要求。

### 2. npm 明确包含资源

`package.json` 的 `files` 白名单包含 `dist` 与 `agents`。运行时通过 `import.meta.url` 定位 `agents/`，不依赖调用者 cwd。

CI 使用 `npm pack --dry-run` 或 `npm pack --json` 断言以下路径存在：

```text
package/agents/explorer.md
package/agents/general-purpose.md
```

### 3. 自定义 definition 发现顺序

优先级从高到低：

1. `.pi/agents/<name>.md`
2. `.agents/agents/<name>.md`
3. `~/.pi/agent/agents/<name>.md`
4. npm 包内 `agents/<name>.md`

同名高优先级文件完整覆盖低优先级定义。文件名是 `agent_type`，匹配时大小写不敏感。

### 4. Frontmatter 字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `description` | string | 角色列表和工具 schema 使用的描述 |
| `model` | string / string[] | 固定模型或偏好列表 |
| `thinking` | string | 默认 thinking level |
| `max_turns` | number | 每条入站消息触发运行时的 turn 上限 |
| `tools` | CSV | 工作工具白名单 |
| `extensions` | boolean / CSV | 普通扩展继承策略 |
| `exclude_extensions` | CSV | 普通扩展黑名单 |
| `skills` | boolean / CSV | skills 继承策略 |
| `disallowed_tools` | CSV | 工作工具黑名单 |
| `inherit_context` | boolean | 创建时是否 fork Primary 会话历史 |
| `isolated` | boolean | 是否只加载允许的内置工作工具 |
| `isolation` | `"worktree"` | 是否默认使用 Agent 专属 worktree |
| `enabled` | boolean | 是否允许创建该角色 |

所有 Agent 都是后台且持久的，因此不支持 `run_in_background`、`persist_session`、`session_dir` 和 `output_transcript`。

### 5. Spawned Agent 加载受限协作扩展

通过 `Agent` 工具创建的 pi 进程加载专用 agent extension。无论 definition 如何限制工作工具，它始终提供：

- `ListAgents`
- `SendMessage`

它不提供：

- `Agent`
- stop/remove Agent runtime 的能力
- Primary 专用 UI 和 supervisor 控制工具

这样 Agent 可以发现所有 herdr 可达会话、直接回复和协作，但不能递归创建下级 Agent。

### 6. Explorer 保留 Bash

Bundled Explorer 获得 Bash、read、grep、find 和 ls，以支持 `rg`、Git 查询、文件统计和批量分析；它不获得 edit 或 write。角色正文要求 Bash 只用于读取和分析，不创建、修改或删除文件。

用户可以通过同名自定义 Markdown 调整工具范围；加载器和 `/agents` UI 必须展示最终有效工具集，使权限变化可见。

## 备选方案

| 方案 | 未采纳原因 |
| --- | --- |
| 在 TypeScript 中 hardcode 两个角色 | 难以阅读、发布验证和被普通 Markdown 覆盖 |
| definition 替换完整 system prompt | 自定义角色可能丢失消息、身份和生命周期协议 |
| Spawned Agent 完全不加载 pi-herdr | 无法使用 `ListAgents` 和 `SendMessage`，与复用和直接回复目标冲突 |
| 给 spawned Agent 加载完整控制面 | 会允许递归创建和操作其他 Agent runtime |
| 为了绝对只读而移除 Bash | 会明显妨碍代码搜索、Git 调查和批量文件分析 |

## 后果

### 正面

- Bundled 和自定义角色使用同一格式与解析路径。
- 角色 prompt 与团队协议分离，覆盖 definition 不破坏控制面。
- npm tarball 可以直接检查实际发布的 Agent 定义。

### 负面

- 构建和发布流程必须显式携带非 TypeScript 资源。
- 需要维护 Primary extension 与 agent extension 两套工具表面。

### 未解决

- 无。
