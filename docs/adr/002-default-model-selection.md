# ADR-002: Agent Initial Model Selection

- 状态：已接受（Accepted）
- 日期：2026-08-09

## Context

长期 live Explorer 会被多次复用。如果它总是以 调用方的高成本模型启动，简单只读搜索可能产生不必要成本；General Purpose Agent 通常更适合继承调用方能力。

模型配置只需要决定新 session 的初始状态。Agent 启动后，用户仍应保留 pi 原生 `/model` 等控制能力，而不是由 pi-herdr 锁定模型。

## Decision

### 1. `model` 支持字符串和数组

Definition 与 `Agent({ model })` 都接受固定模型或有序候选列表：

```yaml
model:
  - gpt-5.6-luna
  - deepseek-v4-flash
```

数组按顺序选择第一个当前可用候选。

### 2. Explorer 与 General Purpose 默认值

Bundled explorer 优先使用 `gpt-5.6-luna`，其次使用 `deepseek-v4-flash`。Definition 候选均不可用时继承调用方当前模型。

Bundled general-purpose 不指定 model，因此初始模型直接继承调用方当前模型。

### 3. Selection precedence

1. `Agent({ model })` 显式参数。
2. 当前选中的 definition 中的候选。
3. 调用方当前模型。

Definition 在创建时固定；已有 Agent 不因 Markdown 文件变化而重新解析模型。

### 4. Availability

候选模型必须已经认证、存在于 pi model registry，并符合当前 session 的 scoped/enabled models。候选按 model ID 匹配，把 `.` 与 `-` 视为等价；多个 provider 命中时使用 registry 顺序中的第一个可用项。

显式 `Agent({ model })` 表达调用方确定意图，因此其候选全部不可用时创建失败。Definition 的默认候选只是偏好，其候选全部不可用时静默继承调用方模型。

### 5. Model is mutable after launch

解析结果只用于启动新 pi session。用户之后执行 `/model`、修改 thinking level 或使用其他 pi 原生控制时，变化正常持久化到 session，后续 `SendMessage` 沿用当前 session 状态。

pi-herdr 不监听或回滚模型变化，也不要求为不同模型创建新 Agent。

## Alternatives

| Alternative                  | Why not chosen                                 |
| ---------------------------- | ---------------------------------------------- |
| 所有 Agent 继承调用方模型 | Explorer 会持续消耗不必要的高价模型 token      |
| 固定 provider/model          | 用户未必安装、启用或认证对应 provider          |
| 显式 model 失败时静默回退    | 会掩盖调用参数拼写错误或违反调用方明确意图     |
| 创建后锁定模型               | 限制 pi 原生交互能力，并需要额外拦截与回滚逻辑 |

## Consequences

### Positive

- Explorer 默认节省成本，General Purpose 默认保持能力。
- 显式调用错误可立即发现，definition 偏好仍能平滑回退。
- live Agent 与普通 pi session 一样可由用户调整模型。

### Negative

- Agent 的当前模型可能与创建时返回的初始选择不同。
- model string/string[] 和 scoped model 匹配需要严格诊断。

### Unresolved

- 无。
