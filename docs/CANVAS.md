# Task-Centric Canvas

相关运行时契约另见 [Node executions](./NODE-EXECUTIONS.md) 与
[editable asset assembly](./ASSET-ASSEMBLY.md)，以及 [container compute](./COMPUTE.md)。
工作区文件的 opaque root、CAS 和冲突语义见 [filesystem bindings](./FILESYSTEM.md)。
Agent 整图构建的信任边界见 [validated graph proposals](./GRAPH-PROPOSALS.md)。

本文是 Canvas 的规范性架构文档。实现、测试与协议若和本文冲突，以本文定义的信任边界与不变量为准。节点、社区插件与 Agent 上下文的映射另见 [`PLUGIN-CONTEXT-CONTRACT.md`](./PLUGIN-CONTEXT-CONTRACT.md)。仓库只维护一套当前实现；已归档格式不能和当前 daemon 交叉写入同一分支。

## 1. 稳定领域边界

Canvas 把旧节点承担的内容、提示、运行状态、会话与产物职责拆为六个概念：

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
11. 从画布移除 Node 或 Task 不删除 Run-owned artifact；资源库的「生成内容」provider
    从 closed manifest 独立索引这些资源。移除 Task 的最后一个输出 Node 时，同一
    command revision 必须同时移除失去输出的 Task 与相关 Edge；物理回收由未来的
    跨快照、Canvas Git 与 run log 可达性 GC 统一处理。
12. `parentId` 是 containment 唯一事实源；child 不保存 Task/Collection scope，最大深度 32，
    reparent 保持 world transform 并拒绝 cycle。
13. `data` Edge 必须从注册 output port 指向相同 schema 的 input port，`contextRole` 固定为
    `none`；cardinality-one input 最多一条入边。

## 2. 持久 Canvas 文档

```ts
type CanvasEntityRef =
  | { kind: 'node'; id: string; port?: string }
  | { kind: 'task'; id: string }

interface CanvasDocument {
  schemaVersion: 3
  nodes: CanvasNode[]
  tasks: CanvasTask[]
  collections: CanvasCollection[]
  edges: CanvasEdge[]
  receipts: CanvasReceipt[]
  everCreated: boolean
}

interface CanvasTask {
  id: string
  title: string
  goal: string
  anchor: { x: number; y: number }
  collectionId?: string
  origin:
    | { kind: 'user' }
    | { kind: 'agent-proposal'; parentTaskId: string; planId: string; proposalKey: string }
}

interface CanvasNode {
  id: string
  typeRef: { id: string; revision: number; digest: string }
  parentId: string | null
  orderKey: string
  bounds: { w: number; h: number }
  transform: { matrix: [number, number, number, number, number, number] }
  coordinateSpace?: { unit: 'px' | 'pt' | 'in' | 'normalized'; dpi?: number }
  title: string
  text?: string
  payload?: Record<string, unknown>
  artifactRefs: Array<{ runId: string; artifactId: string }>
  skillBindings?: {
    inheritType: boolean
    skills: Array<{ skillId: string; revision: number; digest: string }>
  }
  selectedExecutionId?: string
  bindingId?: string
  instanceRef?: { definitionId: string; revision: number; digest: string }
  homeTaskId?: string
  collectionId?: string
  origin:
    | { kind: 'user' }
    | { kind: 'agent-output'; taskId: string; runId: string; planId: string; outputKey: string }
    | { kind: 'copied'; sourceNodeId: string }
}

interface CanvasCollection {
  id: string
  title: string
  anchor: { x: number; y: number }
}

interface CanvasEdge {
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
    | 'data'
  contextRole: 'full' | 'summary' | 'none'
  orderKey?: string
  origin:
    | { kind: 'user' }
    | { kind: 'agent'; runId: string; planId: string }
}
```

Canvas receipts 是投影副作用的持久证据。materialization receipt 保存 `planId/runId/taskId` 与 `outputKey → nodeId`；proposal acceptance/dismissal receipt 保存已处理的 proposal key。删除自动 Node 不删除 receipt，因此刷新、SSE 重放或崩溃恢复不会让它复活。它们与 runtime snapshot 内部的 command mutation receipt 不是同一概念：后者记录 `mutationId`、command digest 与 committed revision，只服务 HTTP exactly-once，不进入 Canvas 文档、API envelope 或 Git。

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

