# AGENTS.md

## Project Structure Guide

pi-herdr 是 TypeScript ESM Pi extension。

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
├── .github/
│   └── workflows/ci.yml                   # main push/PR 全量回归 CI
├── docs/
│   ├── spawned-agent-contract.md          # 创建、双模式、name、持久性与停止语义
│   ├── messaging.md                       # ListAgents、SendMessage 与 reply
│   ├── agent-definitions.md               # Markdown frontmatter 用户参考
│   ├── herdr-rpc.md                       # Socket protocol、事件、重试与 RPC 边界
│   └── adr/                               # Accepted 设计决策；修改 lifecycle/messaging/transport/naming 行为前先读对应 ADR
│       ├── 001-persistent-background-agents.md  # Agent = herdr tab 中后台持久的 Pi session；不复活、不建信箱
│       ├── 002-default-model-selection.md       # 模型解析：显式参数 > definition > 继承 Primary
│       ├── 003-agent-definitions.md             # 显式项目 definition 选择 + 单扩展双角色
│       ├── 004-herdr-socket-integration.md      # Protocol 17：独立 RPC socket、事件流重连与 snapshot 对账
│       └── 005-file-path-prompt-delivery.md     # 短 argv 纪律；prompt 走文件路径与 promptGuidelines
├── scripts/
│   └── verify-package.mjs                 # npm dry-run 打包清单与编译入口 smoke 校验
├── src/
│   ├── index.ts                           # 单 extension 入口与 Primary/Spawned 装配
│   ├── agent-definitions.ts               # Definition catalog、显式路径与严格 YAML 解析
│   ├── agent-runtime.ts                   # Pi 启动参数、模型、prompt 与 rename
│   ├── agent-supervisor.ts                # Live ownership、创建事务与工具语义
│   ├── herdr-client.ts                    # 独立 RPC socket、event stream 与只读重试
│   ├── herdr-types.ts                     # Herdr protocol 17 wire types
│   ├── tools.ts                           # 四个 Pi tool 的 schema 与注册
│   └── ui.ts                              # `/agents` live runtime UI
├── test/
│   └── bdd/                               # Cucumber 全量回归 features/steps/support；@herdr-e2e 为真机场景
├── cucumber.mjs                           # BDD profile 与 TypeScript support 配置
├── tsconfig.json                          # NodeNext build/typecheck 配置
└── package.json                           # npm/Pi manifest 与 canonical scripts
```

## Domain Language

- **Primary Agent** — 调用 `Agent` 工具创建另一个持久 Agent 的 pi 会话。
- **Spawned Agent** — 由 pi-herdr 创建、拥有独立 tab 和持久 pi session 的后台 Agent。
- **Agent definition** — 用户级/bundled catalog 中按名称选择，或由 Primary 从项目 `.pi/agents`、`.agents/agents` 显式选择路径的角色配置与 prompt。
- **Agent name** — 同时用作 pi session name、herdr live Agent alias 和 tab label；live 时可通过 `/name` 同步修改。
- **Agent tab** — 一个 spawned Agent 在 herdr 中的用户可见容器。
- **Managed pane** — Agent tab 内实际运行 pi 进程、承载 herdr lifecycle state 的 pane。
- **Peer** — herdr 当前可达、但不是由本次 pi-herdr runtime 管理的其他 pi 会话。
- **createdBy** — 当前 Primary 进程为自己创建的 live Agent 附加的内存元数据，不是持久身份或通信边界。
- **Reply address** — 入站消息携带的 live `SendMessage` 返回地址，可能在 rename、pane 变化或关闭后失效。
- **Persistent session** — 正常落盘、在 Agent idle 时继续使用，并可由用户通过原生 pi 管理的 session。

## Policies & Mandatory Rules

### Compatibility Policy

When changing an Accepted design before the first npm release, make the direct migration and update every affected document. Do not add compatibility branches, deprecated aliases, or checks for behaviors that have never shipped.

### Documentation Intent Principle

When implementation disagrees with an Accepted ADR because a platform API behaves differently, update the ADR and user documentation in the same change. Keep detailed lifecycle and error semantics in `docs/`; keep README focused on getting started plus the user-facing Herdr RPC support matrix.

## Operation Guide

### Setup and Canonical Commands

After cloning or when `package-lock.json` changes, install exactly the locked dependency graph:

```bash
npm ci
```

When changing TypeScript, tests, definitions, scripts, or configuration, run the fast local checks during iteration:

```bash
npm run format:check
npm run typecheck
npm run build
```

Before pushing implementation changes or opening/updating a PR, run the same full regression used by CI:

```bash
npm run test:regression
```

When a real Herdr 0.7.5 binary is available (or via `HERDR_BIN`), run the end-to-end scenarios that spawn a real `herdr server`, real Pi processes, and a faux OpenAI-compatible provider (`@herdr-e2e` tags, excluded from default runs but always run in CI; run locally before pushing changes to the launch/delivery path — Linux CI cannot see macOS-specific tty behavior):

```bash
npm run test:e2e
```

### Release

Releases use an agent-driven Release PR, no bot and (during v0.x) no CHANGELOG.md — the GitHub Release notes are the changelog:

1. The coding agent aggregates merged PRs since the last tag from conventional commit titles and bumps `package.json` (`fix:` → patch, `feat:` → minor; under 0.x, breaking changes also just bump minor). Keep PR titles semantic — they are the release-notes source.
2. Open the Release PR (version bump only) and merge when green; tag the merge commit (`v*`).
3. Create the GitHub Release on that tag with notes rewritten from the merged PR titles — grouped by feat/fix/chore, written for users, each linking its PR.
4. Publish with `npm publish`. `prepublishOnly` runs the full regression plus the real-Herdr e2e on the publishing machine, which covers macOS-specific delivery behavior that Linux CI cannot see; the publishing machine therefore needs a `herdr` binary (or `HERDR_BIN`).

### Documentation Verification

When changing `agents/*.md`, validate bundled frontmatter:

```bash
ruby -ryaml -e 'ARGV.each { |path| text = File.read(path); match = text.match(/\A---\n(.*?)\n---\n/m) or abort("missing frontmatter: #{path}"); YAML.safe_load(match[1], permitted_classes: [], aliases: false); puts "ok #{path}" }' agents/*.md
```

When changing Markdown links, validate local targets:

```bash
ruby -e 'Dir["{README.md,docs/**/*.md}"].each { |file| File.read(file).scan(/\[[^\]]+\]\(([^)]+)\)/).flatten.each { |target| next if target =~ %r{^(https?://|#)}; path = File.expand_path(target.split("#", 2).first, File.dirname(file)); abort("broken link: #{file} -> #{target}") unless File.exist?(path) } }; puts "local markdown links ok"'
```
