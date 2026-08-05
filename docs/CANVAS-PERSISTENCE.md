# 画布持久化与版本管理

本文描述 GGAI 画布状态、运行日志和可选源码 Git 的事实源、写入顺序与恢复边界。

## 设计目标

- 页面刷新、浏览器崩溃或 daemon 重启后，节点、连线、视口与日志都可恢复。
- 高频拖拽不会产生一串无意义 Git commit；稳定保存后再合并为语义 checkpoint。
- 画布版本库与用户源码库隔离。画布功能不要求项目本身已经使用 Git。
- Git 降级不能阻断画布保存；所有危险删除、敏感文件提交和冲突处理都显式失败或等待确认。

## 四层数据

| 层 | 路径 | 职责 | 是否事实源 |
| --- | --- | --- | --- |
| 浏览器 journal | IndexedDB `ggai-canvas` | daemon 暂时不可用时保存最后一次本地编辑和相机位置 | 否，仅崩溃缓冲 |
| 画布快照 | `.gg/runtime/canvas/<branch-hash>/snapshot.json` | 当前分支完整画布、revision、mutationId、checkpoint 指针 | 是 |
| 运行记录 | `.gg/runtime/runs/<runId>/events.jsonl`、`events.idx`、`summary.json` | SSE 事件、分页索引、状态、恢复游标与日志回顾 | 是 |
| 画布历史 | `.gg/canvas-state/` | 规范化节点/连线、受限运行摘要、产物清单和可选源码 SHA 的 Git checkpoint | 历史事实源 |

`.gg/canvas-worktrees/` 和 `.gg/source-worktrees/` 是 daemon 管理的锁定 worktree；路径使用 UUID，逻辑分支名不会直接参与文件路径。新产物写入 `artifacts/.branches/<branch-hash>/<runId>/<nodeId>/`，每次运行不可变、跨分支不共享写目录；旧 `artifacts/<nodeId>/` 引用仍可读取。Git 中只记录产物清单，不提交大文件内容。

## 保存协议

1. 浏览器完成 hydration 前禁止编辑，避免空初始值覆盖服务端快照。
2. 每次语义变更先写 IndexedDB journal，再以 500 ms 防抖、最长 2 秒等待发送 `PUT /canvas`。
3. 请求携带 `baseRevision` 和唯一 `mutationId`。daemon 串行执行、校验 CAS，并用临时文件、`fsync`、原子 rename 写快照。
4. daemon 成功返回新 revision 后，浏览器才确认 journal；网络失败保留 journal 并重试。
5. 快照成功后约 3 秒合并一次画布 Git checkpoint。Git 失败只把版本状态标为 `degraded`，不会撤销已经落盘的快照。

同一个 `mutationId` 的同 revision 重试是幂等的；旧 revision 的不同 mutation 返回 `409 canvas_revision_conflict`，客户端不得静默覆盖。

每个项目同时只允许一个 daemon 持有 `.gg/runtime/canvas-daemon.lock`。画布、运行日志、会话、偏好和版本操作共享该项目租约，避免两个进程各自通过进程内 CAS 后互相覆盖。

## 刷新与运行重连

画布快照保存每个节点的 `runId` 与最后消费的 SSE event id。刷新时浏览器先加载快照和本地 journal，再查询 run 摘要：

- 仍在运行：以 `Last-Event-ID` 重连，只补消费缺失事件。
- daemon 重启：未完成的持久摘要会变为 `interrupted`，已有 JSONL 日志仍可回顾。
- SSE 内存窗口出现 gap：通过 run log 分页接口补齐，再恢复实时订阅。
- 组件卸载或刷新只断开订阅；只有用户点击“取消”才调用取消接口终止 Agent。

Agent 会话按 `canvasBranch + nodeId + agentId` 隔离；旧的双字段会话键只作为 `main` 分支读取。相同节点 ID 在不同分支不会复用 thread，也不会互相阻塞。

原始 JSONL 日志不进入画布 Git，避免敏感输出和高频 token 流污染历史。

## 分支与恢复

