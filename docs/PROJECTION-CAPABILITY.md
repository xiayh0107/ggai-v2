# Projection Capability Snapshot v3

Projection contribution 是第三条 Capability Runtime 纵切面，并且保持 **data-only**。Runtime
Plugin 可以声明 artifact claim 与 Node context policy，不能贡献 renderer、任意 projector、Canvas
command、ArtifactManifest writer 或 ProjectionPlan materializer。

```text
daemon protected builtins
          +
trusted runtime contributions (provider ID/version)
          +
validated browser community claims
          │
          ▼
Projection Capability Snapshot v3
          │ Run-fixed digest
          ▼
Capability Receipt + ProjectionPlan
```

## Provenance 与冲突规则

Application 在 Workspace Scope 提供 `ggai.projection-contributions.v1`。受信插件通过显式 inject
注册声明；provider ID/version 会进入每项 provenance。最终 v3 项的来源只能是：

- `{ kind: 'builtin', version }`
- `{ kind: 'runtime-plugin', providerId, providerVersion }`
- `{ kind: 'browser-community' }`

Builtin ID 不可覆盖，runtime/community 不能声明 unknown fallback，同一 plugin ID 的 claim 冲突
直接拒绝。不同 plugin 同时匹配 artifact 时按 rule priority、匹配具体度和稳定 plugin ID 决定，
因此 canonicalization 与 provider 或浏览器注册顺序无关。

## Run acceptance

`PUT /plugin-capabilities` 仍只接收浏览器 data-only v2 request envelope，但响应与持久化结果是
v3。正式 Run 在 acceptance reservation 内用当前 Workspace registry 重建 v3；provider 热更新只
影响新 Run，已接受 Run 的 context pack、Capability Receipt 与 ProjectionPlan 始终使用自身固定快照。

生产默认 runtime registry 为空时，artifact 分类、Node context 与 unknown file fallback 和升级前
一致。`.gg/runtime/plugin-capabilities-v2` 不再写入或用于 live Run，只为历史 interrupted Run
提供只读恢复；新 Run 写 `.gg/runtime/plugin-capabilities-v3`。UI 不展示 provider 或输出来源选择器。
