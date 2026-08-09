# ADR-002: Agent Default Model Selection

- 状态：提议（Proposed）
- 日期：2026-08-09

## 上下文

持久 Explorer 会在长任务中被多次复用。如果它始终继承创建者的昂贵模型，简单的只读搜索也可能持续产生不必要成本；General Purpose Agent 则通常需要与创建者相近的能力。

Agent definition 的 `model` 需要同时支持固定模型和有序偏好列表，并允许创建 Agent 时覆盖。

## 决策

### 1. `model` 支持字符串和数组

```yaml
model: deepseek/deepseek-v4-flash
```

或：

```yaml
model:
  - gpt-5.6-luna
  - deepseek-v4-flash
```

数组按顺序选择第一个可用模型；全部不可用或未设置时继承 Primary Agent 当前模型。

### 2. Explorer 默认模型

Bundled `agents/explorer.md` 定义以下偏好：

```yaml
model:
  - gpt-5.6-luna
  - deepseek-v4-flash
```

### 3. General Purpose 默认模型

Bundled `agents/general-purpose.md` 不设置 `model`，因此继承 Primary Agent 当前模型。用户可通过自定义 definition 或 `Agent({ model })` 覆盖。

### 4. 选择优先级

1. `Agent({ model })` 单次覆盖。
2. 项目、工作区或全局自定义 definition。
3. bundled definition。
4. Primary Agent 当前模型。

模型在 Agent 创建时解析并固定。后续 `SendMessage` 复用同一个 Agent 和模型；需要不同模型时应创建另一个具名 Agent，而不是静默切换现有 session 的模型。

### 5. 可用模型

候选模型必须：

- 存在于 pi model registry 且用户已经完成认证。
- 如果配置了 `enabledModels`，同时位于该白名单中。

候选项按 model ID 匹配，不绑定 provider，并把 `.` 与 `-` 视为等价。多个 provider 命中时使用 registry 返回的第一个可用项。

候选列表全部不可用时继承 Primary 模型，不产生额外 warning 消息。

## 备选方案

| 方案 | 未采纳原因 |
| --- | --- |
| 所有 Agent 继承创建者模型 | 长期 Explorer 会持续消耗不必要的高价模型 token |
| 固定 provider/model | 用户未必安装、启用或认证该 provider |
| 自动按能力标签选择 | pi registry 没有稳定且统一的成本/能力标签 |
| 每条消息重新选择模型 | 同一持久 session 中静默切换模型会让行为和成本难以预测 |

## 后果

### 正面

- Explorer 默认节省成本，General Purpose 默认保持能力。
- 模型选择写在 Markdown definition 中，可随包发布并被用户覆盖。
- 持久 Agent 的模型身份稳定，便于调用方判断是否复用。

### 负面

- `model` 需要解析字符串和数组两种格式。
- 想更换模型时需要创建新 Agent 或显式重建旧 Agent。

### 未解决

- 无。
