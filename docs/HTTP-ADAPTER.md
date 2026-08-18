# Daemon HTTP Adapter

HTTP 是 `DaemonApplication` 的外部适配器，不是 Capability Runtime，也不是 Interaction Kernel。
新路由按 bounded context 注册在 `daemon/http/routes/`；路由只接收完成装配的窄服务，不能自行创建
Registry、RunManager、Catalog 或 PluginHost。

## 当前组合

`daemon/server.ts` 是稳定导出面，`daemon/serverCore.ts` 是唯一 HTTP server 与生命周期事实源。
bounded routes 与 Canvas、Run、artifact、catalog 路由在同一个 request dispatcher 内按顺序组合；
不存在第二个 listener、fallback server 或旧协议 adapter。

独立 bounded routes：

- `GET /health`
- `GET /runtime`
- `POST /task-runs/preflight`
- `GET /task-runs/:runId/reproducibility`

路由规则：

1. security headers 与 CORS 在共享入口应用；
2. route 只有命中自身 method/path 后才能读取 body；
3. SSE、Range 与 artifact descriptor verification 继续使用受测的专用 handler；
4. 已删除的协议没有 alias、fallback 或 retired handler；
5. HTTP route 不得成为持久事实源或 Capability provider。

该迁移不改变 Canvas UI、样式、交互或浏览器协议调用方式。