- `CreateTask`、`UpdateTaskGoal`、`CreateNode`、`UpdateNodeContent`、`ResizeNode`
- `SetNodeBounds`、`SetNodeTransform`、`ReparentNodes`、`ReorderChildren`
- `CreatePortEdge`、`SelectNodeExecution`、`BindNodeToFilesystem`
- `UpdateNodeSkillBindings`（节点实例级任务能力；类型默认绑定由 Workspace catalog 管理）
- `CreateEdge(s)`、`UpdateEdge`、`DeleteEdge(s)`、`MoveEntities`
- `CreateTaskForOutputSlot`、`CreateDerivedTaskFromSelection`、`AssignNodeToTask`、`DetachNodeFromTask`
- `CreateCollectionFromSelection`、`AssignToCollection`、`RemoveFromCollection`、`DissolveCollection`
- `DeleteTask`、`DeleteTaskAndViews`、`DeleteCollection`、`DeleteCollectionAndContents`
- `DuplicateNode`、`DuplicateTaskAsDraft`、`DuplicateCollection`
- `MaterializeProjectionPlan`、`AcceptTaskProposals`、`DismissPlan`

Node execution 的独立状态机、output/cache 限制与 provenance API 见
[`NODE-EXECUTIONS.md`](./NODE-EXECUTIONS.md)。

浏览器先把 command、base revision 与不可变 `initialBaseRevision` 写入 IndexedDB outbox，再乐观执行同一 reducer。daemon 在分支锁内读取当前 revision、重放 reducer、校验不变量，并以单个 `mutationId` 原子写入。runtime snapshot 持久保存 `mutationId → command digest + committed revision`；因此成功响应丢失、后续 revision 已前进或 daemon 重启后，相同 mutation 的重试仍只返回当前规范 envelope，不重复副作用。复用 mutationId 提交不同 command 会被拒绝。

每个语义 revision 同时归档在 `.gg/runtime/canvas/<branch-hash>/revisions/<revision>.json`，包含 document digest。CAS 冲突时浏览器只允许 refetch 后重放一次；若再次冲突或前置条件失效，必须进入显式冲突分支流程，禁止静默覆盖。`POST /canvas/conflicts` 只接受 `sourceBranch/newBranch/baseRevision` 和最多 500 条原始 mutation journal；daemon 从自己的历史 revision 读取基底并纯重放到新分支，浏览器不能上传 Canvas snapshot。相同恢复可幂等重试，同名分支已有不同内容则失败。

拖动时只更新本地临时坐标，`pointerup` 提交一次 `MoveEntities`。普通动作的即时撤销通过提交反向 command 实现，因此同样进入版本历史。节点的「从画布移除」在二次确认后立即提交，确保刷新、切页或关闭窗口不会让节点复活；需要恢复时使用版本历史。其他仍提供延迟撤销的破坏性动作，先使用同一 reducer 生成 branch-local pending-deletion 投影，超时才提交，提交前失败则恢复原投影并提示。

`MaterializeProjectionPlan` 的 HTTP payload 只接受 `planId`。daemon 从永久 run log/plan store 读取带 digest 的可信 `ProjectionPlan`，再把内部 plan 交给 reducer；客户端永远不能提交 Node patch、ID 或坐标。该命令在一个 revision 中创建 Node、Task proposal receipt、typed Edge、确定性布局与 materialization receipt。

## 4. Task-owned Run

