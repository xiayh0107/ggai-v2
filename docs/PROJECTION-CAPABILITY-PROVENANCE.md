# Projection Capability Provenance

现有 `plugin-capabilities-v2` 能固定最终 artifact classification 与 Node context policy，但不能回答
每一项声明来自 Core builtin、受信 Runtime provider，还是浏览器 community plugin。新的 composition
层补齐 provenance，同时继续保持 data-only 权限边界。

```text
Core builtin declarations ───────────┐
Trusted Runtime contributions ───────┼─> ProjectionCapabilityComposer
Browser community declarations ──────┘              │
                                                     ├─ final v2 classification snapshot
                                                     └─ provenance-v1 snapshot
```

## 组合规则

- builtin capability 永远由 `@ggai/projection-core` 拥有，不可覆盖；
- Runtime contribution 必须来自 `ProjectionContributionRegistry`，保留准确 `providerId`；
- community declaration 仍先经过 daemon 的严格 artifact/context validator；
- Runtime 与 community 使用同一 id 且内容不同会 fail closed，不按加载顺序覆盖；
- 同一已组合 snapshot 再次 compose 必须得到完全相同的 classification 与 provenance。

Runtime contribution 现在会进入新 Run 的最终 pinned classification；生产 registry 为空时，行为与
原 v2 完全相同。该变化不允许 provider 注入 renderer、函数、路径或 Canvas command。

## Durable provenance

每次 Task Run 接受时，Application 生成并固定：

```text
.gg/runtime/projection-provenance-v1/<digest>.json
```

Snapshot 包含：

- 最终 classification digest；
- 完整 Runtime contribution snapshot；
- 每个最终 plugin id 的 source kind 与 Runtime provider（community provider 为 `null`）；
- 自身 content digest。

Run Capability Receipt 额外记录 `ggai.projection-provenance.v1` semantic capability，使历史 Run 能从
receipt 找到准确 provenance，而不需要读取当前 live registry。

## UI 边界

该数据暂不意味着节点需要 provider 或格式选择器。未来右侧“运行信息/复现信息”只能显示友好摘要，
例如“使用 2 项生成能力、1 项工作区扩展”；原始 provider id、classification digest 和 provenance
digest 只用于诊断与复验。
