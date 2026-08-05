# Task-Centric Canvas V2

本文是 Canvas V2 的规范性架构文档。实现、测试与协议若和本文冲突，以本文定义的信任边界与不变量为准。V2 不迁移 V1 数据，也不允许 V1 前端与 V2 daemon 交叉写入同一分支。

## 1. 稳定领域边界

Canvas V2 把旧节点承担的内容、提示、运行状态、会话与产物职责拆为六个概念：

- **Task**：持久的目标与执行容器。保存标题、目标提示、锚点与来源；不保存运行日志或会话。
- **Run**：Task 的一次不可变执行尝试。保存实际提示、Canvas revision、事件、状态、权限等待与会话。
- **Node**：纯内容投影。保存插件类型、框体、文本或 payload；不保存 prompt、phase、session 或运行日志。
- **Artifact**：归 Run 所有的不可变文件。Node 只保存 `{ runId, artifactId }` 引用，多个 Node 可以共享同一 artifact。
- **Edge**：Node 与 Task 之间的类型化语义关系。`relation` 负责展示含义，`contextRole` 单独决定是否进入 Agent 上下文。
- **Collection**：用户显式保存的顶层布局集合。只负责成组、折叠和移动，不拥有 prompt、Run 或成员列表。

核心不变量：

1. 一个 Task 同时最多有一个活跃 Run；不同 Task 可以并发。
2. Task 与 Collection 均不可嵌套。
3. Task 成员 Node 以 `homeTaskId` 单向归属 Task；顶层 Node 或 Task 以 `collectionId` 单向归属 Collection。
4. 有 `homeTaskId` 的 Node 不得同时有 `collectionId`，除非先执行显式“移出任务”命令。
5. Collection 不保存 `memberIds`，避免双事实源与分支合并冲突。
6. Agent 不能声明 Canvas 实体 ID、坐标、payload、任意边或后续自动执行。
7. `file-write` 只生成 ghost 进度；真实 Node 只在 durable `close` 后由 daemon 的可信计划原子物化。
8. Agent task proposal 必须由用户在原 Task 中确认，确认只创建 draft Task，不启动 Run。
9. error、cancelled 或 interrupted Run 的合法 artifact 自动保留并可物化，Task 状态派生为 `partial`。
10. 在已有内容 Node 上提交提示默认创建派生 Task，原 Node 和 artifact 引用不被覆盖。
11. 删除 Node 或 Task 不删除 artifact；物理回收由未来的跨快照、Canvas Git 与 run log 可达性 GC 统一处理。

## 2. 持久 Canvas 文档

```ts
type CanvasEntityRef =
  | { kind: 'node'; id: string }
  | { kind: 'task'; id: string }

interface CanvasDocumentV2 {
  schemaVersion: 2
  nodes: CanvasNodeV2[]
  tasks: CanvasTaskV2[]
  collections: CanvasCollectionV2[]
  edges: CanvasEdgeV2[]
  receipts: CanvasReceiptV2[]
  everCreated: boolean
}

interface CanvasTaskV2 {
  id: string
  title: string
  goal: string
  anchor: { x: number; y: number }
  collectionId?: string
  origin:
    | { kind: 'user' }
    | { kind: 'agent-proposal'; parentTaskId: string; planId: string; proposalKey: string }
}

interface CanvasNodeV2 {
  id: string
  type: string
  frame: { x: number; y: number; w: number; h: number; z: number }
  title: string
  text?: string
  payload?: Record<string, unknown>
  artifactRefs: Array<{ runId: string; artifactId: string }>
  homeTaskId?: string
  collectionId?: string
  origin:
    | { kind: 'user' }
    | { kind: 'agent-output'; taskId: string; runId: string; planId: string; outputKey: string }
    | { kind: 'copied'; sourceNodeId: string }
}

interface CanvasCollectionV2 {
  id: string
  title: string
  anchor: { x: number; y: number }
}

interface CanvasEdgeV2 {
  id: string
  from: CanvasEntityRef
  to: CanvasEntityRef
  relation:
    | 'source'
    | 'produced'
    | 'derived'
    | 'modified'
    | 'references'
    | 'compares'
    | 'replaces'
    | 'depends-on'
  contextRole: 'full' | 'summary' | 'none'
  origin:
    | { kind: 'user' }
    | { kind: 'agent'; runId: string; planId: string }
}
```

Receipts 是不可重复副作用的持久证据。materialization receipt 保存 `planId/runId/taskId` 与 `outputKey → nodeId`；proposal acceptance/dismissal receipt 保存已处理的 proposal key。删除自动 Node 不删除 receipt，因此刷新、SSE 重放或崩溃恢复不会让它复活。

Canvas Git 只保存上述文档。以下状态不进入 Canvas 文档或 Git：

- daemon runtime：active run、状态、SSE cursor、权限等待、会话、生成日志缓存与 pending projection plan；
- branch-local IndexedDB view state：camera、selection、Task/Collection 展开状态、composer 草稿、pointer drag 临时坐标；
- artifact bytes 与原始 run JSONL。

