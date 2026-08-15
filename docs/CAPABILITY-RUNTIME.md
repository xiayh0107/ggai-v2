# GGAI Capability Runtime

GGAI 的插件化边界不是“所有东西都可以被插件替换”。可信事实仍由 Interaction Kernel 独占：
Task、Run、Node、Artifact、Edge、Collection，以及 revision、command、manifest、projection、
permission 和 receipt。Capability Runtime 只负责把内核之外的可替换能力装配起来。

## 目标

- 通过稳定 service key 依赖能力，而不是 import 某个具体实现；
- 每项注册都有明确 owner，并可在插件卸载时完整撤销；
- 插件激活失败时原子回滚已经注册的服务和副作用；
- 为 Workspace、Task、Run 等后续作用域保留层级化 service scope；
- 以类型化、仅观察的事件暴露生命周期，而不是建立可以改写事实的全局消息总线；
- 通过 Profile / Bundle 描述可检查、可复现的启动组合；
- 不让 runtime plugin 获得 Canvas command、entity id、布局或 manifest 写权限。

## 最小运行时原语

### `ServiceKey<T>` 与 `ServiceScope`

`defineService<T>('ggai.<capability>.v1')` 定义稳定、带版本的能力键。Provider 注册在共享
scope；consumer 只依赖 key。子 scope 可以收窄或替换父 scope 的 provider，销毁后恢复父级
解析结果。同一 scope 的重复 provider 会失败，而不是静默覆盖。已经销毁的 scope 会拒绝所有
后续读取，因此插件即使保留旧 reader，也不能在卸载后继续解析父级能力。

### `EffectScope`

所有 listener、provider、进程资源和临时注册都必须对应一个 disposer。`EffectScope` 按注册
顺序的逆序卸载，重复或并发 dispose 只执行一次；多个清理错误会聚合报告。

### `TypedEventBus<Events>`

Runtime event 是同步、类型化、**observe-only** 的生命周期信号：

- listener 只能观察不可变 payload，不能返回决策或替换结果；
- 一个 listener 抛错不会阻断后续 listener，也不会阻断插件挂载或卸载；
- async listener 会被明确记为无效，避免生命周期偷偷变成未受控的后台任务；
- listener disposer 会进入订阅插件自己的 `EffectScope`，插件卸载后不再收到事件；
- Host 只保留最近 100 个 listener failure，供诊断读取，避免错误监听器造成无界内存增长。

当前公开的 Host 生命周期事件为：

```text
plugin/activating
plugin/mounted
plugin/activation-failed
plugin/unmounting
plugin/unmounted
```

这些事件不是 command bus、权限 seam 或 durable event。它们不得创建 Task/Node/Edge，不得改变
Run 终态，也不得成为 ArtifactManifest 或 ProjectionPlan 的事实源。

### `CapabilityPluginHost`

Host 验证 `id / version / apiVersion`，为每个插件建立独立生命周期，并向插件暴露窄化的
`CapabilityPluginContext`：

- `provide(key, service)`：贡献共享能力；
- `require(key)`：按稳定 key 读取依赖；
- `effect(disposer)`：登记可逆副作用；
- `onEvent(name, listener)`：登记随插件自动卸载的类型化生命周期监听器。

插件必须通过 `inject: [ServiceKey]` 显式声明依赖；Host 会在 activation 的第一个副作用发生前
确认所有依赖可用，并只向插件暴露这些 key 的只读 reader。activation 抛错时，Host 会先广播
失败事实，再回滚已经贡献的能力和监听器；activation 与 rollback 同时失败时保留两类错误。
正常卸载也使用同一清理路径。Host 关闭时会先停止接收新插件并等待正在进行的 activation，
再按逆序卸载，避免 shutdown 返回后仍有插件完成挂载。

### `CapabilityProfile` 与 `CapabilityBundle`

Profile 是启动组合，Bundle 是其中有序的一组插件。组合器在首个 activation 之前完成：

- profile / bundle / plugin 身份与版本校验；
- bundle ID 和 plugin ID 全局去重；
- bundle、plugin 数量上限校验；
- data-only snapshot 生成，便于诊断和将来的配置 dump。

插件按 Bundle 顺序挂载，卸载时按相反顺序清理。异步组合路径如果中途失败，会等待已挂载插件
完整回滚；同步路径仅用于现有构造器兼容，结构错误同样保证在任何插件执行前失败。

Profile 当前只负责**可信进程内组合**，不等于允许任意 npm 包执行。第三方动态加载、签名、
权限声明和进程隔离必须在单独的安全设计之后引入。

## Agent Transport 首个迁移切片

`AgentTransportRegistry` 是第一个落到 Capability Runtime 的真实 seam。核心只认识
`AgentTransportProvider` 和稳定 service key `ggai.agent-transports.v1`；Codex 与 acpx 的探测、
兼容性判断和 transport 实例分别位于 builtin plugin。`AgentTransportKind` 是 provider-defined
字符串而不是 Codex/acpx 封闭枚举，新增 Agent 不再需要修改通用 registry 或核心协议类型。

默认 Agent 装配现已表示为 `@ggai/default-agent-runtime` Profile：Codex Bundle 始终存在；acpx
Bundle 仍只有在显式配置 adapter 后才加入。因此组合方式升级，但 CLI 参数和安全默认值不变。
daemon shutdown 会在 Run 完成收尾后释放 `AgentRegistry`，从而卸载 Profile 中的 provider。

## 信任边界

Capability Runtime 不暴露以下能力：

- Canvas reducer、revision CAS 或 command dispatcher；
- Task / Node / Edge id 生成与坐标布局；
- ArtifactManifest、ProjectionPlan 或 receipt 的可信写入；
- 浏览器组件、CSS、节点外壳或交互状态。

因此 runtime plugin 可以提供 Agent transport、importer、exporter、skill provider、preview
backend 等能力，但不能伪造持久事实，也不能扩大既有权限。

## 迁移顺序

1. 落地 service、effect 与 plugin host，不改变现有行为；
2. 将硬编码的 Codex / acpx Agent transport 迁移为 builtin runtime plugins；
3. 增加 scoped typed runtime events，先作为 observe-only 扩展点；
4. 增加 Profile / Bundle 组合与可检查 snapshot；
5. 增加物理依赖边界和架构门禁，再逐步迁移 Node capability、Skill 与 Projection contribution；
6. 第三方 runtime SDK、动态加载和隔离另立安全阶段。

每一步都必须保持 daemon API 与 UI 行为兼容。尤其不得借架构升级修改 Canvas 样式、工具条、
节点交互或面板动线。
