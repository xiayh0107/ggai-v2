# Agent 接入架构（GGAI 画布）

> 目标读者：负责把画布接上真实 Agent 的工程师 / agent。
> 结论先行：**不自己实现 Agent，不复制 Open Design 的二十多个 adapter。
> 用现成底座（ACP SDK / acpx），把精力全部花在差异化上——画布的上下文工程。**
>
> Agent、人、提示、运行结果、产物和节点之间的最小语义边界见
> [`INTERACTION-KERNEL.md`](./INTERACTION-KERNEL.md)。该边界不引入 Agent 消息总线或集群调度器。

## 一、总分层

```
┌──────────────────────────────────────────────────────┐
│ 产品层（我们的差异化，全部自己写）                        │
│ 画布 · 节点插件 · 连线 · 上下文打包 · 预览 · 版本历史      │
├──────────────────────────────────────────────────────┤
│ Agent Runtime（src/agent/，薄，只写一次）               │
│ 上下文打包器 · 会话映射 · 统一事件 · 产物对账            │
├──────────────────────────────────────────────────────┤
│ 现成底座（不重造）                                      │
│ ACP SDK (@agentclientprotocol/sdk) / acpx runtime     │
│ Agent 发现 · 启动 · 会话恢复 · 权限 · 取消              │
├──────────────────────────────────────────────────────┤
│ 本机已登录的 Agent CLI                                 │
│ Codex · Claude · Kimi · Cursor · OpenCode …           │
└──────────────────────────────────────────────────────┘
```

为什么这样切（来自调研的直接结论）：
- **Agent 发现/启动/会话恢复/权限/取消** 是通用问题，acpx + ACP Registry 已经解决了约八成最重复、最脆弱的适配工作，接过来用。
- **凭证**：复用本机 `codex login` 等 CLI 的登录缓存，daemon 只做 `login status` 探针，永远不碰用户的 key 或 OAuth。
- **设计知识在文件和 prompt 层**，不绑定任何 Agent 的私有 Skill 系统——这正是我们能"一套画布接所有 Agent"的根本。

## 二、双向上下文（两个方向）

### 方向 A：画布 → Agent（上下文暴露）

每次执行，把"项目-画布-节点-连线"编译成一份**增量上下文包**，写进项目目录：

```
project/
├── AGENTS.md            # 契约层（daemon 保证最新）
├── DESIGN.md            # 设计规范
├── .gg/
│   └── context/
│       └── pack.md      # 本次执行的上下文包（renderPackPrompt 的产物）
└── artifacts/
    ├── .branches/<branch-hash>/<runId>/<nodeId>/ # 新运行的不可变产物目录
    │   ├── image.png
    │   └── ...
    └── <nodeId>/        # 旧 main 产物，仅保留读取兼容
```

Agent 从 `.gg/context/runs/<runId>/` 读取上下文，只获得当前 run 的不可变 artifactDir 写权限；源码未绑定时 Codex cwd 位于 `.gg/runs/<runId>`，绑定后才切到受管源码 worktree。**Agent 永远不直接改画布状态文件**——当前事实源是 daemon 的分支快照，前端 zustand 通过 revision CAS 与 IndexedDB journal 同步它。

### 方向 B：Agent → 画布（产物对账）

Agent 写 daemon 为本次 branch/run 分配的不可变 artifactDir → daemon 只监听该目录 → 翻译为统一事件的 `file-write` → 前端按 nodeId 把完整相对路径对账回节点（更新 payload、把 `instruction.phase` 置为 `done`）。旧 `artifacts/<nodeId>/` 引用仅保留读取兼容。

## 三、上下文优化：三层裁剪

给 Agent 的上下文按层组装，层数由任务范围决定（`src/agent/context.ts`）：

| 层 | 内容 | 何时带 | token 量级 |
|----|------|--------|-----------|
| L0 契约 | AGENTS.md 摘要 + 启用插件的一句话契约 | 永远 | 小 |
| L1 图谱 | 相关子图的节点/连线摘要（id/类型/标题/meta，**无正文**） | 有连线关系时 | 中 |
| L2 内容 | 源节点的完整 payload（文本全文、表格、图片路径） | 仅直接来源节点 | 大 |

范围规则（`packContext`）：
- 单节点执行、无来源：L0 + 自身 L2
- 拖线 / 框选创建的执行：L0 + 追溯出的子图 L1 + 所有**直接来源** L2
- 追溯用 BFS 沿"来源边"反向遍历（`collectSubgraph`），只打包相关子图，不是整库 dump

## 四、统一事件（UI 不关心背后是哪个 Agent）

`CanvasAgentEvent`（`src/agent/types.ts`）是 UI 唯一消费的事件类型。daemon 把各 Agent 的输出（ACP `session/update`、Codex `item.started`、plain stdout）都翻译成它：

```
Codex events ──┐
ACP events ────┼─→ daemon 翻译 ─→ CanvasAgentEvent ─→ 同一个 UI
plain stdout ──┘
```

对应调研第四节的 `OpenDesignEvent`，我们的事件集：`thinking / text-delta / tool-call / tool-result / file-write / permission-request / usage / error / done`。

事件只描述运行过程。需要在运行结束后供画布消费的小型结构化结果，通过权威 `close`
上的可选、版本化 `RunOutcome` 传递；不会为每种副产物继续增加事件类型。

## 五、会话恢复

daemon 的 `.gg/sessions.json` 是 `节点 ↔ Agent 会话` 映射的唯一持久化事实源。首轮新建会话，daemon 从输出里捕获 thread/session id 回填；之后同一项目、节点与 Agent 再次执行时由 daemon 走 resume（`codex exec resume` / ACP session reuse）。不提供 session id 的 plain-text/stateless transport 也可以正常完成，只是不具备 resume。

## 六、落地路线（建议分两期）

**第一期（现在就能做）**
- `src/agent/` 骨架已就位：`types.ts`（事件/上下文/会话）、`context.ts`（打包器）、`runtime.ts`（生命周期 + MockTransport）。
- 浏览器原型先用 `MockTransport` 把"执行 → 事件流 → 产物对账"的链路在 UI 上跑通。
- 把 `AGENTS.md`、本架构文档、插件契约接进 `packContext` 的 L0。

**第二期（接真实 Agent）**
- 加一个 daemon（Electron main / 本地 Node 服务），实现 `AgentTransport`：
  - 首选 `@agentclientprotocol/sdk` 写一次 ACP Client，接所有 ACP Agent（Kimi/Devin/Trae/…）；
  - 或先 `spawn acpx --format json <agent> exec` 快速落地，acpx 内部已处理适配器/会话/取消。
- 用 ACP Registry 做 Agent 的发现与安装，不硬编码 CLI 列表。
- 文件落盘：把 `packContext` 的产物写进 `.gg/context/runs/<runId>/pack.md`，只监听本次 branch/run 的不可变 artifactDir 并对账。

**不做的事**：不自己写 RuntimeAgentDef 池、不实现任何模型调用、不存用户 key、不绑定任何 Agent 的私有 Skill 系统。

## 七、和节点插件体系的关系

两者是同一个架构哲学的两层：

- **节点类型** 通过 `NodePlugin` 插件化（src/plugins/）——画布不关心"图像/表格/公式"各自怎么渲染。
- **Agent** 通过 `AgentTransport` + ACP 适配（src/agent/）——画布不关心背后是 Codex 还是 Kimi。

插件契约（`NodePlugin.desc`/`instr.placeholder`）同时充当 L0 契约层给 Agent 的"类型说明"，所以新增一个节点插件，Agent 侧自动获得对它的理解，无需额外适配。
