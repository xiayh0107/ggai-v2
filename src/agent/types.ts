/**
 * Agent 接入层类型定义。
 *
 * 架构定位（见 docs/AGENT-ARCHITECTURE.md）：
 *   产品层（画布/节点/连线） → Task Run 客户端 → daemon → 各 Agent CLI
 *
 * 本层只定义"和 Agent 说话"的契约，不实现任何 Agent loop。
 */

/* ---------------- 统一事件（UI 只消费这个，不关心背后是哪个 Agent） ---------------- */

/** 归一化后的 Agent 事件。daemon 把 ACP / JSON stream / plain stdout 都翻译成这个。 */
export type CanvasAgentEvent =
  | { type: 'thinking'; text: string }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; name: string; input: unknown }
  | { type: 'tool-result'; result: unknown }
  | { type: 'file-write'; path: string; nodeId?: string }
  | { type: 'permission-request'; id: string; action: string; detail: string }
  | { type: 'usage'; tokensIn: number; tokensOut: number }
  | { type: 'error'; message: string }
  | { type: 'done'; stopReason: 'end_turn' | 'cancelled' | 'error' }

export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting-permission'
  | 'done'
  | 'error'
  | 'cancelled'
  | 'interrupted'

export interface AgentRun {
  runId: string
  nodeId: string
  agentId: string
  status: RunStatus
  prompt: string
  startedAt: number
  finishedAt?: number
  error?: string
}
