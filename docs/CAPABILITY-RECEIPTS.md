# Run Capability Receipts

Capability Runtime 的 live registry 不是历史事实。Provider 可以卸载、升级或被另一个 Profile 替换；
因此 Run 接受时必须把影响语义的能力投影为独立、可复验的 receipt。

```text
RunCapabilityReceipt
├── runId
├── complete CapabilityProfile snapshot + profileDigest
├── effective service key → owner
├── semantic capability key → provider + digest
└── overall receipt digest
```

## 两类记录

- `services`：记录 Run scope 实际可见的 service key 与 owner，用于回答“由谁提供能力”；
- `semanticCapabilities`：只记录会改变 Run 输入、输出分类或执行含义的 data snapshot digest，例如
  Node projection registry、Skill capability set、Importer policy。Telemetry listener 等观察能力不进入。

Receipt 不序列化 service instance、函数、路径授权、环境变量或凭证。Profile、services 和 semantic
capability 都会 canonicalize 后再计算 SHA-256；不同注册顺序产生相同 receipt。

Task Run 当前记录 `ggai.skill-resolver.v1` 的 Workspace provider 与 resolver semantic digest，并另行
记录带 Node authority sources 的 Core Skill capability digest。这样 provider 热更新不会改写历史语义。

## Durable store

`RunCapabilityReceiptStore` 将 receipt 幂等固定到：

```text
.gg/runtime/capability-receipts-v1/<runId>.json
```

同一 Run 再次固定相同 digest 是安全重试；不同 digest 则 fail closed。读取使用 bounded file、
`O_NOFOLLOW`、canonical project root 和完整 digest 复验。Receipt 字节一旦写入，不随 provider 热更新
改变。

`RunManager` 在 Task acceptance reservation 内完成 revision、附件与 Skill 复验后创建 Run scope，
调用 `acceptCapabilities()` 并在 durable summary 之前 `pin()`。Receipt 写入失败时不会创建 summary，
更不会启动 Agent transport。同一 `runId` 只能固定同一 digest；最终 settlement 后 Run scope 关闭。

新 Task Run summary 保存 `capabilityReceiptDigest` 与一份不含实现细节的友好历史快照。crash recovery
在重建 close/ProjectionPlan 前复验同一 receipt；缺失或 digest 不一致的新版 Run fail closed，旧版未带
receipt 的 summary 仍按历史兼容路径恢复。

`GET /task-runs/:runId/reproducibility` 只返回生成服务名称、Skill/附件数量和生成环境标签。完整
receipt、provider/service identity 与原始 digest 仍只属于内部持久协议和开发诊断。

该机制不修改 Canvas Node 持久模型，也不会把完整 receipt 写入 Node。
