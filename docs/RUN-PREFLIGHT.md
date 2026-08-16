# Task Run Preflight Contract

`POST /task-runs/preflight` 为 Canvas 提供只读、无预留的 Task Run 启动检查。它的目标是让
空节点在用户真正创建 Run 前给出稳定、可操作的反馈；它不是授权票据，也不能替代 Run
acceptance lease 内的权威校验。

## 请求

请求体复用真实 `RunIntent` 的身份、revision 与附件校验规则：

```json
{
  "taskId": "task-1",
  "agentId": "codex",
  "canvasBranch": "main",
  "baseRevision": 12,
  "attachments": []
}
```

可选查询参数 `projectDir` 与其他 Task Run API 一致。未知字段、重复附件、非法 ID、越界附件
数量或非法 revision 均返回 HTTP 400 和 `invalid_task_run_preflight`，避免预检与真实 Run
解析规则分叉。

## 响应

检查通过时：

```json
{
  "status": "ready",
  "issues": []
}
```

检查不通过时仍返回 HTTP 200，便于 UI 将多个稳定问题映射为节点状态与“重新检测”操作：

```json
{
  "status": "blocked",
  "issues": [
    {
      "code": "generation_service_unauthenticated",
      "message": "生成服务尚未登录，请完成登录后重试。",
      "retryable": true
    }
  ]
}
```

`code` 只取以下稳定值：

- `generation_service_unavailable`
- `generation_service_unauthenticated`
- `task_agent_mismatch`
- `attachment_unavailable`
- `skill_unavailable`
- `canvas_revision_changed`

响应不暴露 provider id、service key、artifact digest、Skill digest 或 projection digest。

## 校验范围

预检使用真实 Run 路径的解析与验证组件，检查：

1. 目标 Agent 是否存在、可用且已认证；
2. 已有 Task session 是否绑定同一 Agent；
3. Task、branch 与 daemon 容量是否允许启动；
4. 指定 branch/revision 是否仍存在目标 Task；
5. artifact 是否来自 closed manifest 且读取时可复验；
6. Node attachment 是否属于指定 revision；
7. 参与节点的 Skills 是否完整且 revision 唯一；
8. 当前 builtins 与 Workspace runtime contributions 是否能组成 canonical projection capability v3，用于附件上下文解析。

可用性检查不会获得 branch、Task、Run id 或容量 lease，不创建 summary，不启动 transport。
因此预检完成后状态仍可能变化。`POST /runs` 必须在 reservation 成功后重新读取 revision，并再次
验证附件、Skills 与 projection capabilities；实现不得把预检结果缓存成启动许可。
