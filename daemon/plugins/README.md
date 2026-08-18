# Daemon runtime plugins

`daemon/plugins/` 保存可信、进程内的 Capability Runtime 插件。它与浏览器中的
`src/plugins/NodeTypeDefinition` 不是同一种扩展：前者贡献后端 provider，后者是受限、data-only 的节点
展示与上下文声明。两者不得通过导入 React renderer 或 UI 状态耦合。

## 插件可以做什么

- 依赖 `daemon/runtime/` 的 plugin/context/service 契约；
- 在 `inject` 中逐项声明所需 service；未声明或不可用的依赖不得进入 activation；
- 实现并注册 Agent transport、importer、exporter、preview backend 等 provider；
- 依赖其能力所需的窄实现模块，例如具体 transport；
- 用 disposer 把 provider、listener、进程资源和临时注册归入插件生命周期。
- 不保留卸载后的 service reader；scope 关闭后读取会被拒绝。

## 插件不能做什么

- 导入 `src/`、`@/` alias、React、React DOM、Lucide 或 TSX；
- 直接导入 Canvas reducer/command store、Run manager、server、permissions、ArtifactManifest writer、
  ProjectionPlan store、Workspace versioning 等可信内核 authority；
- 创建 Task/Node/Edge ID、写坐标、伪造 receipt，或把 payload 路径当作文件授权；
- 通过 runtime event 返回 allow/deny 决策或改写 durable fact；
- 因为自己是 builtin plugin 就扩大既有权限。

Plugin 可以贡献能力，但 authority 仍由 Interaction Kernel 生成。需要新的可信写入路径时，应先在
内核定义窄 service seam 和不变量，再由插件实现 provider；不能从插件反向 import 内核对象绕过
边界。
