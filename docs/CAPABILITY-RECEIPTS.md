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

## Run 接线

`installRunCapabilityReceiptIntegration()` 装饰现有 `RunManager.create()` 的 reservation validation
seam。它不向 Runtime Plugin 暴露 RunManager：

1. RunManager 完成 runId、Task lease 和请求身份预留；
2. validation seam 创建真实 Workspace → Run scope；
3. 从固定 Profile、有效 service owner 和本次语义 digest 生成 receipt；
4. receipt 在 transport 启动前固定到项目内 durable store；
5. Run close 事件释放 Run scope；daemon shutdown 先排空 Run，再销毁 Workspace/Application scope。

当前语义记录包括所选 Agent、Node projection snapshot 和 Run skill set。后续 Skill Resolver 与
Projection provenance 接线只需替换对应 provider/digest 来源，不改变 Receipt envelope。

如果 receipt 创建或 provider 解析失败，Run 在进入 transport 前 fail closed。reservation 后发生的
其他接受失败可能留下一个不可达的 immutable receipt；它不会出现在 Run 历史或 UI，后续 GC 应按
Run log 可达性处理，不能将孤立 receipt 当作已执行事实。

该机制不修改 Canvas UI、样式、交互或 Node 持久模型。未来“运行信息/复现信息”应通过单独的
友好 read model 读取 receipt，不直接向用户显示原始 digest 或 provider id。
