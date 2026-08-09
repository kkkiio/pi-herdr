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
- **Agent definition** — 用户级/bundled catalog 中按名称选择，或由 Primary 从项目 `.pi/agents`、`.agents/agents` 显式选择路径的角色配置与 prompt。
- **Agent name** — 同时用作 pi session name、herdr live Agent alias 和 tab label；live 时可通过 `/name` 同步修改。
- **Agent tab** — 一个 spawned Agent 在 herdr 中的用户可见容器。
- **Managed pane** — Agent tab 内实际运行 pi 进程、承载 herdr lifecycle state 的 pane。
- **Peer** — herdr 当前可达、但不是由本次 pi-herdr runtime 管理的其他 pi 会话。
- **createdBy** — 当前 Primary 进程为自己创建的 live Agent 附加的内存元数据，不是持久身份或通信边界。
- **Reply address** — 入站消息携带的 live `SendMessage` 返回地址，可能在 rename、pane 变化或关闭后失效。
- **Persistent session** — 正常落盘、在 Agent idle 时继续使用，并可由用户通过原生 pi 管理的 session。

## Policies & Mandatory Rules

### Architecture Invariants

When responding to users or writing project prose without an explicit language request, use Chinese.

When changing Agent lifecycle, spawning, or herdr integration:

- Keep every spawned Agent background-only and session-persistent.
- Create one herdr tab per Agent; run pi in that tab's managed pane. Reuse the tab/root pane returned by `worktree.create`.
- Share the creator's workspace and inherit its cwd by default. An explicit `cwd` selects the Spawned Agent working directory without changing definition resolution; create a worktree only for explicit `isolation: "worktree"`, passing the resolved cwd to herdr.
- Keep herdr `AgentInfo` and `agent_status` unchanged in tool results; UI may visually group `done` with idle.
- Treat pane/tab/process disappearance as the end of pi-herdr management. Preserve session/worktree, but do not add offline registry, mailbox or automatic recovery.
- Do not add active/running concurrency limits. Enforce only the current Primary process's `piHerdr.maxMembers` safety limit.
- Return `Agent` success only after `agent.start` and the initial `agent.prompt` succeed; roll back resources created by a failed launch.

When changing discovery or messaging:

- Return every live Agent and peer visible through the current herdr session; never synthesize unavailable/offline entries.
- Use the unique Agent name as the preferred target and the live `pane_id` as fallback.
- Route initial work, follow-up requests and results through herdr `agent.prompt` using the opening `<from agent="…" reply-to="…">` envelope. Do not add `steer`/`followUp` emulation or durable delivery.
- Load the same pi-herdr extension in Primary and Spawned runtime roles. Spawned mode registers `ListAgents` and `SendMessage`, but not `Agent` or `StopAgent`.
- Keep `StopAgent` limited to `pane.close`, accept live name or pane ID, reject self-stop, and never delete session/worktree.
- Retry idempotent reads only; never automatically replay mutating herdr RPC.

When changing Agent naming:

- Use pi session name as the persisted source of truth.
- Enforce herdr's `[a-z][a-z0-9_-]{0,31}` format and live uniqueness for spawned Agent session names. Closed sessions do not reserve names.
- Synchronize valid `session_info_changed` events to herdr Agent name and tab label.
- Use pane ID as the live internal key. Restore every partially changed name surface and report an error when rename validation or synchronization fails.

### Bundled Definitions

When changing `agents/explorer.md`, keep Bash available for `rg`, Git queries, statistics, and file analysis while retaining the read-only role contract.

When changing `agents/*.md` or the definition loader, keep lifecycle and messaging rules in the shared Agent system prompt; keep role-specific expertise in each Markdown body.

Keep definition collections as YAML arrays. The supported fields are exactly `description`, `model`, `thinking`, `tools`, `extensions`, `skills`, `disallowed_tools`, and `enabled`; reject every unknown field. Keep `extensions` and `skills` boolean for every definition source: `true` leaves native cwd discovery enabled, while `false` disables it. Never turn definition resource paths into explicit pi CLI extension or skill inputs.

List effective enabled definitions from the global directory and then bundled definitions in the open-string `definition` parameter description. Global names shadow bundled names; malformed or disabled global definitions do not fall back to a same-name bundled definition.

Use `definition: string` as the selector. Resolve a bare name from global then bundled definitions; resolve an absolute or explicit relative `.md` path exactly, with relative paths based on the Primary call cwd. Do not automatically select project definitions from the Primary Git root or scan external repositories.

Tell Primary Agents to inspect task-relevant `.pi/agents`, `.agents/agents`, and project `AGENTS.md` with ordinary file/Git tools before using the fallback catalog. A definition path selects role configuration only and never implies Agent workspace or cwd. Resolve relative `definition` paths and relative `cwd` values independently from the Primary call cwd.

Treat an explicit definition path as `Agent` input rather than a pi auto-discovered project resource. Do not inject project trust policy into Primary prompts or tool guidelines. Do not read, write, cache or override pi trust state, and do not pass `--approve` or `--no-approve`; every Spawned pi resolves native project trust for its actual cwd.

When adding npm packaging, include both `dist/` and `agents/` in `package.json#files`, resolve bundled files from `import.meta.url`, and verify the tarball contains both Markdown definitions.

### Compatibility Policy

When changing a Proposed design before implementation, make the direct migration and update every affected document. Do not add compatibility branches, deprecated aliases, or checks for behaviors that have never shipped.

### Documentation Intent Principle

When implementation disagrees with a Proposed ADR because a platform API behaves differently, update the ADR and user documentation in the same change. Keep detailed lifecycle and error semantics in `docs/`; keep README focused on getting started plus the user-facing herdr RPC support matrix.

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
