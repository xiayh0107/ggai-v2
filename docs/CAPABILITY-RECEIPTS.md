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

## Durable store

`RunCapabilityReceiptStore` 将 receipt 幂等固定到：

```text
.gg/runtime/capability-receipts-v1/<runId>.json
```

同一 Run 再次固定相同 digest 是安全重试；不同 digest 则 fail closed。读取使用 bounded file、
`O_NOFOLLOW`、canonical project root 和完整 digest 复验。Receipt 字节一旦写入，不随 provider 热更新
改变。

`RunCapabilityScope.acceptCapabilities()` 已能从实际 scope 生成 receipt。后续 RunManager 接线只需要
在 acceptance lease 内调用该方法并 `pin()`，而不是重新从全局 registry 推断历史能力。

该机制不修改 Canvas UI、样式、交互或 Node 持久模型。
