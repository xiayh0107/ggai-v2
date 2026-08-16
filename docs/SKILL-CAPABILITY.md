# Skill Resolver Capability

Skill 是第二条进入 Capability Runtime 的真实纵切面。迁移保持 authority 与 provider 分离：

```text
Core SkillAssetCatalog
  install / archive / revision CAS / managed bytes / digest verification
            │ read-only SkillCatalogReader service
            ▼
@ggai/workspace-skill-resolver plugin
            │
            ▼
SkillResolver service
  exact refs → verified assets + semantic digest
```

## Core 继续独占

- 从外部目录采用资产；
- symlink、容量、路径和内容 digest 校验；
- immutable revision、archive 与 type binding CAS；
- Run 固定副本和最终权限边界。

Runtime Plugin 不能 import `SkillAssetCatalog`，只能声明并读取
`ggai.skill-catalog-reader.v1`。它输出 `ggai.skill-resolver.v1`，对精确引用执行解析，并根据 ref、
metadata 与逐文件 digest 生成稳定的 semantic digest。文件内容仍来自 Core 已验证的受管 snapshot。

Resolver 安装在 Workspace Scope，因此不同 Workspace 可以拥有不同 Catalog 或更窄的 resolver；
卸载 Workspace 会同时撤销 resolver。真实 Task Run 与 preflight 现在都通过
`ggai.skill-resolver.v1` 解析 exact refs，不再直接调用 `SkillAssetCatalog.resolve()`。

Run acceptance 的链路是：

```text
participating Nodes
  → Core effective refs + revision conflict check
  → Workspace SkillResolver
  → Core exact-ref / byte / digest revalidation
  → Run-owned pinned copy
  → resolver semantic digest + authority digest
  → Capability Receipt
```

Resolver 缺失、返回额外/缺失 revision、返回非法 digest 或文件完整性不匹配时均 fail closed。acceptance
reservation 内会再次查询当前 Workspace resolver 并复验同一结果；热更新只会改变尚未接受的新 Run。
已接受 Run 从自己的 request/pinned context 读取 bytes，settlement 与 crash recovery 不重新查询 live
resolver。

本改造不修改 Skill 管理 UI、Canvas Node、样式或交互。
