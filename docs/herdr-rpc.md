# Herdr RPC Integration

pi-herdr 通过 Herdr 的 local socket RPC 创建、控制和观察 live Pi Agent。当前 wire contract 固定为 Herdr 0.7.5 / socket protocol 17；CLI 只用于人工诊断，不参与实现控制面。

## Activation and Bootstrap

extension 只在 `HERDR_ENV=1` 时启用 Herdr 控制面。已经处于 Herdr 环境但缺少 `HERDR_SOCKET_PATH` 或 `HERDR_PANE_ID` 时，pi-herdr 显示明确诊断，不猜测 socket path 或调用者 pane。

每次控制操作都依赖完整 bootstrap：

1. `ping` 读取 Herdr version 和 protocol。
2. `session.snapshot` 再次验证 protocol 17，并建立 live runtime 基线。

两个步骤都成功后控制面才可用。暂时性的 bootstrap 失败可以由后续工具操作或 event acknowledgement 重试，但不会留下可执行部分操作的半初始化状态。protocol 不匹配时，错误包含实际 version 与 protocol。

## Connection Model

普通 RPC 每次建立独立 local socket，写入一行带唯一 request ID 的 JSON，并在读取同 ID 的单行响应后关闭。不同 mutation 不共享一条长期 request socket，因此前一次调用的残留数据不会影响后续调用。

普通 request 和首次 subscription acknowledgement 使用 5 秒绝对 deadline；零散字节不会延长 deadline。`events.subscribe` acknowledgement 成功后取消该 deadline，并在独立长连接上持续接收 push。event socket 不承载普通 RPC 或 `agent.prompt`。

## Event Stream

subscription request 使用 protocol 17 的点号类型：

- `pane.agent_detected`
- `pane.closed`
- `pane.exited`
- `tab.closed`
- `tab.renamed`
- `pane.agent_status_changed`

Herdr push 保留各自实际 wire schema。普通 lifecycle event 使用 `pane_agent_detected`、`pane_closed`、`pane_exited`、`tab_closed`、`tab_renamed`，过滤后的状态 event 使用 `pane.agent_status_changed`；请求类型和 push 类型不能相互替换。

首次 subscription 尚未 acknowledgement 时，客户端只进行有限次连接尝试。已经成功建立过的 event stream 断开后，客户端以封顶退避持续重连、重新订阅，并获取新的 `session.snapshot` 核对 live runtime。snapshot reconciliation 不创建缺失的 runtime，也不从 session 文件恢复 ownership。

每次 reconciliation 读取开始时记录当时已有的 ownership key；响应只能更新或删除这组记录，不能让延迟返回的旧 snapshot 或 `agent.list` 擦除并发完成的新 Agent launch。

## Retry and Delivery

pi-herdr 只自动重试不会产生副作用的读取：`ping`、`session.snapshot`、`agent.list` 和 `agent.get`。启动就绪轮询也只调用 `agent.get`。

`agent.start`、`agent.prompt`、rename、close、tab 和 worktree mutation 不自动重放。若 mutation 已写入 socket、但响应在返回资源 ID 前丢失，调用方无法判断服务端是否已经执行；pi-herdr 保留 unknown delivery 语义，不通过 label 或并发 snapshot 猜测资源归属。创建流程会在错误中报告可能存在的无法寻址 container residual。

## RPC Surface

| pi-herdr behavior                    | Herdr RPC                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| Protocol diagnostics and bootstrap   | `ping`, `session.snapshot`                                                           |
| Live discovery and target resolution | `agent.list`, `agent.get`                                                            |
| Shared Agent container               | `tab.create`                                                                         |
| Worktree Agent container             | `worktree.create`, `tab.rename`                                                      |
| Start Pi and wait until interactive  | `agent.start`, read-only `agent.get` polling                                         |
| Initial and later messages           | `agent.prompt`                                                                       |
| `/name` synchronization              | `agent.get`, `tab.get`, `agent.rename`, `tab.rename`                                 |
| Stop runtime                         | `pane.close`                                                                         |
| Failure rollback                     | `worktree.remove`, then `pane.close` when removal fails; `tab.close` for shared mode |
| Caller lookup                        | `pane.current`                                                                       |
| State and reconnect                  | `events.subscribe`, `session.snapshot`                                               |

pi-herdr 对 Pi 只暴露 `Agent`、`ListAgents` 和 `SendMessage`，不包装通用 workspace、tab、pane、layout、terminal input、agent wait/read/focus、worktree cleanup、plugin/server/integration 或 notification 管理能力。
