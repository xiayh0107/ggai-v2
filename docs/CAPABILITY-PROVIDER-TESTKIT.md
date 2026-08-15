# Capability Provider Conformance Testkit

每个 `daemon/plugins/<family>` 都必须在统一 conformance suite 中登记。门禁检查插件家族目录与
`providerConformance.test.ts` 的 case 一一对应，新增插件目录但没有 contract test 会让
`npm run architecture:check` 失败。

## 通用断言

Service provider：

1. 挂载前 service 不可见；
2. 挂载后按稳定 key 可发现并可执行最小功能；
3. 同一插件重复挂载失败；
4. unmount 后 service 不可发现；
5. disposer 重复调用幂等；
6. Host 最终完整关闭。

Contribution provider：

1. 挂载前 registry snapshot 为空；
2. 挂载后 contribution 可发现且满足领域断言；
3. 同一插件重复挂载失败；
4. unmount 后 contribution 被撤销；
5. disposer 重复调用幂等。

Suite 还统一验证 activation 中途失败会回滚已经提供的 service。当前登记家族：

- `agentTransport`
- `skillResolver`
- `projectionContribution`

Testkit 不接触 Canvas UI；它约束的是 provider 生命周期、发现性和失败语义。
