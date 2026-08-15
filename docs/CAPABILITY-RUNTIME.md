# GGAI Capability Runtime

GGAI 的插件化边界不是“所有东西都可以被插件替换”。可信事实仍由 Interaction Kernel 独占：
Task、Run、Node、Artifact、Edge、Collection，以及 revision、command、manifest、projection、
permission 和 receipt。Capability Runtime 只负责把内核之外的可替换能力装配起来。

## 目标

- 通过稳定 service key 依赖能力，而不是 import 某个具体实现；
- 每项注册都有明确 owner，并可在插件卸载时完整撤销；
- 插件激活失败时原子回滚已经注册的服务和副作用；
- 为 Workspace、Task、Run 等后续作用域保留层级化 service scope；
- 不让 runtime plugin 获得 Canvas command、entity id、布局或 manifest 写权限。

## 最小运行时原语

### `ServiceKey<T>` 与 `ServiceScope`

`defineService<T>('ggai.<capability>.v1')` 定义稳定、带版本的能力键。Provider 注册在共享
scope；consumer 只依赖 key。子 scope 可以收窄或替换父 scope 的 provider，销毁后恢复父级
解析结果。同一 scope 的重复 provider 会失败，而不是静默覆盖。

### `EffectScope`

所有 listener、provider、进程资源和临时注册都必须对应一个 disposer。`EffectScope` 按注册
顺序的逆序卸载，重复或并发 dispose 只执行一次；多个清理错误会聚合报告。

### `CapabilityPluginHost`

Host 验证 `id / version / apiVersion`，为每个插件建立独立生命周期，并向插件暴露窄化的
`CapabilityPluginContext`：

- `provide(key, service)`：贡献共享能力；
- `require(key)`：按稳定 key 读取依赖；
- `effect(disposer)`：登记可逆副作用。

插件 activation 抛错时，Host 会先回滚已经贡献的能力，再把错误交给启动边界。正常卸载也
使用相同清理路径。

## 信任边界

Capability Runtime 不暴露以下能力：

- Canvas reducer、revision CAS 或 command dispatcher；
- Task / Node / Edge id 生成与坐标布局；
- ArtifactManifest、ProjectionPlan 或 receipt 的可信写入；
- 浏览器组件、CSS、节点外壳或交互状态。

因此 runtime plugin 可以提供 Agent transport、importer、exporter、skill provider、preview
backend 等能力，但不能伪造持久事实，也不能扩大既有权限。

## 迁移顺序

1. 先落地 service、effect 与 plugin host，不改变现有行为；
2. 将硬编码的 Codex / acpx Agent transport 迁移为 builtin runtime plugins；
3. 增加 typed runtime events，先作为 observe-only 扩展点；
4. 将现有 Node capability snapshot、Skill 和 Projection contribution 逐步接入统一 Host；
5. 最后才考虑 bundle/profile 和第三方 runtime SDK。

每一步都必须保持 daemon API 与 UI 行为兼容。尤其不得借架构升级修改 Canvas 样式、工具条、
节点交互或面板动线。