- `main` 是受保护分支。
- 新建分支前强制 checkpoint 来源分支，再创建独立、锁定的 UUID worktree，并物化新的运行时快照。
- 切换分支使用 URL `?branch=...`，重新走完整 hydration，不复用另一分支的内存状态。
- 历史恢复永远创建新分支，不就地回退当前分支。
- 每个已绑定源码的画布 checkpoint 都记录当时的精确 Source HEAD。恢复历史时，源码 worktree 从该 SHA 创建；旧版、确实没有源码元数据的 checkpoint 才会只恢复画布。若 checkpoint 声明了源码 SHA 但源码仓库当前不可用，操作会明确报告部分恢复，不会伪装成完整成功。
- 删除只允许非 `main`、干净且已安全合并的受管分支；删除前会在分支锁内强制 checkpoint 最新 runtime，绝不丢弃仍在 debounce 窗口中的编辑，也不会使用 `--force`。
- 保存、checkpoint、创建、恢复、合并和删除按涉及的分支统一串行；正在运行 Agent 的分支不能被删除、合并或重建 worktree。
- 合并执行必须回传预览时的 Canvas commit、运行时 revision 和 Source commit 期望值；任一层在用户确认后变化都会返回 `merge_preview_stale`，要求重新预览。

## 可选源码 Git

源码版本管理必须由用户显式绑定。项目不是 Git 仓库时，画布版本管理仍完整可用。绑定时 daemon 会：

- 要求当前源码 worktree 干净，且 `.gg/`、`artifacts/` 没有被跟踪；
- 使用 `ggai/<canvas-branch>` 创建独立 worktree，不切换用户当前 checkout；
- 绑定后 Agent 的可写工作目录就是该画布分支对应的受管源码 worktree；未绑定时源码保持只读；
- 在每个 Agent 修改批次后生成带 runId 的 checkpoint；
- 对 `.env`、密钥/证书以及超大变更返回确认要求，不自动提交；
- 合并冲突返回结构化文件清单并保持仓库可恢复，不自动接受 Agent 建议。

默认自动化模式为 `confirm`。版本面板可先检查安全变更并提交；敏感变更会显示脱敏后的风险与路径，要求二次明确确认。后端会把确认绑定到同一 runId、HEAD 和文件内容，预览后发生任何变化都必须重新检查，不能直接伪造 `allowSensitive=true`。切换为 `auto` 也只自动执行低风险、无冲突操作，不能绕过敏感文件和破坏性操作门禁。

## HTTP 接口

| 接口 | 用途 |
| --- | --- |
| `GET/PUT /canvas` | 加载和 CAS 保存分支快照 |
| `GET /canvas/status` | 画布 Git 与源码 Git 状态 |
| `GET/POST/DELETE /canvas/branches` | 分支列表、新建、安全删除 |
| `GET /canvas/history` | 分页 checkpoint 历史 |
| `POST /canvas/checkpoints` | 手动 checkpoint |
| `POST /canvas/restores` | 从历史恢复为新分支 |
| `POST /canvas/merges/preview`、`POST /canvas/merges` | 预览并明确确认分支合并；冲突不自动应用 |
| `GET /canvas/source`、`POST /canvas/source/bind` | 查询或显式绑定源码 Git |
| `POST /canvas/source/checkpoints` | 安全提交一次源码变更批次 |
| `GET/PUT /canvas/preferences` | 项目级自动化偏好 |
| `GET /runs`、`GET /runs/:id`、`GET /runs/:id/log` | 运行摘要与永久日志 |
| `DELETE /runs/:id/log` | 只删除已终止运行的原始日志，保留摘要 |

## 运维与恢复

- 不要手工编辑 `.gg/`。需要迁移时复制整个 `.gg/runtime/` 和 `.gg/canvas-state/`。
- 无效 JSON 会被移动到同目录 quarantine 文件，daemon 拒绝继续覆盖，必须显式恢复。
- 若 Git 不可用，先继续工作；快照仍安全。修好 Git 后执行一次手动 checkpoint 即可重新建立历史锚点。
- `.gg/` 和 `artifacts/` 必须保留在源码仓库 ignore 中；daemon 也会写本地 exclude 作为第二道保护。
- 不要手工复用或覆盖新产物目录；旧引用和分支历史依赖其不可变语义。产物 GC 必须按画布快照、Canvas Git 历史和 run log 的可达性另行执行。
- 正常 `Ctrl+C` 会释放项目 lease。若 daemon 被强制杀死，系统为避免两个写进程竞态而不会自动抢占旧锁；确认已经没有 daemon 进程后，手工删除项目内唯一的 `.gg/runtime/canvas-daemon.lock` 再启动。

## 当前扩展性边界

- 运行摘要读取已限制为 16 路并发，启动恢复会检查全部记录；历史列表为保证按时间排序，目前仍是 O(总 run 数)。超大历史后续应增加持久化时间索引。
- `sessions.json` 仍按项目整体原子重写，分支删除暂不回收对应 session；节点、分支和 Agent 组合极多时应迁移到分片或嵌入式数据库。
- 不可变产物和 `.gg/context/runs/` 当前没有自动 GC。删除前必须先做跨运行时快照、Canvas Git 历史和 run log 的可达性分析，不能只按“当前画布未引用”判断。
