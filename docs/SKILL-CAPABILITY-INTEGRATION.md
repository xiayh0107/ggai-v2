# Skill Capability Integration

Skill 的可信资产 authority 与可替换解析能力必须分开：

```text
Core-owned SkillAssetCatalog
├── install / archive
├── revision CAS
├── type bindings
├── managed bytes and integrity
└── immutable resolve authority
             │ read-only service
             ▼
@ggai/workspace-skill-resolver
             │ SkillResolver
             ▼
CapabilitySkillAssetCatalog
             │ legacy adapter compatibility
             ▼
Run context resolution
```

`CapabilitySkillAssetCatalog` 是过渡期 compatibility facade：

- `list / import / archive / updateTypeBindings / typeBindings` 原样委托 Core-owned Catalog；
- 只有 `resolve(refs)` 通过 Workspace `SKILL_RESOLVER_SERVICE`；
- Resolver 返回的资产会克隆后交给旧 Run adapter，不能把 provider 内部对象泄漏给调用者；
- Application 仍只创建一个真实 `SkillAssetCatalog` authority；facade 不拥有第二份持久状态。

因此 Skill Runtime Plugin 可以替换读取实现或增加审计，但不能安装资产、修改绑定、扩大 Node
权限或绕过 Run 固定。Run Capability Receipt 将 `ggai.run-skills.v1` 的 provider 记录为
`@ggai/workspace-skill-resolver`，语义 digest 仍来自本次 Run 已固定的 skill set。

该接线不要求新增 Skills 面板。Canvas 只需复用既有“节点 Skills”工作台，并在 Run 开始后把
当前选择显示为只读摘要。
