# Canvas 持久化与版本管理

本文描述 Task-Centric Canvas 已实现的事实源、command 保存协议、冲突分支、运行记录与 Canvas Git 边界。已废弃的整文档 `PUT /canvas`、node-owned session 和按路径读取 artifact 不属于当前数据流。

## 事实源与派生状态

| 层 | 路径或存储 | 职责 | 是否事实源 |
| --- | --- | --- | --- |
| 浏览器视图 | IndexedDB `ggai-canvas` / `branch-view-state` | camera、selection、Task/Collection 折叠、composer draft | 否，仅 branch-local 视图 |
| 浏览器 outbox | IndexedDB `ggai-canvas` / `command-outbox` | 未确认 command 的 FIFO journal；保存 `mutationId`、当前 `baseRevision` 与不可变 `initialBaseRevision` | 否，仅崩溃与断线缓冲 |
| 当前 Canvas | `.gg/runtime/canvas/<branch-hash>/snapshot.json` | 当前 `CanvasDocument`、revision、checkpoint 锚点及 daemon 内部 mutation ledger | 是 |
| 语义 revision | `.gg/runtime/canvas/<branch-hash>/revisions/<revision>.json` | 带 document digest 的不可变历史基底，供显式冲突恢复使用 | 是，限 command 历史 |
| 运行记录 | `.gg/runtime/runs/<runId>/events.jsonl`、`events.idx`、`summary.json` | durable SSE 事件、终态 close、分页索引，以及固化实际 prompt/baseRevision 的 Run 摘要 | 是 |
| Task 会话 | `.gg/runtime/task-sessions.json` | `canvasBranch + taskId + agentId` 到 Agent session 的映射 | 是 |
| ProjectionPlan | `.gg/runtime/projection-plans/<branch-hash>.json` | daemon 生成的 pending/dismissed 可信计划 | 是 |
| 插件能力 | `.gg/runtime/plugin-capabilities/<digest>.json` | Run 接受时固定的、带 provenance 的 capability 快照 | 是 |
| Canvas 历史 | `.gg/canvas/`、`.gg/canvas-worktrees/` | 规范化 Task/Node/Collection/Edge/receipt Git checkpoint | 历史事实源 |
| Artifact | `artifacts/.branches/<branch-hash>/<runId>/files/<relative-path>` | Run-owned 不可变文件 | 是 |

`CanvasDocument` 只保存 Task、Node、Collection、typed Edge、materialization/proposal receipt 和 `everCreated`。active Run、SSE cursor、日志缓存、视图状态、outbox、mutation ledger、artifact bytes 与原始 JSONL 不进入 Canvas Git。

## Command 保存与 exactly-once

浏览器不允许上传整份 Canvas snapshot。所有持久语义变更走：

```text
POST /canvas/commands?projectDir=...
{ branch, baseRevision, mutationId, command }
```

保存顺序如下：

1. hydration 完成后，浏览器用共享 reducer 校验 command。
2. 在同一个 outbox 临界区内，先持久化 command，再发布乐观文档；断网或页面崩溃不会丢失已显示的语义变更。
3. outbox 按 FIFO 一次发送一个 command。高频拖动只更新临时视图，`pointerup` 发送一个 `MoveEntities`。
4. daemon 在项目 lease 和分支锁内读取当前 revision、运行同一 reducer、校验全部不变量，然后通过原子文件替换提交新 envelope。
5. HTTP 成功响应后浏览器才删除对应 outbox 项；响应丢失时保留原 `mutationId` 重试。
6. 普通 command 成功后约 3 秒合并为语义 Canvas Git checkpoint；关闭 daemon、分支操作和破坏性 command 会冲刷相关 checkpoint。