```ts
interface RunIntent {
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

参与 Task 的 Node 还会贡献明确绑定的 Node skills。daemon 在接受时合并类型默认与实例
继承/替换绑定，固定每个 skill 的 revision、digest、完整文件和来源 Node，再写入 Run 专属
context。Agent 默认 skills 目录不会被隐式扫描，skill 也不扩大 typed-edge、attachment、artifact
或 Canvas 权限。完整规范见 [`NODE-SKILLS.md`](./NODE-SKILLS.md)。

`attachments` 只接受 artifact identity 或 Node ID。显式 Node attachment 会在该持久 revision 上固化为有界的 `title/type/text/payload/artifactRefs` 快照，并在 pack 中与 typed-edge input 分区；其中每个 artifact identity 仍必须通过已关闭 manifest 的路径、size 与 digest 复验，任一引用不可用都会在创建 Run 前失败关闭。浏览器不能随 attachment 提交路径或内容。Run 的 durable summary 保存接受时的实际 `prompt` 与 `baseRevision`，因此终态、重启和 interrupted recovery 都保留可审计的执行意图。

会话键为 `canvasBranch + taskId + agentId`。Task 容器内“继续任务”复用会话；在产物 Node 上提交提示会先创建新的派生 Task，因此自然获得独立会话。RunManager 在保留全局容量限制的同时，对 `(project, branch, taskId)` 实施单活跃 Run 约束。

## 5. Run-owned Artifact

Run 的唯一可写产物根：

```text
artifacts/.branches/<branch-hash>/<runId>/files/<relative-path>
```

daemon 在 close settle 完成后生成 `artifacts/.branches/<branch-hash>/<runId>/.ggai/artifact-manifest.v1.json`；Agent 可写文件仍全部位于相邻的 `files/` 根：

```ts
interface ArtifactManifest {
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

`artifactId = hash(runId + normalizedRelativePath)`；内容摘要单独校验 bytes。Node 只持久化 `{ runId, artifactId }`。读取使用 `GET /runs/:runId/artifacts/:artifactId`，元数据使用同路径的 `/metadata` 后缀；daemon 必须从已保存 manifest 反查路径并再次执行 no-follow、realpath、size 与 digest 校验。

资源库的项目级「生成内容」catalog/provider 使用
`GET /artifact-catalog?projectDir=...` 枚举已关闭 Task Run 的 manifest。完整 Run 会列出
全部验证通过的资源；失败、取消或中断 Run 的 partial manifest 也会逐项验证并保留安全
条目，同时把当前子视图标记为 `partial`。响应通过 opaque
`nextCursor` 续页，不得用固定上限让旧资源永久不可达。该目录不读取当前 Canvas Node，
因此从画布移除最后一个引用后资源仍可发现；目录项只提供不可变身份与已验证元数据，
实际预览或下载仍必须经过上述 artifact 读取端点的 descriptor-bound 完整性复验。
这个 catalog 是资源库的一个 provider，不是资源库本身；其它 provider 不得借用 artifact
manifest，也不得扫描项目根目录来推断文件、数据、连接或能力。资源库完整边界见
[`RESOURCE-LIBRARY.md`](./RESOURCE-LIBRARY.md)。

`.ggai` 控制目录、symlink、traversal、socket/device、临时文件和 foreign-run 路径永远不进入 manifest 或 ProjectionPlan。失败、取消和中断只影响 `complete` 与 Task 派生状态，不允许绕过 artifact 校验。

## 6. Outcome 与可信 ProjectionPlan

Agent 可以在控制 sidecar 中提供受限的 `RunOutcome`：0–5 个 suggested action、最多 32 个 output、最多 12 个 task proposal。每个 output 只声明稳定 key、run-relative path、plugin ID、role、标题和最多 8 个同 Run `derivedFrom` key。proposal 只声明 key、标题、prompt、输入 output key 与同一 proposal 集中的依赖 key，且依赖图必须无环。

解析器使用 allow-list，拒绝 runId、Canvas ID、坐标、payload、自由边端点、命令或自动执行字段。无效或缺失 outcome 不影响 Run 的终止结果。

daemon 将 raw outcome、ArtifactManifest 与序列化插件 artifact claim 求交集，生成带 digest 的 `ProjectionPlan`：

- agent-declared output 只有在 path 存在且插件 claim 接受时才保留；
- 其余 artifact 按插件 claim、MIME 与扩展名进行确定性 fallback；未知文件落入通用 file 插件；
- 最多 12 个 `primary/supporting` output 自动上画布，其余进入 Task 的 artifact tray；
- error/cancelled/interrupted plan 标记 `partial`，保留合法 artifact，但丢弃全部 task proposal；
- plan 记录 Task/Run、manifest digest、output key、artifactRefs、derivedFrom 与 proposal DAG，不含 Canvas ID 或坐标。

节点类型必须可序列化并声明 artifact claim。浏览器启动 Run 前把启用的 community data-only claims 注册到 `PUT /plugin-capabilities`。daemon 将不可覆盖的 builtins、受信 runtime contributions 和 community claims 合并为带 provenance 的当前快照，按 digest 保存到 `.gg/runtime/plugin-capabilities/<digest>.json`，并把 digest 与快照固定到 Run、Capability Receipt、上下文包和恢复摘要。只有 built-in `file` 可以声明 unknown fallback；Provider 热更新只影响尚未接受的新 Run，旧格式不参与恢复。

## 7. 交互语义

### 创建与派生

- 双击画布空白处打开创建菜单，按插件类型直接创建空内容 Node；创建后可立即在该 Node 上提交目标。全局画布工具条不重复提供创建入口；节点派生创建继续由连接端口承担。
- Canvas 左侧工具条是项目级管理导航，提供节点搜索与定位、节点 / 图层管理、生成内容、历史记录和节点能力库；它不承载连线、格式、复制、移除等节点上下文操作，也不重复选择、抓手、缩放等直接画布手势。生成内容与历史记录不再重复常驻顶栏。
- 左侧入口共享同一个可收起的 Canvas 工作台面板。节点搜索按实例名称、插件类型和所属 Task
  过滤并通过 branch-local camera / selection 定位；节点管理通过 `UpdateNodeContent` 编辑通用实例名称，
  节点类型定义进入 Node Studio，不开放任意 payload 编辑器。
- 项目资源面板只读取当前 project / branch 的可信 artifact catalog，并把完整管理交给资源库；Skills
  面板读取 Workspace skill catalog，类型默认只读展示，实例继承或替换通过
  `UpdateNodeSkillBindings` command 保存。没有可信放置协议前，工作台不得伪造“拖入画布”。
- 空白画布提交目标直接创建零输出 Task，Agent 决定 output 类型。
- 空内容 Node 提交目标时创建 Task，并可把该 Node 作为指定插件的 primary output slot。
- 空内容 Node 已有 `full/summary` 入边时，创建输出槽 Task 必须在同一 command 中把唯一来源提升为直接 Task 输入；`full` 优先于 `summary`，`none` 不提升。UI 来源标签与编译后的 Task inputs 必须一致。
- 已有内容 Node 提交目标时创建派生 Task，并建立 `Node --source/modified--> Task`；原 Node 不变。
- 多选顶层 Node/Task 或已保存 Collection 上提交目标时创建新 Task，并从每个顶层输入建立普通 source Edge。
- Task 内部 Node 可通过节点菜单「移出任务」释放为顶层 Node（可撤销）。
- Agent proposal 确认后创建零输出 draft Task 与依赖 Edge，不启动 Run。

### Task 容器

- 未运行的零输出 draft 显示完整 Task 卡片；零输出 Task 进入 active Run 后立即投射带通用节点
  头部、活动状态和同一运行控件的临时节点，不等待 Agent 的首个 output/path 事件，也不显示
  「尚无产物」残壳。类型专属能力只在真实类型落地后开放。有输出时 Node 是视觉核心：
  Task 标题条弱化并直接附着在最上方输出 Node 的顶边，多输出时附产物计数，不再绘制包裹全部成员的巨大外框。
- 折叠态显示 goal 摘要、artifact 数、缩略图与聚合状态；成员坐标保留但隐藏。
- 首次物化采用确定性网格，primary 优先、supporting 次之，只布局新增 Node，不重排已移动成员。
- 派生 Task 锚定在来源内容下方，第一个输出 Node 不与原 Node 重叠。
- 裂解后不 fit view、不转移焦点；`prefers-reduced-motion` 禁用扇出动画。
- 点 Node 选择内容，点 Task 标题或边框选择 Task；Shift 点击与框选永远只是临时多选。

### Collection 与 Edge

- 节点管理面板以 `parentId + orderKey` 显示层级树，reparent/reorder 只派发共享 command。
- 可包含子节点的类型支持双击进入隔离编辑；Esc 或隔离条退出。descendant 使用 parent-local
  transform，Stage 与 Edge layer 都从同一 world-transform selector 取几何。
- 选中节点的工具条显示声明式 named ports。数据连线只能 output→input、schema 完全相同，
  不兼容和 cardinality-one 冲突在提交前明确提示。

- “保存为集合”显式持久化当前顶层多选；不自动保存框选。
- Task 端口创建一条正式 Task Edge；Collection 端口是 UI macro，展开为成员的多条普通 Edge，Collection 本身不是 Edge 端点。
- collapsed Task/Collection 的外部 Edge 始终聚合到容器边界；hover 不再向隐藏成员分叉，避免指向不可见 Node 的漂浮连线。反向（右到左、下到上）Edge 的文字标签自动转正，过短的 Edge 只在 tooltip 与 aria-label 中保留语义。
- tool、search、warning 与 thinking 只属于 Run log，不创建语义 Edge。

### 删除、复制与恢复

- 「解除任务关系」会移除 Task 卡与关联连线，并把 output Node 释放为顶层 Node；
  「从画布移除任务和输出节点」是另一条独立确认动作。两者都不会物理删除生成资源。
- 删除活跃 Task 前先等待 daemon 取消确认；删除 Node 只删画布投影与 incident Edge。
- 解散 Collection 保留成员；删除 Collection 及内容必须二次确认。
- 复制 Task 只复制 goal 与输入 Edge，生成无 Run、无 output、无 session 的 draft。
- 复制 Node 可共享 artifact 引用，但 origin 改为 `copied`，不继承 materialization receipt。
- 复制 Collection 深复制顶层成员并重映射内部 Edge，不复制 runtime。

## 8. 版本历史与 reset

Canvas Git 位于 `.gg/canvas/`，受管 worktree 位于 `.gg/canvas-worktrees/`。规范化树为：

```text
tasks/<stable-key>.json
nodes/<stable-key>.json
collections/<stable-key>.json
edges/<stable-key>.json
receipts/<stable-key>.json
meta.json
```

写 checkpoint、恢复与 merge commit 前均运行完整语义校验，拒绝 dangling ref、Task/Collection 嵌套、重复 origin key 与无 receipt 的重复 materialization。runtime、selection、camera、SSE cursor 和原始日志永不进入 Git。

当前应用不读取或迁移旧格式。首次发现 schema-1 project marker 时，daemon 在项目 lease 下检查
realpath、symlink 与 source-control 边界，使用 reset journal 删除旧 Canvas、Run、session、artifact
和 versioned Canvas Git 目录，再写 schema-3 marker。reset 不创建 archive；目标含 tracked file 或
不安全路径时启动失败，不触碰项目 catalog、Skills 或用户源码。

当前 `/canvas` 应用入口与 daemon 只挂载这一套 Canvas。前端在 hydration 前必须验证 `/health` 的 `capabilities.canvas=true`、持久化 schema 与初始化 marker；不一致时显示阻断页。daemon 不提供已废弃的整文档 snapshot、Node Run、source-binding 或按路径 artifact fallback。

run log 是 ProjectionPlan、终态 close 与恢复的永久事实源，`DELETE /runs/:id/log` 返回 `run_log_delete_unsupported`。日志不进入 Canvas Git；未来若实现 GC，必须和 Canvas/runtime/history/artifact 可达性一起处理，不能独立删除。

## 9. 验收门禁

必须覆盖以下层次：

- 模型：全部不变量、命令原子性、稳定 ID、receipt、删除/复制、布局幂等、typed-edge traversal。
- 协议与安全：路径逃逸、symlink、控制/临时文件、未知插件、重复 key、output 上限、proposal 环与伪造字段。
- daemon：Task session、同 Task 单并发、不同 Task 并发、取消、崩溃恢复、partial manifest、pending plan、CAS 冲突、分支隔离。
- UI：零/单/多 output 容器、折叠、选择、框选、整组拖动、端口、束线、proposal 编辑与焦点保持。
- 资源生命周期：从画布移除后生成内容仍在 provider 中可发现；Canvas 深链保留显式项目
  scope；Workspace 资源库入口不自动选择项目，也不把 artifact catalog 渲染为整个资源库。
- 可访问性：真实 button、`aria-expanded`、group label、roving tabindex、键盘连接、live region 节流、状态不只依赖颜色。
- 版本历史：merge 前语义校验；Task/Node/Collection/Edge/receipt 身份与 artifact ref 在 checkpoint、恢复和合并后稳定。

基准场景“生成一个 ggplot 散点图”只执行一个 Run，得到一个 Task、一个代码 Node 和一个图像 Node；Task 到 Node 为 `produced`，代码到图像为 `derived`。刷新、SSE 重放、重复 close 与 CAS 重试不得重复创建；在图像 Node 上提交“调整配色”必须生成新的派生 Task，原图不变。
