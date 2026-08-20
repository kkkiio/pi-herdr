# ADR-005: File-path Prompt Delivery for Agent Launch

- 状态：已接受(Accepted)
- 日期:2026-08-21

## Context

pi-herdr 通过 Herdr `agent.start` 启动 Spawned Pi,而 Herdr 的实现是把 quoting 后的命令行**打字进目标 pane 的交互 shell**。真实 Herdr e2e(`@herdr-e2e`)暴露出:当命令行超过约 1024 字节(macOS tty 输入队列上限)时,投递被**静默截断**——CLI 报成功,shell 收到残缺命令,agent 永不启动(上游 issue herdrdev/herdr#2862,0.7.5/0.8.0、sh/zsh 均复现)。

pi-herdr 原先把共享生命周期规则和 `Role-specific instructions:` 前缀加 definition 正文拼接成两个内联 `--append-system-prompt` 参数,完整 launch 命令约 1.7KB,必踩截断。FakeHerdrServer 回归测不到投递层,该缺陷由真机 e2e 发现。

同时,Pi 的 `--system-prompt` / `--append-system-prompt` 原生支持文件路径:`resolvePromptInput` 在参数是存在的文件路径时读入文件内容,否则按字面文本处理(`pi-coding-agent` 的 `resource-loader.ts`)。

## Decision

### 1. Launch argv 只携带短 ASCII flag

`AgentRuntime.resolveLaunchPlan` 生成的参数只剩 `--name`、`--extension`、`--pi-herdr-role`、`--model`、`--thinking`、`--tools`、`--exclude-tools`、`--no-extensions`、`--no-skills`,总量约 300 字节,远离 tty 阈值。任何长文本一律不作为内联 argv 传递。

### 2. 生命周期与消息规则迁入工具的 description 与 `promptGuidelines`

原共享 system prompt 的内容是 `SendMessage`/`ListAgents` 的使用契约(envelope 格式、reply-to 回复、回复后保持空闲),Pi 会把注册工具的 `promptGuidelines` 组合进 system prompt 的 Guidelines 段,这是 Pi 内置工具(bash/read/edit/write)使用的原生通道。"不能创建/停止 Agent" 条款删除——Spawned 角色不注册这两个工具,能力缺席自明。

### 3. 角色指令通过 `--append-system-prompt <definition 绝对路径>` 传递

Definition 在任何来源(bundled、全局目录、显式路径)都已经是磁盘上的 Markdown 文件,`AgentDefinitionStore` 解析后持有绝对路径。Spawned Pi 启动时自己读文件,Primary 侧的解析与严格校验(disabled、malformed、未知字段)不变。

### 4. 接受 frontmatter 原样进入 system prompt

不再剥离 YAML frontmatter、不加 `Role-specific instructions:` 前缀。理由:

- Pi 生态中模型本来就经常读到带 frontmatter 的原文:read 工具读取 SKILL.md 时只在 TUI 渲染层加 `[skill]` 标签,返回内容包含完整 frontmatter。几行结构化 YAML 对模型无害,甚至自述了角色的工具策略。
- 剥离 frontmatter 需要派生临时文件,引入文件生命周期、清理失败残留和静默退化(Pi 对不存在的路径退化为字面 prompt 文本)问题,而收益只是少几行元数据。
- Definition 作者本来就应该把 body 当作 system prompt 来写;frontmatter 入 prompt 后这一点更加明确。

### 5. 使用 append,不替换

不使用 `--system-prompt`:它会整体替换 Pi 默认的 coding-assistant prompt,而 pi-herdr 的语义是追加角色行为。

本 ADR 修订 ADR-003 第 1 条的投递机制:definition body 仍然追加到 Spawned system prompt,但通道从内联 argv 文本改为文件路径;控制面规则从共享 system prompt 文本块迁为工具 description/`promptGuidelines`。

## Alternatives

| Alternative | Why not chosen |
| --- | --- |
| 内联 argv 文本(原实现) | tty 输入队列 1024 字节静默截断(herdrdev/herdr#2862),生产必现 |
| Launch script 包装(issue 评论区 workaround) | 多一层文件与进程生命周期;Pi 原生支持文件路径 prompt,不需要 |
| 派生临时文件(剥 frontmatter、加前缀) | 文件生命周期/清理残留;路径缺失时 Pi 静默退化为字面文本;收益仅为少几行元数据 |
| 扩展侧注入(`--pi-herdr-definition` + session 事件钩子) | 新增 flag 语义;prompt 不出现在 Pi 的 appendSystemPrompt 资源清单中;重复 Pi 原生文件加载 |
| `--system-prompt` 全量替换 | 丢弃 Pi 默认 coding-assistant prompt,改变既有 append 语义 |
| 共享规则保留为 bundled md 按路径传递 | 规则是两个工具的使用契约,与工具定义同处更准确;也避免多一个需打包验证的资源 |

## Consequences

### Positive

- Launch argv 约 300 字节,不受 tty 截断影响;definition 正文不再经过 shell quoting,中文与特殊字符零风险。
- 无临时文件;definition 文件改动不需要 pi-herdr 重新编码。
- 工具契约与工具定义同处,Primary/Spawned 两个角色的 guidelines 可按角色分化。
- `@herdr-e2e` 覆盖真实投递路径,回归可信。

### Negative

- Definition 的 frontmatter 元数据进入 system prompt,增加少量 token 与噪声。
- Definition 文件必须在 Spawned Pi 存活期间保持可读(Pi reload resources 时会重读);删除或移动文件会使重读退化。
- 共享规则只在工具注册时随 `promptGuidelines` 出现;若未来出现不含这两个工具的 Spawned 形态,契约需要新的载体。

### Unresolved

- 上游 herdrdev/herdr#2862 仍 OPEN。即使上游修复(分块写入或显式报错),本 ADR 的 argv 纪律仍然保留:argv 是控制面,不是内容通道。