daemon 在 runtime snapshot 内保存 `mutationId → commandDigest + committedRevision` 的 exactly-once ledger。它不会返回给浏览器，也不会进入 `CanvasDocument` 或 Canvas Git。相同 `mutationId` 与相同 command 即使在后续 revision、daemon 重启或 HTTP 成功响应丢失后重试，也返回当前规范 envelope，不再执行副作用；同一 ID 携带不同 command 会被拒绝。

普通 Git checkpoint 失败不会回滚已经提交的 Canvas command，而是把版本状态标记为 degraded。`DeleteNode`、删除 Edge、解散/删除 Collection、删除 Task 等破坏性 command 例外：daemon 先用 reducer 预校验，并同步 checkpoint 精确的删除前文档；无法建立恢复点时删除失败关闭，不会只留下不可恢复的 runtime 变更。

## CAS 与显式冲突分支

旧 `baseRevision` 返回 `409 canvas_revision_conflict`。浏览器最多自动执行一次：读取最新 envelope、保持 `mutationId` 和 FIFO 顺序、只改 outbox 的发送 `baseRevision`，然后重放。`initialBaseRevision` 永不随 rebase 改写。

若再次冲突，或 reducer 前置条件已失效，store 进入显式 conflict 状态，保留 outbox 与乐观投影。用户可在版本面板选择“保存为新分支”，调用：

```text
POST /canvas/conflicts?projectDir=...
{
  sourceBranch,
  newBranch,
  baseRevision,
  mutations: [{ mutationId, command }]
}
```

其中 `baseRevision` 是 FIFO 首项的 `initialBaseRevision`，mutation 上限为 500。daemon 只从自己的不可变 revision archive 读取基底，在内存中完整重放 journal 并校验后，才从来源分支 checkpoint 创建新分支并物化恢复结果。请求不能携带 `canvasSnapshot`、Node patch 或自由 ProjectionPlan；涉及可信 plan 的 command 仍只上传 `planId`，由 daemon 解析。

来源分支保持不变。相同新分支与相同恢复结果可幂等重试；同名分支已经承载另一份文档时显式失败。成功响应为 HTTP 201，浏览器确认来源 outbox 并把当前视图写入新分支作用域；失败时 outbox 和 conflict 状态都保留。

## 刷新、Run 重连与永久日志

刷新时先读取 `GET /canvas`，再加载 branch-local 视图和 outbox，并对 outbox 重放乐观 reducer。Task runtime 不从 Canvas 文档伪造，而是通过 Task Run 历史、永久日志和 SSE 恢复：

- 活跃 Run 以 durable event id 续接 SSE；出现内存窗口 gap 时先分页读取 run log。
- daemon 重启把未完成 Run 恢复为 `interrupted`，对已经验证的 artifact 生成 partial manifest/ProjectionPlan。
- 组件卸载或刷新只断开订阅；只有明确取消操作才请求 daemon 终止 Run。
- 每个 `(project, branch, taskId)` 同时最多一个活跃 Run；不同 Task 可并发。
- 会话严格按 `canvasBranch + taskId + agentId` 隔离。Task 内“继续任务”可复用 session，派生 Task 获得独立 session。

Task Run 的 summary 在接受时同时保存实际 `prompt` 与 `baseRevision`，finish 只更新状态而不改写执行意图。显式 Node attachment 从该 revision 的持久文档固化有界内容快照；其 artifactRefs 与直接 artifact、typed-edge artifact 一同经过 closed manifest 和 digest 复验，不能由浏览器内容或路径替代。

run log 包含重建 ProjectionPlan 与审计终态所需的 close，不能通过 `DELETE /runs/:id/log` 单独删除；该接口返回 `run_log_delete_unsupported`。原始 JSONL 不进入 Canvas Git。

## Run-owned Artifact

每个 Run 的可写目录固定为：

```text
artifacts/.branches/<branch-hash>/<runId>/files/
```

Agent 只在这个 `files/` 根下写 deliverable 和可选的 `files/.ggai/run-result.json` 控制 sidecar。durable close 时 daemon 扫描并校验文件，在 Run 根写入：

