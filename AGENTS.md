# AGENTS.md

## Project Structure Guide

pi-herdr 当前处于架构与文档阶段。实现代码尚未开始；`docs/` 中的 Proposed ADR 是实现依据，`agents/` 中的 Markdown 是将随 npm 包发布的运行时资源。

### Repo Structure & Important Files

```text
.
├── AGENTS.md                              # 开发 Agent 的项目规则与操作指南
├── README.md                              # 用户入口、安装状态和最短使用示例
├── agents/                                # Bundled Agent definitions；npm 发布资源
│   ├── explorer.md                        # 带 Bash 的只读搜索 Agent
│   └── general-purpose.md                 # 具备完整工作工具的通用 Agent
├── assets/
│   └── pi-herdr-logo.png                  # README 品牌图
├── docs/
│   ├── agents.md                          # Agent API、name、tab 与生命周期
│   ├── messaging.md                       # ListAgents、SendMessage 与 reply
│   ├── agent-definitions.md               # Markdown frontmatter 用户参考
│   ├── architecture.md                    # 当前整体架构
│   └── adr/
│       ├── 001-persistent-background-agents.md
│       ├── 002-default-model-selection.md
│       ├── 003-agent-definitions.md
│       └── 004-herdr-socket-integration.md
├── src/                                   # TypeScript 实现目录；尚未开始
└── test/                                  # 自动化测试目录；尚未开始
```

实现时保持 `src/` 为少量深模块；按 `docs/architecture.md` 的模块边界组织，不要为单个小动作创建 helper 文件或浅包装层。

## Domain Language

- **Primary Agent** — 调用 `Agent` 工具创建另一个持久 Agent 的 pi 会话。
- **Spawned Agent** — 由 pi-herdr 创建、拥有独立 tab 和持久 pi session 的后台 Agent。 _Avoid_: one-shot subagent, team member.
- **Agent definition** — `agents/*.md` 或用户覆盖路径中的角色配置与 prompt。
- **Agent name** — 同时用作 pi session name、herdr live Agent alias 和 tab label 的稳定名称。
- **Agent tab** — 一个 spawned Agent 在 herdr 中的用户可见容器。
- **Managed pane** — Agent tab 内实际运行 pi 进程、承载 herdr lifecycle state 的 pane。
- **Peer** — herdr 当前可达、但不是由本次 pi-herdr runtime 管理的其他 pi 会话。
- **createdBy** — 记录哪个 Primary Agent 创建了 spawned Agent 的元数据，不是可见性或通信边界。
- **Reply address** — 入站消息携带的 `SendMessage` 返回地址。
- **Persistent session** — 正常落盘、在 Agent 空闲或 runtime 重建后继续使用的 pi session。

## Policies & Mandatory Rules

### Architecture Invariants

When responding to users or writing project prose without an explicit language request, use Chinese.

When changing Agent lifecycle, spawning, or herdr integration:

- Keep every spawned Agent background-only and session-persistent.
- Create one herdr tab per Agent; run pi in that tab's managed pane.
- Share the creator's workspace and cwd by default; create a worktree only for explicit `isolation: "worktree"`.
- Treat herdr `idle` and `done` as idle activity states, not Agent termination.
- Do not add active/running concurrency limits; keep only the workspace-wide `maxMembers` safety limit.

When changing discovery or messaging:

- Return every Agent and peer visible through the current herdr session; do not scope `ListAgents` by `createdBy`, cwd, workspace, or a Team abstraction.
- Use the unique Agent name as the preferred target and the live `pane_id` as fallback.
- Route work requests and results through `SendMessage` and reply addresses.
- Expose `ListAgents` and `SendMessage` to spawned Agents, but do not expose `Agent` or arbitrary pane management.

When changing Agent naming:

- Use pi session name as the persisted source of truth.
- Enforce herdr's `[a-z][a-z0-9_-]{0,31}` format and current-session uniqueness for spawned Agent session names.
- Synchronize valid `session_info_changed` events to herdr Agent name and tab label.
- Restore the prior session name and report an error when a rename is invalid or conflicts.

### Bundled Definitions

When changing `agents/explorer.md`, keep Bash available for `rg`, Git queries, statistics, and file analysis while retaining the read-only role contract.

When changing `agents/*.md` or the definition loader, keep lifecycle and messaging rules in the shared Agent system prompt; keep role-specific expertise in each Markdown body.

When adding npm packaging, include both `dist/` and `agents/` in `package.json#files`, resolve bundled files from `import.meta.url`, and verify the tarball contains both Markdown definitions.

### Compatibility Policy

When changing a Proposed design before implementation, make the direct migration and update every affected document. Do not add compatibility branches, deprecated aliases, or checks for behaviors that have never shipped.

### Documentation Intent Principle

When implementation disagrees with a Proposed ADR because a platform API behaves differently, update the ADR and user documentation in the same change. Keep `README.md` limited to getting started; put API detail in `docs/` and developer rules here.

### Code Design

When adding TypeScript implementation, follow *A Philosophy of Software Design*: prefer deep modules with small public surfaces, keep substantial functions at least 20 lines when the logic belongs together, and prefer established library helpers over custom helper proliferation.

When a formatter changes files in scope, keep its output. Do not manually roll back formatter-owned changes.

Do not run `git diff --check` in this repository.

## Operation Guide

### Current Development State

There is no `package.json`, build script, runtime implementation, or automated test suite yet. Do not claim the package can build or publish until those files exist.

### Documentation Verification

When changing `agents/*.md`, validate bundled frontmatter:

```bash
ruby -ryaml -e 'ARGV.each { |path| text = File.read(path); match = text.match(/\A---\n(.*?)\n---\n/m) or abort("missing frontmatter: #{path}"); YAML.safe_load(match[1], permitted_classes: [], aliases: false); puts "ok #{path}" }' agents/*.md
```

When changing Markdown links, validate local targets:

```bash
ruby -e 'Dir["{README.md,docs/**/*.md}"].each { |file| File.read(file).scan(/\[[^\]]+\]\(([^)]+)\)/).flatten.each { |target| next if target =~ %r{^(https?://|#)}; path = File.expand_path(target.split("#", 2).first, File.dirname(file)); abort("broken link: #{file} -> #{target}") unless File.exist?(path) } }; puts "local markdown links ok"'
```

When `package.json` and the build exist, replace this placeholder with the canonical install, typecheck, test, format, and package-verification commands in the same change.
