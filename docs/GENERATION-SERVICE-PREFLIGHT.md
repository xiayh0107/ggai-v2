# Generation Service Preflight

Canvas 在创建 Run 前需要知道当前选定的生成服务是否可用，但节点不应展示 Runtime plugin、
provider、可执行文件路径、版本或 capability digest。

`GET /generation/preflight?agentId=<id>` 提供面向产品的最小只读投影：

```json
{
  "schemaVersion": 1,
  "agentId": "codex",
  "state": "ready",
  "ready": true,
  "retryable": false
}
```

异常状态只返回稳定 issue code：

- `generation_service_not_found`
- `generation_service_not_authenticated`
- `generation_service_unavailable`
- `generation_service_probe_failed`

原始 probe detail、provider id、binary path、版本和 digest 不跨越该边界。UI 负责把 issue code
翻译成简短说明，并只在异常时显示“重新检测”。正常状态保持安静。

该接口是显式重试的实时检查，不是 durable Run 事实，也不改变 `taskId + agentId` 的会话身份。
继续既有 Task 时仍使用原 Agent；未来需要多 Agent 选择时，应在首次 Run 创建前完成选择。
