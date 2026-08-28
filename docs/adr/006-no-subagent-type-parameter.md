# ADR-006: Agent 工具不设 subagent type 参数

- 状态：已接受（Accepted）
- 日期：2026-08-25

## Context

pi-herdr 曾经有 Agent definition 机制（ADR-003，已移除）：catalog 或显式路径选择角色配置，frontmatter 携带 model/thinking/tools/extensions/skills，body 作为 system prompt。配套有 bundled `explorer`（只读工具集）。

实际使用中暴露出结构性问题：primary agent（kimi-3）并行创建了多个 explorer 做调查，随后派实现任务时，这些积累了对口上下文的 Agent 以"我是只读 Agent"为由拒接，所有实现活被挤到唯一无限制的 Agent 上。硬性角色限制把长期累积的上下文变成了 stranded context。

行业参照（Claude Code agent teams）里按角色裁剪 teammate 工具是存在的，但生命周期不同：其 teammate 是 session 级的，随任务结束消亡；只读以 plan mode 的形式作为**任务阶段**存在，plan 批准后自动解除。pi-herdr 的 Agent 是跨 session 持久、反复复用的——身份级硬限制只在短生命周期里安全。

## Decision

`Agent` 工具不提供 subagent type / definition 参数。每个被创建的 Agent 与创建者能力完全相同（uniform capability 契约），模型与 thinking 通过显式 `model` / `thinking` 参数覆盖。

角色约束改为任务级表达：

- 只读、审查姿态等写在**当次 prompt** 里（"只做调查，不要改代码"），不进 Agent 的长期身份；
- 写操作的真正防线是 Pi 的权限审批系统（审批在 Agent 的 pane 中可见可批），不是启动时的工具裁剪；
- 长期行为契约（完成后回复、保持空闲）由 extension 的 promptGuidelines 统一承载。

## Consequences

### Positive

- Agent 池可以任意复用：探索积累的上下文可以直接接实现任务，不存在"派不出去"的 Agent。
- 工具表面收窄为 description / prompt / name / model / thinking / cwd / isolation，chooser 决策面更小。
- 删除 definition catalog、严格 YAML 解析、bundled explorer 与对应诊断路径。

### Negative

- 无法创建"结构性只读"的 Agent；依赖 prompt 约束与权限审批，强度低于工具裁剪。
- model 的有序候选 fallback 从 definition 移到显式 `model` 参数（支持 string[]），没有持久化的默认角色配置。

### Unresolved

- 如果未来重新引入角色机制，应先解决生命周期错配：限制挂在任务或阶段上（如 plan-then-implement），或提供短生命周期 worker 类型，而不是恢复身份级 definition。