```text
artifacts/.branches/<branch-hash>/<runId>/.ggai/artifact-manifest.v1.json
```

`.ggai`、临时文件、symlink、hardlink/foreign file、非普通文件和路径逃逸不会成为 artifact entry。Node 只保存 `{ runId, artifactId }`，不保存磁盘路径。读取必须通过 manifest-backed API：

- `GET /runs/:runId/artifacts/:artifactId`：经过 no-follow、realpath、size 与 digest 复验后的 bytes；
- `GET /runs/:runId/artifacts/:artifactId/metadata`：同一 verified entry 的 MIME、size 与 content digest。

删除 Canvas 实体不删除 artifact。当前尚无自动 GC；未来回收必须分析 runtime Canvas、Canvas Git、run log 和 manifest 的全局可达性。

## Canvas Git 分支、恢复与合并

Canvas Git 规范树只包含：

```text
tasks/<stable-key>.json
nodes/<stable-key>.json
collections/<stable-key>.json
edges/<stable-key>.json
receipts/<stable-key>.json
meta.json
```

编码和解码都运行完整 `CanvasDocument` 语义校验。新建分支前 checkpoint 来源分支；历史恢复总是创建新分支；merge preview 固定 source/target commit 与目标 runtime revision，确认后任一值变化都会要求重新预览。合并结果在写入 runtime 前再次解码和校验，拒绝 dangling ref、非法嵌套、重复 receipt 或不一致的 Agent origin。

`main` 受保护，分支操作由 daemon 管理的 UUID worktree 执行，不切换用户源码 checkout。Canvas Git 与用户源码 Git 物理隔离；已废弃的 source-binding HTTP 路径不属于当前协议。

## HTTP 接口速查

| 接口 | 用途 |
| --- | --- |
| `GET /health` | 确认 `canvas`、schema 3 与 reset 状态 |
| `GET /canvas` | 加载指定分支 envelope |
| `POST /canvas/commands` | CAS 提交一个 command |
| `POST /canvas/conflicts` | 从 daemon-owned revision 与 outbox journal 保存冲突分支 |
| `GET /canvas/status` | Canvas Git 状态 |
| `GET/POST /canvas/branches` | 分支列表与新建；DELETE 当前不支持并返回 405 |
| `GET /canvas/history` | 分页 checkpoint 历史 |
| `POST /canvas/checkpoints` | 手动 checkpoint |
| `POST /canvas/restores` | 从 checkpoint 恢复为新分支 |
| `POST /canvas/merges/preview`、`POST /canvas/merges` | 预览并显式确认语义 merge |
| `PUT /plugin-capabilities` | 注册 data-only artifact claim 快照并取得 digest |
| `POST /runs` | 使用 `RunIntent` 启动 Task-owned Run |
| `GET /runs`、`GET /runs/:id`、`GET /runs/:id/log` | Task Run 历史、摘要与永久日志 |
| `GET /projection-plans/:planId` | 读取 daemon 可信 plan 的待处理状态 |
| `GET /runs/:runId/artifacts/:artifactId[/metadata]` | 读取 manifest-backed artifact |

## 运维与切换

- 不要手工编辑或删除 `.gg/`、`artifacts/`。它们是 daemon 管理的持久状态，不是 build output。
- 当前运行时只读取 catalog 管理的 Project 状态，不读取 Workspace 根中的旧 Canvas 或归档。
- `.gg/` 和 `artifacts/` 必须保持源码 Git ignored；reset 在目标中发现 tracked file 会拒绝执行。
- 正常 `Ctrl+C` 会释放项目 lease。遇到 stale lease 不要直接删除锁；先停止并确认旧 daemon 已退出，再按错误提示进行人工核验。
- 当前 UI 与 daemon 只维护一套实现。旧状态只存在于初始化归档中，应用不会读取、查看或写回它。
