# Capability Runtime 物理依赖边界

本文把 `docs/CAPABILITY-RUNTIME.md` 中的设计原则落实为可执行的源码依赖规则。目标不是把整个
GGAI 变成插件，而是确保 Interaction Kernel 保持唯一事实与权限根，同时让外围能力可组合、
可替换、可卸载。

## 依赖方向

```text
composition root
  daemon/registry.ts · daemon/agentRuntime.ts
                │
                ├── mounts daemon/plugins/*
                │           │
                │           ├── uses daemon/runtime/* contracts
                │           └── implements narrow provider seams
                │
                └── owns daemon/runtime/CapabilityPluginHost

consumer/core code ────────> stable service seam
                                  ▲
                                  │ provider registration
                         daemon/plugins/*

Interaction Kernel authority  <── never imported as a write shortcut by runtime plugins
Browser src/** and UI          <── never imported by daemon runtime or runtime plugins
```

## 三组自动门禁

`npm run architecture:check` 现在同时检查三组 Capability Runtime 规则。

### 1. Runtime primitive 是纯机制层

`daemon/runtime/**` 只能依赖 `node:` 标准库和本目录兄弟模块。它不能知道 HTTP、Run、Canvas、
Projection、具体 Agent 或浏览器 UI。新 primitive 一旦需要产品对象，说明 seam 放错了层级。

### 2. Runtime plugin 不拥有内核 authority

`daemon/plugins/**` 可以依赖 runtime contract、provider seam 和具体后端实现，但禁止：

- 导入任何 `src/**`、React/Lucide 或 `.tsx`；
- 直接导入 Canvas command store、Run manager、server、permission、ProjectionPlan store、
  artifact writer、Workspace versioning 等可信写入模块。

插件只能通过窄 service contract 贡献能力，不能拿到内核对象后自行制造持久事实。

### 3. 通用 Agent transport seam 不反向依赖 provider

`daemon/transport/registry.ts` 不能导入 Codex、acpx、Agent runtime composition 或 plugin。否则每次
新增 Agent 都会再次修改通用 registry，退化回硬编码分支。

## 两套插件系统的关系

- `src/plugins/NodePlugin`：浏览器侧、data-only UI/template、artifact claim 与 node context policy；
- `daemon/plugins/CapabilityPlugin`：可信后端 provider，具有显式生命周期但没有 Canvas authority。

Node plugin 不会因为同名 runtime plugin 而获得额外文件或 command 权限；runtime plugin 也不能
导入 renderer。未来把 Node capability、Skill、Projection contribution 接入统一 Host 时，仍应
保持 data contract 与 executable provider 分离。

## 本轮升级的冻结面

本轮五个 PR 不修改：

- Canvas 组件、CSS、设计 token、节点外壳；
- 工具条、拖拽、连线、框选、快捷键、面板动线；
- HTTP/SSE 协议、Canvas 持久模型和 Run 日志格式。

UI 很复杂，架构升级应先在 daemon/runtime 层形成稳定 seam，再由独立、具备交互回归验证的 PR
决定是否接入前端能力。本轮不以“顺手重构 UI”为代价换取后端整洁。

## 后续扩展检查表

新增一个 runtime capability 时：

1. 定义稳定、版本化的 service key 和最小接口；
2. consumer 只依赖接口，不 import provider；
3. provider 放入 `daemon/plugins/`，所有注册返回 disposer；
4. 权限只能由内核授予，plugin policy 只能保持或收窄；
5. Run 接受后，影响语义的 capability 必须形成可复验 snapshot/digest；
6. 添加 provider contract、卸载、失败回滚和架构门禁测试；
7. 动态第三方代码、签名、权限声明与进程隔离另立安全设计，不因 Profile/Bundle 已存在而默认开放。