Task 状态由最新 Run 派生为 `draft / queued / running / awaiting-permission / partial / done / error / cancelled`。Node 不显示虚假的 Run 状态；Agent 输出 Node 只标记“已产出”。

## 3. Canvas command 内核

所有持久变更必须经过前后端共享的纯 reducer：

```text
POST /canvas/commands
{ branch, baseRevision, mutationId, command }
```

规范命令包括：

- `CreateTask`、`UpdateTaskGoal`、`MoveEntities`
- `CreateCollectionFromSelection`、`AssignToCollection`、`DissolveCollection`
- `DeleteTask`、`DeleteCollection`、`DuplicateTaskAsDraft`
- `MaterializeProjectionPlan`、`AcceptTaskProposals`、`DismissPlan`

浏览器先把 command 与 base revision 写入 IndexedDB outbox，再乐观执行同一 reducer。daemon 在分支锁内读取当前 revision、重放 reducer、校验不变量，并以单个 `mutationId` 原子写入。成功返回 envelope 后浏览器确认 outbox。CAS 冲突时浏览器只允许 refetch 后重放一次；若命令前置条件已失效，必须进入显式冲突分支流程，禁止静默覆盖。

拖动时只更新本地临时坐标，`pointerup` 提交一次 `MoveEntities`。即时撤销通过提交反向 command 实现，因此同样进入版本历史。

`MaterializeProjectionPlan` 的 HTTP payload 只接受 `planId`。daemon 从永久 run log/plan store 读取带 digest 的可信 `ProjectionPlan`，再把内部 plan 交给 reducer；客户端永远不能提交 Node patch、ID 或坐标。该命令在一个 revision 中创建 Node、Task proposal receipt、typed Edge、确定性布局与 materialization receipt。

## 4. Task-owned Run

```ts
interface RunIntentV2 {
  schemaVersion: 2
  runId: string
  taskId: string
  agentId: string
  canvasBranch: string
  baseRevision: number
  prompt: string
  attachments: AttachmentRef[]
  materializationPolicy: 'auto'
}
```

启动 Run 前，浏览器必须先冲刷当前分支所有待保存 Canvas command。daemon 从 `canvasBranch + baseRevision` 对应的持久文档编译上下文，不接受浏览器上传的 canvas snapshot。指向 Task 且 `contextRole=full|summary` 的边决定输入：`full` 加入内容，`summary` 只加入标题、类型与摘要，`none` 不进入上下文。

会话键为 `canvasBranch + taskId + agentId`。Task 容器内“继续任务”复用会话；在产物 Node 上提交提示会先创建新的派生 Task，因此自然获得独立会话。RunManager 在保留全局容量限制的同时，对 `(project, branch, taskId)` 实施单活跃 Run 约束。

## 5. Run-owned Artifact

Run 的唯一可写产物根：

```text
artifacts/.branches/<branch-hash>/<runId>/files/<relative-path>
```

daemon 在 close settle 完成后生成 `.gg/runtime/runs/<runId>/artifact-manifest.json`：

```ts
interface ArtifactManifestV1 {
  version: 1
  runId: string
  complete: boolean
  entries: Array<{
    artifactId: string
    relativePath: string
    mediaType: string
    size: number
    contentDigest: string
  }>
}
```

`artifactId = hash(runId + normalizedRelativePath)`；内容摘要单独校验 bytes。Node 只持久化 `{ runId, artifactId }`。读取使用 `GET /runs/:runId/artifacts/:artifactId`，daemon 必须从已保存 manifest 反查路径并再次执行 no-follow、realpath、size 与 digest 校验。

`.ggai` 控制目录、symlink、traversal、socket/device、临时文件和 foreign-run 路径永远不进入 manifest 或 ProjectionPlan。失败、取消和中断只影响 `complete` 与 Task 派生状态，不允许绕过 artifact 校验。

## 6. Outcome 与可信 ProjectionPlan

Agent 可以在控制 sidecar 中提供受限的 `RunOutcomeV2`：0–5 个 suggested action、最多 32 个 output、最多 12 个 task proposal。每个 output 只声明稳定 key、run-relative path、plugin ID、role、标题和最多 8 个同 Run `derivedFrom` key。proposal 只声明 key、标题、prompt、输入 output key 与同一 proposal 集中的依赖 key，且依赖图必须无环。

解析器使用 allow-list，拒绝 runId、Canvas ID、坐标、payload、自由边端点、命令或自动执行字段。无效或缺失 outcome 不影响 Run 的终止结果。

daemon 将 raw outcome、ArtifactManifest 与序列化插件 artifact claim 求交集，生成带 digest 的 `ProjectionPlan`：

- agent-declared output 只有在 path 存在且插件 claim 接受时才保留；
- 其余 artifact 按插件 claim、MIME 与扩展名进行确定性 fallback；未知文件落入通用 file 插件；
- 最多 12 个 `primary/supporting` output 自动上画布，其余进入 Task 的 artifact tray；
- error/cancelled/interrupted plan 标记 `partial`，保留合法 artifact，但丢弃全部 task proposal；
- plan 记录 Task/Run、manifest digest、output key、artifactRefs、derivedFrom 与 proposal DAG，不含 Canvas ID 或坐标。

