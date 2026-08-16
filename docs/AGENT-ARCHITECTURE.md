# Agent 接入架构（Task-Centric Canvas）

> 目标读者：负责 Canvas、Task Run、上下文打包和节点插件接线的工程师。
> 结论先行：GGAI 不实现模型 loop；本地 daemon 复用已登录的 Agent CLI，把差异化集中在持久 Task、typed-edge 上下文、Run-owned artifact 和可信投影。

最小语义边界见 [`INTERACTION-KERNEL.md`](./INTERACTION-KERNEL.md)，完整数据与 command 规范见 [`CANVAS.md`](./CANVAS.md)，社区节点插件与 Agent 输入的一致性契约见 [`PLUGIN-CONTEXT-CONTRACT.md`](./PLUGIN-CONTEXT-CONTRACT.md)。

## 一、分层

```text
产品层
Task/Node/Collection/typed Edge · 插件视图 · Proposal review · Canvas Git
                              │
Canvas 内核
纯 command reducer · revision CAS · receipt · context compiler · ProjectionPlan
                              │
本地 daemon
Run 生命周期 · 永久日志 · artifact manifest · session · 权限与安全校验
                              │
Transport
Codex JSONL / acpx adapter / future ACP client
                              │
本机已登录的 Agent CLI
```

daemon 不保存用户凭证；它只执行 CLI 自身的登录状态探针。Agent 永远不能直接写 Canvas snapshot、Canvas Git、entity ID、坐标或 command。

## 二、Canvas → Agent

浏览器先把待保存 command 冲刷到 daemon，然后提交 `RunIntent`：

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

daemon 从指定 branch/revision 的持久 `CanvasDocument` 编译上下文，不接收浏览器 `canvasSnapshot`。typed-edge 输入来自指向 Task 的 Edge：`contextRole=full` 加入受控完整内容，`summary` 加入摘要，`none` 不进入上下文。RunIntent 还可显式附加 artifact identity 或 Node ID；Node ID 由 daemon 在同一 revision 解析为有界内容快照，不能携带浏览器提供的内容或路径。

空 Node 被采用为 Task 输出槽时，共享 command reducer 会先读取其 `full/summary` 入边，并在
创建 Task 的同一原子 revision 中生成对应的直接 Task 输入边；相同来源只保留一次且 `full`
优先。这样“来源”UI 与 daemon 的 Task input selector 使用同一套 context-bearing edge 规则，
不会出现界面显示已附加而 `pack.json.inputs` 为空。

Run 的 durable summary 保存接受时的实际 `prompt` 与 `baseRevision`，并随终态更新、历史查询、daemon 重启和 interrupted recovery 原样保留。升级前没有这两个字段的旧 summary 仍可读取；新建 Task Run 必须同时具有两者。

每次 Run 的落盘边界是：

```text
project/
├── .gg/
│   ├── context/runs/<runId>/
│   │   ├── pack.md
│   │   ├── pack.json
│   │   ├── AGENTS.md
│   │   ├── plugin-capabilities.json
│   │   └── skills/
│   ├── context/pack.md              # 最近一次调试视图
│   └── runs/<runId>/                # Codex 的最小隔离 cwd
└── artifacts/.branches/<branch-hash>/<runId>/
    ├── files/                       # 此 Run 唯一可写 deliverable 根
    │   └── .ggai/run-result.json    # 可选、受限的 Agent control sidecar
    └── .ggai/artifact-manifest.v1.json  # close 时由 daemon 写入
```

项目根已有的 `AGENTS.md` 不会被覆盖。source resolver 只做 branch 与项目 lease 校验，并明确不给 transport source cwd；因此 Codex cwd 隔离在 `.gg/runs/<runId>`，项目根只作为 prompt 中的只读引用，另以 `--add-dir` 授权本 Run 的 `files/`。当前实现不提供已废弃的 `/canvas/source` 源码 worktree 绑定协议。

## 三、固定插件能力

节点插件的 React renderer 不进入 Agent 上下文。浏览器只把启用的 data-only artifact claims
与 `nodeContext` 投影策略注册到 `PUT /plugin-capabilities`。daemon 在 Workspace acceptance
路径重新读取受信 runtime contributions，合并不可覆盖的 builtins 与 community 声明，并固定
带 provenance 的 v3：

```text
.gg/runtime/plugin-capabilities-v3/<digest>.json
```

每项来源是 builtin version、runtime provider ID/version 或 browser-community。Run 接受时重新
验证并固定完整快照，随后把同一 v3 digest 写入 Capability Receipt，并把快照写入 `pack.json` 和
`plugin-capabilities.json`。Agent outcome 的 `pluginId` 必须属于该 registry，且 artifact path/MIME
必须满足 claim；Node 输入则按同一快照中的 `nodeContext` 做确定性正文裁剪、payload 字段选择与
artifact identity 过滤。每个输入携带 `contextProjection` receipt。这样插件热更新不会改变已经
运行或正在恢复的 Run 的分类与上下文语义。历史 `plugin-capabilities-v2` 只在 crash recovery
中读取；新 Run 不会接受或写入 v2。

