# Projection Contribution Capability

Projection contribution 是第三条 Capability Runtime 纵切面，但它必须保持 **data-only**。Runtime
Plugin 可以声明 artifact claim 与 Node context policy，不能贡献 renderer、任意 projector、Canvas
command、ArtifactManifest writer 或 ProjectionPlan materializer。

```text
trusted runtime plugin
      │ ArtifactClaimRegistration[]
      ▼
ProjectionContributionRegistry
      │ canonical snapshot + digest
      ▼
Run Capability Receipt semantic digest
```

## 当前阶段

Application 在 Workspace Scope 提供 `ggai.projection-contributions.v1`。受信插件通过显式 inject
注册声明；重复 ID、Builtin ID 和 `acceptsUnknown` 都会 fail closed。Snapshot 按 provider/id
排序并计算稳定 SHA-256，插件卸载只影响新 snapshot，已经生成的旧 snapshot 仍能独立复验。

生产默认 registry 为空，因此本 PR **不会改变现有 artifact 分类、Node 类型或 UI 渲染**。现有
`plugin-capabilities-v2` 已被接受的 Run 继续按原逻辑恢复。将 runtime contribution 与浏览器
community claims 合并，需要一次带来源信息的新 snapshot schema；不能把 live registry 偷塞进 v2，
否则插件卸载或重启 Profile 变化会让历史 Run 无法复验。

下一版 projection snapshot 应显式保存 builtin/runtime/community provenance，并把 contribution
snapshot digest 写入 Run Capability Receipt，再由 daemon 求交集。该迁移必须保持现有 v2 只读恢复。
