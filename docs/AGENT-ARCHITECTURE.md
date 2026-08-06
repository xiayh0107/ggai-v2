# Agent 接入架构（Task-Centric Canvas V2）

> 目标读者：负责 Canvas、Task Run、上下文打包和节点插件接线的工程师。
> 结论先行：GGAI 不实现模型 loop；本地 daemon 复用已登录的 Agent CLI，把差异化集中在持久 Task、typed-edge 上下文、Run-owned artifact 和可信投影。

最小语义边界见 [`INTERACTION-KERNEL.md`](./INTERACTION-KERNEL.md)，完整数据与 command 规范见 [`CANVAS-V2.md`](./CANVAS-V2.md)。

## 一、分层

```text
产品层
Task/Node/Collection/typed Edge · 插件视图 · Proposal review · Canvas Git
                              │
Canvas V2 内核
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

浏览器先把待保存 command 冲刷到 daemon，然后提交 `RunIntentV2`：

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

daemon 从指定 branch/revision 的持久 `CanvasDocumentV2` 编译上下文，不接收浏览器 `canvasSnapshot`。输入只来自指向 Task 的 Edge：`contextRole=full` 加入受控完整内容，`summary` 加入摘要，`none` 不进入上下文。

每次 Run 的落盘边界是：

```text
project/
├── .gg/
│   ├── context/runs/<runId>/
│   │   ├── pack.md
│   │   ├── pack.json
│   │   ├── AGENTS.md
│   │   ├── plugin-capabilities.v2.json
│   │   └── skills/
│   ├── context/pack.md              # 最近一次调试视图
│   └── runs/<runId>/                # Codex 的最小隔离 cwd
└── artifacts/.branches/<branch-hash>/<runId>/
    ├── files/                       # 此 Run 唯一可写 deliverable 根
    │   └── .ggai/run-result.json    # 可选、受限的 Agent control sidecar
    └── .ggai/artifact-manifest.v1.json  # close 时由 daemon 写入
```

项目根已有的 `AGENTS.md` 不会被覆盖。V2 的 source resolver 只做 branch 与项目 lease 校验，并明确不给 transport source cwd；因此 Codex cwd 隔离在 `.gg/runs/<runId>`，项目根只作为 prompt 中的只读引用，另以 `--add-dir` 授权本 Run 的 `files/`。V2 不提供旧 `/canvas/source` 源码 worktree 绑定协议。

## 三、固定插件能力

节点插件的 React renderer 不进入 Agent 上下文。浏览器只把启用的 data-only artifact claims 注册到 `PUT /plugin-capabilities/v2`。daemon 固定内置能力、合并 community claims、规范化并返回 digest；内容寻址快照保存于：

```text
.gg/runtime/plugin-capabilities-v2/<digest>.json
```

Run 接受时按 digest 严格加载并固定完整快照，随后把同一快照写入 `pack.json` 和 `plugin-capabilities.v2.json`。Agent outcome 的 `pluginId` 必须属于该 registry，且 artifact path/MIME 必须满足 claim。这样插件热更新不会改变已经运行或正在恢复的 Run 的分类语义。

## 四、Agent → Canvas

`CanvasAgentEvent` 是 UI 的流式进度协议：`thinking / text-delta / tool-call / tool-result / file-write / permission-request / usage / error / done`。这些事件进入永久 run log；tool、thinking、warning 和 search 不创建 Canvas Edge。

`file-write` 只驱动 Task 内 ghost 进度。终态流程为：

1. transport 产生 durable close；
2. daemon 扫描 `files/`，排除 `.ggai`、临时文件、link、foreign file 与非普通文件；
3. 写不可变 ArtifactManifest，并为每个文件生成 `artifactId` 与 content digest；
4. 读取可选 `RunOutcomeV2`，与 manifest、固定插件 claims 求交集；
5. 生成带 digest 的 daemon-owned `ProjectionPlan`；
6. 自动物化 output Node/Edge/receipt；task proposal 进入用户审核，不自动执行。

失败、取消或中断仍可对合法 artifact 生成 partial plan，但不采用 Agent proposal。Node 只保存 `{ runId, artifactId }`，浏览器通过 manifest-backed artifact/metadata API 读取，不解析日志中的路径。

## 五、上下文裁剪

上下文分三层，但作用域以 Task 和 typed Edge 为准：

| 层 | 内容 | 进入条件 |
| --- | --- | --- |
| L0 契约 | daemon 安全契约、固定插件能力、Run output contract | 每次 Run |
| L1 图谱 | 相关 Task/Node/Edge 的标题、类型、关系与摘要 | Task 输入子图 |
| L2 内容 | `contextRole=full` 的 Node 内容和 verified artifact attachment | 直接输入 |

verified attachment 由 daemon 从已关闭 manifest 解析并附带 project-relative path、MIME、size 与 digest；浏览器不能把任意磁盘路径伪装成 attachment。

## 六、会话、并发与取消

Task 会话保存在 `.gg/runtime/task-sessions-v2.json`，键为 `canvasBranch + taskId + agentId`。同一 Task 的继续运行可以 resume；已有 Node 上的新提示先创建派生 Task，因此不会误复用原 Task session。

daemon 对 `(project, branch, taskId)` 强制单活跃 Run，不同 Task 可以并发。UI 取消请求等待 Run 进入终态后才完成；刷新或组件卸载只断开 SSE，不取消 Agent。daemon 重启会把未完成记录恢复为 `interrupted`，保留永久 JSONL，并为已经验证的 artifact 生成 partial 计划。

## 七、插件与 Agent 的正交关系

- Agent 通过 transport 接入；Canvas 不关心背后是 Codex、acpx 还是未来 ACP Agent。
- Node 类型通过插件接入；daemon 只读取可序列化 artifact claim，不导入 React 或 renderer。
- 浏览器拿到严格 artifact metadata 后，调用插件纯 `projectArtifact` 和 `views.Artifact`；布局、ID、Edge 与 command 仍由核心 reducer 控制。

因此新增 Agent transport 不改变 Canvas model，新增 Node plugin 也不扩大 Agent 权限。