## 四、固定 Node Skills

Node type 可以声明 Workspace 默认任务能力，每个 Canvas Node 也可以继承追加或完全替换为
自己的 skill 引用。skill 可以从任意用户显式选择的本地目录导入，但 daemon 会先把它复制成
Workspace 管理的不可变 revision；运行时不读取外部源目录，也不扫描 Agent 默认 skills 路径。

Run 接受时只汇总目标输出 Node、直接 context Node 和显式 attachment Node 的有效绑定，严格
校验内容 digest，并把文件固定到 `.gg/context/runs/<runId>/skills/`。`pack.md` 同时记录每项能力
来自哪个 Node/type/role 以及整体 `skillCapabilityDigest`。冲突 revision、归档后丢失或文件篡改
都会在 transport 启动前失败关闭。skill 是任务指导资产，不是权限授予。详见
[`NODE-SKILLS.md`](./NODE-SKILLS.md)。

## 五、Agent → Canvas

`CanvasAgentEvent` 是 UI 的流式进度协议：`thinking / text-delta / tool-call / tool-result / file-write / permission-request / usage / error / done`。这些事件进入永久 run log；tool、thinking、warning 和 search 不创建 Canvas Edge。

`file-write` 只驱动 Task 内 ghost 进度。终态流程为：

1. transport 产生 durable close；
2. daemon 扫描 `files/`，排除 `.ggai`、临时文件、link、foreign file 与非普通文件；
3. 写不可变 ArtifactManifest，并为每个文件生成 `artifactId` 与 content digest；
4. 读取可选 `RunOutcome`，与 manifest、固定插件 claims 求交集；
5. 生成带 digest 的 daemon-owned `ProjectionPlan`；
6. 自动物化 output Node/Edge/receipt；task proposal 进入用户审核，不自动执行。

失败、取消或中断仍可对合法 artifact 生成 partial plan，但不采用 Agent proposal。Node 只保存 `{ runId, artifactId }`，浏览器通过 manifest-backed artifact/metadata API 读取，不解析日志中的路径。

## 六、上下文裁剪

上下文分三层，但作用域以 Task 和 typed Edge 为准：

| 层 | 内容 | 进入条件 |
| --- | --- | --- |
| L0 契约 | daemon 安全契约、固定插件能力、Run output contract | 每次 Run |
| L1 图谱 | 相关 Task/Node/Edge 的标题、类型、关系与摘要 | Task 输入子图 |
| L2 内容 | 按固定 `nodeContext` 投影的 `contextRole=full/summary` 内容、显式 Node revision 快照和 verified artifact attachment | 直接输入或用户显式 attachment |

目标 Task 自己拥有的 output Node 不作为输入内容读取；pack 只声明其 `id/title/type/contentState`。
其中 `type` 是输出 `pluginId` 的约束，使图片、表格和 community 节点无需靠 Agent 猜测输出类型；
frame、坐标、renderer、选择态和运行态均不进入该契约。

显式 Node attachment 与 typed-edge context 在 pack 中分区，但都先通过同一份固定
`nodeContext` 策略并保存 receipt。策略允许的 artifactRefs 不做静默预算截断；被策略排除的
identity 明确计入 `omittedByPolicy`，不会触发文件解析。verified attachment 由 daemon 从已关闭
manifest 解析并附带 project-relative path、MIME、size 与 digest；多个 Node 共享同一 artifact 时
只保留一份 verified 元数据，但每个获准 Node 的引用仍在。浏览器不能把任意磁盘路径伪装成
attachment；进入授权集合的任一 artifactRef 无法复验时，整次 Run 在接受前失败关闭。

## 七、会话、并发与取消

Task 会话保存在 `.gg/runtime/task-sessions-v2.json`，键为 `canvasBranch + taskId + agentId`。同一 Task 的继续运行可以 resume；已有 Node 上的新提示先创建派生 Task，因此不会误复用原 Task session。

daemon 对 `(project, branch, taskId)` 强制单活跃 Run，不同 Task 可以并发。UI 取消请求等待 Run 进入终态后才完成；刷新或组件卸载只断开 SSE，不取消 Agent。daemon 重启会把未完成记录恢复为 `interrupted`，保留永久 JSONL，并为已经验证的 artifact 生成 partial 计划。

## 八、插件与 Agent 的正交关系

- Agent 通过 transport 接入；Canvas 不关心背后是 Codex、acpx 还是未来 ACP Agent。
- Node 类型通过插件接入；daemon 只读取可序列化 artifact claim，不导入 React 或 renderer。
- 浏览器拿到严格 artifact metadata 后，由平台按插件的 data-only `ui` 模板渲染；布局、ID、Edge 与 command 仍由核心 reducer 控制。

因此新增 Agent transport 不改变 Canvas model，新增 Node plugin 也不扩大 Agent 权限。
