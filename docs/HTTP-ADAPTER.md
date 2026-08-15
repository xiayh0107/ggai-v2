# Daemon HTTP Adapter

HTTP 是 `DaemonApplication` 的外部适配器，不是 Capability Runtime，也不是 Interaction Kernel。
新路由按 bounded context 注册在 `daemon/http/routes/`；路由只接收完成装配的窄服务，不能自行创建
Registry、RunManager、Catalog 或 PluginHost。

## 滚动迁移

`daemon/serverLegacy.ts` 暂时保存升级前的完整协议实现。`daemon/server.ts` 是新的小型组合适配器：
它优先分派已经迁移的 domain route，未迁移路径原样委托给 legacy listener。这样每个后续 PR 都能
以协议差分测试迁移一组路由，而不是一次重写整个 HTTP/SSE 边界。

当前已经迁移：

- `GET /health`
- `GET /runtime`

迁移规则：

1. status、JSON envelope、security headers、CORS 与 error code 必须保持兼容；
2. 未迁移路径不得被新 router 预读取 body 或修改 response；
3. SSE、Range、artifact descriptor verification 等高风险路径最后迁移；
4. 每迁移一个领域，应从 `serverLegacy.ts` 删除对应路径；全部迁移完成后删除 legacy adapter；
5. HTTP route 不得成为持久事实源或 Capability provider。

该迁移不改变 Canvas UI、样式、交互或浏览器协议调用方式。
