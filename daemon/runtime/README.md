# Capability Runtime primitives

`daemon/runtime/` 是 GGAI 的插件运行时机制层，不是产品层，也不是 Interaction Kernel。
这里的模块只定义装配原语：稳定 service key、层级 scope、可逆 effect、typed observe-only event、
plugin host，以及 Profile / Bundle 组合。

## 依赖规则

Runtime primitive 只能依赖：

- `node:` 标准库；
- `daemon/runtime/` 内的其他 primitive。

不得依赖：

- `server.ts`、`runs.ts`、Canvas command store、ProjectionPlan store 等产品或可信内核实现；
- Codex、acpx 等具体 provider；
- `src/` 浏览器代码、React、Lucide、TSX 或任何 UI 状态；
- 外部包提供的隐式全局运行时。

这样可以保证 Runtime 只提供机制，不携带产品策略、权限根或持久事实。

## 原语职责

- `services.ts`：按版本化 key 注册和解析能力；子 scope 可以收窄父级 provider，关闭后撤销读取权限。
- `effects.ts`：每项注册都对应 disposer；逆序、幂等地卸载。
- `events.ts`：同步、类型化、仅观察的事件；监听失败不能接管生命周期。
- `pluginHost.ts`：验证 manifest 与显式注入、拥有插件生命周期、等待并发 activation，并在失败时回滚。
- `composition.ts`：预检 Profile / Bundle，按序挂载并逆序卸载。

需要产品数据或具体实现时，应在 `daemon/plugins/` 中实现 provider，通过 service seam 向 Runtime
贡献能力；不要把产品依赖反向拉进本目录。
