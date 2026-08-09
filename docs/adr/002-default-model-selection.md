# ADR-002: Subagent Default Model Selection

- 状态：提议（Proposed）
- 日期：2026-08-09

## 上下文

subagent 的默认模型如果简单继承主 agent 当前模型，容易在用户不知情的情况下烧掉高价模型 token。例如主 agent 使用 `claude-opus-4-7` 时，一个只读搜索 subagent 也跑 opus 会造成明显浪费。

本 ADR 规定 `explorer` 和 `general-purpose` 两个内置 subagent 的默认模型策略，以及用户覆盖方式。

关键设计：**`model` 字段同时支持单个字符串和有序数组**。数组表示“偏好列表”，按顺序选择第一个可用模型；与 pi-subagents 只支持单字符串的 `model` 相比，这是 pi-herdr 的扩展。

## 参考

- [pi-subagents @tintinweb](https://github.com/tintinweb/pi-subagents)
  - `src/model-resolver.ts` — fuzzy model resolution、provider fallback、`.`/`-` 等价
  - `src/agent-runner.ts` — `resolveDefaultModel`（config.model → parent model）
  - `src/enabled-models.ts` — 读取 pi 的 `enabledModels` 并校验
- pi-ai 内置模型数据（`@earendil-works/pi-ai`）
  - `gpt-5.6-luna` 出现在 `opencode-go/openai-responses`、`opencode/openai-responses`
  - `deepseek-v4-flash` 出现在 `deepseek/openai-completions`、`opencode-go/openai-completions`、`opencode/openai-completions`

## 决策

### 1. `model` 字段支持数组

`model` 可以是：

- 单个字符串，如 `deepseek/deepseek-v4-flash`。
- 有序数组，如 `[gpt-5.6-luna, deepseek-v4-flash]`。

解析规则：

1. 如果是数组，按顺序尝试每个条目，第一个“可用”的即为 effective model。
2. 如果全部不可用，或未设置 `model`，回退到主 agent 当前模型。
3. 回退与 pi-subagents 的 `resolveDefaultModel` 行为一致：静默继承父模型，不弹出额外警告。

### 2. `explorer` 默认模型

`explorer` 是只读搜索 agent，bundled 默认 `model` 为数组：

```yaml
model:
  - gpt-5.6-luna
  - deepseek-v4-flash
```

选择顺序：

1. `Agent({ model: "..." })` 或 `Agent({ model: ["...", "..."] })`。
2. 自定义 `explorer.md` frontmatter 里的 `model`（字符串或数组）。
3. 内置默认数组。
4. 继承主 agent 当前模型。

### 3. `general-purpose` 默认模型

`general-purpose` 执行复杂任务、可能改文件，默认需要与主 agent 同等级的能力。因此：

- bundled `general-purpose` 不设置默认 `model`，即继承父模型。
- 可通过 `Agent({ model: "..." })` 或数组单次覆盖。
- 可通过自定义 frontmatter `model` 覆盖。

### 4. 自定义 agent 模型策略

自定义 agent 与内置 agent 使用同一套规则：

- frontmatter 里 `model` 为字符串 → 固定使用该模型。
- frontmatter 里 `model` 为数组 → 按偏好列表选择。
- frontmatter 里不写 `model` → 继承父模型。

这样任何自定义 agent 都可以复用“偏好列表”策略，不需要单独的 `preferred_models` 字段。

### 5. “可用”的定义

- 该模型在 pi 的 model registry 中，且用户已完成认证/登录（`registry.getAvailable()` 包含它）。
- 如果用户在 pi 设置里配置了 `enabledModels`，该模型必须在该白名单内。

匹配规则：

- 按 **model id** 匹配，不绑定固定 provider。
- `.` 与 `-` 视为等价（与 pi-subagents `resolveModel` 的 normalize 行为一致）。
- 多个 provider 提供同名 model id 时，取 `getAvailable()` 中第一个命中项。

### 6. 用户覆盖通道

| 方式 | 作用范围 | 说明 |
| ---- | -------- | ---- |
| `Agent({ model })` | 单次 spawn | 最高优先级；支持字符串或数组 |
| `.pi/agents/<name>.md` frontmatter | 项目级覆盖 | 覆盖内置或新增自定义 agent |
| `.agents/agents/<name>.md` frontmatter | 工作区级覆盖 | 跨项目共享 agent |
| `~/.pi/agent/agents/<name>.md` frontmatter | 全局覆盖 | 最低优先级 |

不引入单独的 JSON 设置文件（如 `.pi/herdr.json`）。所有 subagent 配置都走 agent markdown 文件。

## 后果

## 备选方案

| 方案 | 说明 | 未采纳原因 |
| ---- | ---- | ---------- |
| 所有 subagent 默认继承父模型 | 最简单，跟 pi-subagents 一致 | `explorer` 这种只读搜索会意外消耗高价模型 token |
| 固定一个便宜模型 | 例如 hardcode `gpt-5.6-luna` | 用户未必登录/配置了该模型；找不到时会静默失败 |
| 按能力标签自动选择 | 给模型打 `cheap`、`fast` 标签，自动匹配 | pi 的 model registry 没有稳定的能力标签；偏好列表更明确 |
| 单独 `preferred_models` frontmatter 字段 | 复用 explorer 的偏好策略 | `model` 数组更简洁，一个字段覆盖固定模型和偏好列表两种语义 |
| explorer 回退父模型时发出 warning toast | 提醒用户没有按预期省钱 | pi-subagents 没有这个行为；额外提示对 LLM 不够有用，反而可能让 UI 变吵 |

### 正面

- `explorer` 默认省钱，避免只读搜索意外消耗高价模型。
- `general-purpose` 默认保持能力，不强制降级。
- 自定义 agent 也能通过数组复用偏好列表策略，无额外字段。
- 所有覆盖都通过现有 agent markdown 机制完成，不新增配置概念。

### 负面

- `model` 字段从单字符串扩展到字符串/数组，frontmatter 解析和校验稍微复杂。
- 偏好列表硬编码在内置 agent 代码中，后续调整需要发新版。

### 未解决

- 无。