插件契约必须可序列化并声明 artifact claim；React 投影 hook 保持纯函数。核心不硬编码某个具体内容插件，但提供确定性的通用 file fallback。

## 7. 交互语义

### 创建与派生

- 空白画布提交目标直接创建零输出 Task，Agent 决定 output 类型。
- 空内容 Node 提交目标时创建 Task，并可把该 Node 作为指定插件的 primary output slot。
- 已有内容 Node 提交目标时创建派生 Task，并建立 `Node --source/modified--> Task`；原 Node 不变。
- 多选顶层 Node/Task 或已保存 Collection 上提交目标时创建新 Task，并从每个顶层输入建立普通 source Edge。
- Agent proposal 确认后创建零输出 draft Task 与依赖 Edge，不启动 Run。

### Task 容器

- 零输出显示完整 Task 卡片；一个输出显示弱化的 Task 标题条；两个以上显示完整外框。
- 折叠态显示 goal 摘要、artifact 数、缩略图与聚合状态；成员坐标保留但隐藏。
- 首次物化采用确定性网格，primary 优先、supporting 次之，只布局新增 Node，不重排已移动成员。
- 裂解后不 fit view、不转移焦点；`prefers-reduced-motion` 禁用扇出动画。
- 点 Node 选择内容，点 Task 标题或边框选择 Task；Shift 点击与框选永远只是临时多选。

### Collection 与 Edge

- “保存为集合”显式持久化当前顶层多选；不自动保存框选。
- Task 端口创建一条正式 Task Edge；Collection 端口是 UI macro，展开为成员的多条普通 Edge，Collection 本身不是 Edge 端点。
- collapsed Task/Collection 的外部 Edge 聚合到容器边界；展开或 hover 显示分叉。
- tool、search、warning 与 thinking 只属于 Run log，不创建语义 Edge。

### 删除、复制与恢复

- 删除 Task 默认释放其 output Node 为顶层 Node；“删除任务及全部视图”是独立确认动作。
- 删除活跃 Task 前先等待 daemon 取消确认；删除 Node 只删画布投影与 incident Edge。
- 解散 Collection 保留成员；删除 Collection 及内容必须二次确认。
- 复制 Task 只复制 goal 与输入 Edge，生成无 Run、无 output、无 session 的 draft。
- 复制 Node 可共享 artifact 引用，但 origin 改为 `copied`，不继承 materialization receipt。
- 复制 Collection 深复制顶层成员并重映射内部 Edge，不复制 runtime。

## 8. 版本历史与 reset

Canvas Git 的规范化树为：

```text
tasks/<id>.json
nodes/<id>.json
collections/<id>.json
edges/<id>.json
receipts/<stable-key>.json
meta.json
```

写 checkpoint、恢复与 merge commit 前均运行完整语义校验，拒绝 dangling ref、Task/Collection 嵌套、重复 origin key 与无 receipt 的重复 materialization。runtime、selection、camera、SSE cursor 和原始日志永不进入 Git。

V2 不提供 V1 数据迁移或旧画布查看器。显式 reset 脚本必须：

1. 要求 daemon 已停止并验证目标是合法项目根；
2. 将旧 `.gg/runtime`、`.gg/canvas-state` 和 `artifacts` 移入 `.gg/legacy-v1/<UTC timestamp>/`；
3. 初始化全新 V2 runtime；
4. 不触碰源码 Git、`app/.git`、tracked file 或用户源码 worktree。

开发期用前后端共同 capability `canvasModelV2` 隔离，双方 schema 不匹配时拒绝写入。V2 验证完成后默认开启；旧状态归档和回滚入口保留到稳定期结束，再删除 V1 写路径。

## 9. 验收门禁

必须覆盖以下层次：

- 模型：全部不变量、命令原子性、稳定 ID、receipt、删除/复制、布局幂等、typed-edge traversal。
- 协议与安全：路径逃逸、symlink、控制/临时文件、未知插件、重复 key、output 上限、proposal 环与伪造字段。
- daemon：Task session、同 Task 单并发、不同 Task 并发、取消、崩溃恢复、partial manifest、pending plan、CAS 冲突、分支隔离。
- UI：零/单/多 output 容器、折叠、选择、框选、整组拖动、端口、束线、proposal 编辑与焦点保持。
- 可访问性：真实 button、`aria-expanded`、group label、roving tabindex、键盘连接、live region 节流、状态不只依赖颜色。
- 版本历史：merge 前语义校验；Task/Node/Collection/Edge/receipt 身份与 artifact ref 在 checkpoint、恢复和合并后稳定。

基准场景“生成一个 ggplot 散点图”只执行一个 Run，得到一个 Task、一个代码 Node 和一个图像 Node；Task 到 Node 为 `produced`，代码到图像为 `derived`。刷新、SSE 重放、重复 close 与 CAS 重试不得重复创建；在图像 Node 上提交“调整配色”必须生成新的派生 Task，原图不变。

