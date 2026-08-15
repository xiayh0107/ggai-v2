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

- 完整、已经规范化并带 digest 的最终 classification snapshot；
- 完整 Runtime contribution snapshot；
- 每个最终 plugin id 的 source kind 与 Runtime provider（community provider 为 `null`）；
- 自身 content digest。

持久化记录会独立复验以下不变量：

1. source 集合与最终 classification 中的 plugin id 一一对应，不允许缺失或额外来源；
2. builtin 必须归属于 `@ggai/projection-core`；
3. Runtime source 的 provider 必须与 contribution snapshot 完全一致；
4. 非 builtin、非 Runtime 的声明只能标记为 community，且 provider 必须为 `null`；
5. 每个 Runtime contribution 必须实际进入最终 classification。

因此 provenance 不依赖当前 live registry，也不需要另行寻找 classification 文件才能证明来源关系。
Store 的独立 8 MiB 上限覆盖完整 classification 与 Runtime snapshot，同时仍拒绝无界输入。

Run Capability Receipt 额外记录 `ggai.projection-provenance.v1` semantic capability，使历史 Run 能从
receipt 找到准确 provenance，而不需要读取当前 live registry。

## UI 边界

该数据暂不意味着节点需要 provider 或格式选择器。未来右侧“运行信息/复现信息”只能显示友好摘要，
例如“使用 2 项生成能力、1 项工作区扩展”；原始 provider id、classification digest 和 provenance
digest 只用于诊断与复验。
