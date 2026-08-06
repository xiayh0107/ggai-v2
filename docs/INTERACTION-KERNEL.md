# Agent–Canvas V2 交互内核

本文定义 Task-Centric Canvas V2 与外部 Agent 之间最小、可信的语义边界。完整实体和 command 规范见 [`CANVAS-V2.md`](./CANVAS-V2.md)。内核不实现 Agent 调度器、Agent 间消息总线，也不允许 Agent 直接修改画布。

## 六个稳定概念

1. **Task**：用户目标和执行容器；持久保存 goal 与锚点，不保存运行日志或 session。
2. **Run**：Task 的一次不可变执行尝试；绑定 `taskId`、持久 Canvas revision、实际 prompt、附件、Agent 和固定插件能力 digest。
3. **Node**：纯内容投影；不拥有 prompt、phase、session、Run 日志或磁盘路径。
4. **Artifact**：Run-owned 不可变文件；Node 只引用 `{ runId, artifactId }`。
5. **Edge**：Task/Node 之间的类型化关系；展示 `relation` 与上下文 `contextRole` 分离。
6. **Collection**：用户显式保存的顶层布局集合；不拥有 prompt、Run 或成员数组。

## 单向数据流

```text
用户 command → 持久 Task + Canvas revision
                         │
                         ▼
                RunIntentV2(taskId, revision)
                         │
                         ▼
            events / file-write ghost progress
                         │
                         ▼ durable close
       ArtifactManifest + validated RunOutcomeV2
                         │
                         ▼
               trusted ProjectionPlan
                  ┌──────┴──────┐
                  ▼             ▼
        automatic output     proposal review
        materialization      user confirmation
                  │             │
                  ▼             ▼
             Node/Edge/receipt  draft Task/Edge/receipt
```

浏览器发起 Run 前必须冲刷 outbox。daemon 只从 `canvasBranch + baseRevision` 的持久文档编译上下文，不接受浏览器上传 Canvas snapshot。`file-write` 只产生临时 ghost；真实 Node 只能在 durable close、manifest 校验与 ProjectionPlan 交集之后原子物化。

## 信任边界

- Agent transport 只负责启动、恢复、取消和事件翻译；它不知道 Canvas ID、坐标、布局或 command。
- Agent 可以写 deliverable 和受限 `RunOutcomeV2` sidecar，但不能声明 runId、Task/Node ID、payload、自由 edge、坐标或后续自动执行。
- outcome 缺失、损坏、超限或不安全时，Run 仍按 transport 终态结束；daemon 对已验证 artifact 做确定性 fallback。
- error、cancelled、interrupted Run 可以产生 partial plan，但其 task proposal 一律不采用。
- tool、search、warning、thinking 与 permission 只属于 Run event/log，不生成语义 Edge。
- 可信 materialization/accept/dismiss HTTP command 只携带 `planId`。daemon 从永久记录解析完整计划，浏览器不能提交 Node patch。
- V2 run log 保存终态 close 与恢复证据，不能独立删除。

## 上下文编译

Run 的目标由 `taskId` 定位。只有指向该 Task 且 `contextRole` 为 `full` 或 `summary` 的 typed Edge 参与上下文：

- `full`：加入经过边界控制的完整 Node 内容或 verified artifact attachment；
- `summary`：只加入标题、类型和摘要；
- `none`：保留画布语义关系，但不进入 Agent 上下文。

Task、Node 与 Edge 的 ID 是 provenance，不是给 Agent 使用的画布写权限。所有 artifact attachment 都由 daemon 从已关闭 manifest 解析为只读路径、MIME、size 和 digest。

## 固定插件能力

artifact claim 是 JSON 可序列化数据；React renderer 与 `projectArtifact` 函数不会发送给 daemon。浏览器把启用的 community claims 注册给 daemon，daemon 合并不可覆盖的内置 registry、规范化并返回 content digest。Run 接受时把完整能力快照固定下来，并写入上下文包。

Agent outcome 的 `pluginId` 必须属于该固定快照，path/MIME 也必须满足对应 claim。daemon 将 outcome、manifest 与 claims 求交集；未知文件只由 daemon-owned `file` fallback 接收。浏览器拿到 manifest-backed metadata 后，才调用相同 plugin 的纯投影函数与 Artifact view。

## 会话与并发

会话事实源键为 `canvasBranch + taskId + agentId`。同一 Task 的“继续任务”可以 resume；从已有 Node 派生的新 Task 必须获得独立 session。每个 `(project, branch, taskId)` 同时最多一个活跃 Run，不同 Task 可以并发。

Agent proposal 只是下一批 draft Task 的受限计划。用户可以编辑标题、prompt、选择项和 proposal DAG 内依赖；确认在一个 Canvas command 中创建 Task/Edge/receipt，但不会启动任何 Run、消耗权限或形成嵌套 Task。

## 演进规则

- 只有旧消费者能安全忽略时才增加可选字段；否则升级 schema version。
- 身份、坐标、命令与 provenance 始终由 daemon/reducer 边界生成，不扩展 Agent 权限。
- 新 Node 类型通过 data-only artifact claim、纯 `projectArtifact` 与 view 扩展，不在核心按 plugin ID 分支。
- 新 Edge relation 不得隐式改变上下文；每条命令必须继续显式携带
  `contextRole`，但普通用户不直接编辑协议枚举。端口连线由端点类型纯推导：
  Node→Task 为 `source/full`，Task→Task 为 `depends-on/summary`，指向 Node
  的普通连接为 `references/none`。`produced/derived` 只来自可信物化路径。
- artifact GC 必须做跨 runtime、Canvas Git、run log 和 manifest 的可达性分析，不能因当前 Node 被删除就回收。
