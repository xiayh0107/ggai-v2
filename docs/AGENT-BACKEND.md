# Agent Daemon 后端（Canvas）

> 前置阅读：[`AGENT-ARCHITECTURE.md`](./AGENT-ARCHITECTURE.md)、[`CANVAS.md`](./CANVAS.md) 与 [`CANVAS-PERSISTENCE.md`](./CANVAS-PERSISTENCE.md)。
> daemon 不实现 Agent loop；它负责可信上下文、Run 生命周期、日志、artifact 校验、ProjectionPlan 与持久 command 边界。

## 当前运行形态

- 原生 Node HTTP + SSE 服务，只绑定 `127.0.0.1:7380`；
- 默认 transport 为本机 `codex exec --json`，acpx 是显式 opt-in 的实验性备选；
- daemon 与 `/canvas` 前端入口均只运行 Canvas；
- 新项目由 daemon catalog 原子创建，并写入绑定自身 opaque id 的 marker；
- 已废弃的 snapshot/Node Run/source-binding API 已从生产路由移除，不存在运行时模式切换。

开发与验证：

```bash
npm run dev
npm run test:daemon
npm run build
```

## 一、核心职责

1. **Canvas command**：执行共享 reducer、revision CAS、exactly-once mutation ledger、语义 revision archive 与 Canvas Git checkpoint。
2. **Task Run**：严格解析 `RunIntent`，从持久 branch/revision 编译上下文，对同 Task 强制单活跃 Run。
3. **Transport**：启动/恢复/取消 Agent CLI，翻译为统一 `CanvasAgentEvent`，处理进程组清理和 daemon shutdown。
4. **永久记录**：写 JSONL、分页索引、summary 与终态 close；重启时把未完成 Run 结算为 interrupted。
5. **Artifact**：只授权本 Run 的 `files/`，durable close 时生成 manifest，并在每次读取时复验路径、size 与 digest。
6. **可信投影**：校验 `RunOutcome`，与 manifest 和固定插件能力求交集，生成 ProjectionPlan，再通过 daemon-only command 原子物化。
7. **Task session**：以 `canvasBranch + taskId + agentId` 保存 session，供 Task 内继续执行 resume。

daemon 不存用户凭证、不监听外网、不让 Agent 直接改 Canvas、不接受浏览器整文档 snapshot，也不让 Agent 声明实体 ID、坐标、payload、自由 Edge 或自动运行 proposal。

## 二、关键模块

```text
daemon/
├── server.ts                       # HTTP/CORS/SSE 边界
├── runs.ts                         # Run 生命周期、并发租约、取消、恢复与结算
├── runLogs.ts                      # durable JSONL / index / summary / close
├── canvasCommandProtocol.ts        # command 与 conflict journal 严格 wire parser
├── canvasCommandStore.ts           # revision CAS、mutation ledger、revision archive
├── workspaceVersioning.ts          # checkpoint、分支、恢复、merge、冲突分支
├── canvasGit.ts                    # 规范化 Canvas Git/worktree
├── taskRunProtocol.ts              # RunIntent parser
├── taskSessions.ts                 # Task-owned session store
├── runArtifactStorage.ts           # Run-owned files/manifest/lookup
├── outcome.ts                      # 受限 Agent sidecar reader
├── projectionPlan.ts               # outcome × manifest × claims
├── projectionPlanStore.ts          # durable pending/dismissed plan
├── pluginCapabilities.ts           # 固定、内容寻址的插件能力快照
├── packer.ts                       # Task/typed-edge 上下文包
├── translator.ts                   # transport event → CanvasAgentEvent
├── permissions.ts                  # project、path、command 安全边界
└── transport/                      # Codex / acpx / process adapter
```

