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
卸载 Workspace 会同时撤销 resolver。Run Capability Receipt 可以把 `ggai.skill-resolver.v1` 及本次
resolution digest 记录为 semantic capability。

本改造不修改 Skill 管理 UI、Canvas Node、样式或交互。
