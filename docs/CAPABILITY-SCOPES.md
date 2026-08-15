# Capability Execution Scopes

Capability Plugin Host 的 scope 表示插件装配生命周期；Execution Scope 表示产品资源生命周期。
二者共享同一个父级 `ServiceScope`，因此 Workspace 和 Run 可以读取已经挂载的 capability，但不能
反向取得 PluginHost、Canvas authority 或 provider implementation。

```text
Agent Runtime ServiceScope
        │
        └── Application Execution Scope
                │
                ├── Workspace Scope(projectDir)
                │       ├── Run Scope(runId)
                │       └── Run Scope(runId)
                └── Workspace Scope(projectDir)
```

## 规则

- Application scope 随 `DaemonApplication` 创建和关闭；
- Workspace scope 以 canonical `projectDir` 为身份，同一进程内复用同一 scope；
- Run scope 必须有唯一、受限的 `runId`，并是 Workspace scope 的子级；
- Run 关闭后旧 reader 立即失效；Workspace 关闭会先逆序关闭全部 Run；
- scope snapshot 只包含 service key 与 owner，不包含实例、路径授权或凭证；
- Workspace/Run identity 是诊断和 provider 选择上下文，不是文件系统或 Canvas command authority；
- 当前不创建 Task Scope。Task 是持久语义实体，尚没有独立的长期资源生命周期。

本阶段先建立 Application-owned 的真实 scope tree。后续 Run acceptance 接入时，每次 Run 将在接受
和终态之间持有对应 `RunCapabilityScope`，并从该 scope 生成 Capability Receipt。

该机制完全位于 daemon/runtime 边界，不修改 Canvas UI、样式或交互。