## 三、HTTP 面

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 返回 Canvas schema、初始化状态和能力 |
| GET | `/agents` | 探测允许的本地 Agent CLI |
| GET | `/projects` | 读取显式 Project Catalog、可用状态与只读 Canvas 摘要 |
| POST | `/projects` | 以 `{ title }` 创建 daemon-owned 空白项目 |
| POST | `/projects/:id/open` | 校验项目身份和 lease，成功后记录最近打开时间 |
| GET | `/canvas?projectDir=&branch=` | 读取 Canvas envelope |
| POST | `/canvas/commands?projectDir=` | `{ branch, baseRevision, mutationId, command }` |
| POST | `/canvas/conflicts?projectDir=` | 从 daemon-owned revision 重放 outbox 到新分支 |
| GET/POST | `/canvas/branches` | 列表与新建分支；DELETE 当前显式返回 405，历史不被丢弃 |
| GET | `/canvas/status`、`/canvas/history` | 版本状态与 checkpoint 历史 |
| POST | `/canvas/checkpoints`、`/canvas/restores` | 手动 checkpoint、恢复到新分支 |
| POST | `/canvas/merges/preview`、`/canvas/merges` | 语义 merge 预览与确认执行 |
| PUT | `/plugin-capabilities?projectDir=` | 注册 community data-only claims，返回固定 digest |
| POST | `/task-runs/preflight?projectDir=` | 只读检查 Agent、revision、附件与 Skills；结果不是启动票据 |
| GET | `/task-runs/:runId/reproducibility?projectDir=` | 读取不暴露 digest/provider 的历史运行环境摘要 |
| POST | `/runs?projectDir=&pluginCapabilityDigest=` | 启动严格 `RunIntent`；成功为 HTTP 202 |
| GET | `/runs?projectDir=&taskId=&branch=` | 查询 Task Run 历史 |
| GET | `/runs/:id`、`/runs/:id/log` | Run summary 与永久日志分页 |
| GET | `/runs/:id/events` | durable-id SSE；支持 `Last-Event-ID` |
| POST | `/runs/:id/cancel` | 取消并等待进入终态 |
| GET | `/projection-plans/:planId?projectDir=&branch=` | 读取 pending 可信计划 |
| GET | `/runs/:runId/artifacts/:artifactId` | 读取 manifest-backed bytes |
| GET | `/runs/:runId/artifacts/:artifactId/metadata` | 读取 verified MIME/size/digest |

`MaterializeProjectionPlan`、`AcceptTaskProposals` 和 `DismissPlan` 在浏览器 wire 上只携带 `planId` 与受限选择/编辑字段。server 从 plan store 取 daemon-owned 完整计划，再交给 reducer。`DELETE /runs/:id/log` 返回 405 `run_log_delete_unsupported`。

`/task-runs/preflight` 的稳定 issue code、输入边界与 advisory 安全语义见
[`RUN-PREFLIGHT.md`](./RUN-PREFLIGHT.md)。真实 Run 创建仍在 acceptance reservation 后重复所有
revision、附件、Skill 与 capability 校验。

已废弃的整文档 Canvas PUT、`/artifacts?path=`、Node session 和 `/canvas/source*` 不属于当前 API；客户端不能通过这些路径绕过 command、Task session 或 manifest-backed artifact 边界。

## 四、一次 Task Run 的时序

```text
browser outbox ──flush──> POST /canvas/commands
       │
       └─> PUT /plugin-capabilities ──> digest
                                             │
POST /runs RunIntent + digest               │
       │                                      │
       ▼                                      │
daemon 从 branch/revision 读取 Task + typed-edge inputs
       │
       ├─> 解析显式 Node/artifact attachments，复验 closed manifest
       ├─> Workspace SkillResolver 解析 exact refs，Core 固定已验证 bytes
       ├─> 创建 Run capability scope，固定 receipt
       ├─> receiptStore.pin() ──> durable summary
       ├─> .gg/context/runs/<runId>/pack.{md,json}
       ├─> 固定 plugin-capabilities.json
       ├─> 查 task session，spawn/resume transport
       ├─> durable event log ──SSE──> ghost progress / permission UI
       └─> Agent 写 artifacts/.../<runId>/files/
                                      │
                                      ▼ durable close
                 ArtifactManifest + optional RunOutcome
                                      │
                                      ▼
                           trusted ProjectionPlan
                                      │
                    ┌─────────────────┴─────────────────┐
                    ▼                                   ▼
             auto materialize                  proposal review only
             Node/Edge/receipt                 user confirm → draft Task
```

`file-write` 不是 Node 创建凭证。只有 durable close 之后 verified artifact 才能物化。error、cancelled、interrupted Run 的合法文件进入 partial plan；这些终态不采用 task proposal。

## 五、Artifact 与插件能力

物理布局固定为：

```text
artifacts/.branches/<branch-hash>/<runId>/
├── files/<relative-path>
├── files/.ggai/run-result.json          # Agent 可选 control sidecar；不投影
└── .ggai/artifact-manifest.v1.json      # daemon 写入；不可变
```

manifest entry 保存 `artifactId`、normalized relative path、MIME、size 和 content digest。`.ggai`、临时文件、symlink、hardlink/foreign file、socket/device 与 traversal 永不进入 manifest。读取 API 从 manifest 反查，并再次执行 no-follow、realpath、inode/size/digest 检查。

浏览器只注册 community data-only claims；daemon-owned built-in registry 不能被覆盖，只有内置 `file` fallback 可以接收 unknown artifact。规范化 registry 按 digest 保存到 `.gg/runtime/plugin-capabilities-v2/`。live Run 指定的 digest 缺失或损坏时拒绝启动；crash recovery 最多降级使用内置 claims，不信任无法恢复的 community 分类。

## 六、持久化布局

```text
project/
├── .gg/
│   ├── canvas-model.json
│   ├── workspace/
│   │   ├── projects.json                  # 显式 catalog；不扫描普通目录
│   │   └── projects/<opaque-project-id>/  # daemon-owned 空白项目目录
│   ├── runtime/
│   │   ├── canvas/<branch-hash>/snapshot.json
│   │   ├── canvas/<branch-hash>/revisions/<revision>.json
│   │   ├── runs/<runId>/{events.jsonl,events.idx,summary.json} # 固化 prompt/baseRevision
│   │   ├── projection-plans/<branch-hash>.json
│   │   ├── plugin-capabilities-v2/<digest>.json
│   │   ├── capability-receipts-v1/<runId>.json
│   │   ├── task-sessions-v2.json
│   │   └── canvas-daemon.lock
│   ├── canvas-state-v2/                  # 独立 Canvas Git
│   ├── canvas-worktrees-v2/              # daemon 锁定 worktree
│   ├── context/runs/<runId>/              # 不可变 Run 上下文
│   ├── context/{pack.md,pack.json,AGENTS.md} # 最近一次调试视图
│   └── runs/<runId>/                      # Codex 最小隔离 cwd
└── artifacts/.branches/<branch-hash>/<runId>/
```

`.gg/` 与 `artifacts/` 是 daemon-managed persistent state，不是构建缓存；不得手工修改或作为普通 build output 删除。

## 七、安全与故障边界

1. 所有 `projectDir` 必须 canonical resolve 在 `--project-root` 内；拒绝 traversal 和 symlink component。
2. daemon 与 reset 共享维护栅栏；项目 lease 防止两个 daemon 各自通过进程内 CAS 后互相覆盖。
3. Workspace 根只承载 catalog、Skills 与节点定义等工作空间级控制资产，不是 Project；Project 只来自 catalog 中的 opaque identity，受管 marker 必须绑定自身 ID，Agent 不得写 `.gg/workspace/`。
4. HTTP 只绑定回环地址，Origin 精确 allow-list，JSON/查询参数/图规模/订阅数均有边界。
5. source resolver 只校验 branch/lease 并返回空 source cwd；Codex 因此在 `.gg/runs/<runId>` 的最小 cwd 中执行，项目根只作为 prompt 中的只读引用，另以 `--add-dir` 授权该 Run 的 `files/`。
6. acpx 默认禁用；启用后 named session 强制单飞，取消先 cooperative cancel，再清理本地进程。
7. daemon 只调用 CLI 登录探针，不读取、复制或持久化 token/key。
8. outcome 或 community plugin snapshot 不是权限凭证；无效输入失败关闭或安全降级，不能扩大文件或 Canvas 写权限。

Workspace 根不承载 Canvas 或 Run 状态；旧根项目状态必须在 daemon 停止后迁出，不能作为当前事实源继续读取。
