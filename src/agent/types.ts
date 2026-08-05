/**
 * Agent 接入层类型定义。
 *
 * 架构定位（见 docs/AGENT-ARCHITECTURE.md）：
 *   产品层（画布/节点/连线） → Agent Runtime（本目录） → ACP/acpx（现成底座） → 各 Agent CLI
 *
 * 本层只定义"和 Agent 说话"的契约，不实现任何 Agent loop。
 */

import type { CanvasNode, Edge } from '../types/canvas.js'

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

/* ---------------- 上下文包（画布 → Agent 的唯一通道） ---------------- */

/**
 * 一次执行发给 Agent 的上下文，三层裁剪：
 *   L0 契约层：AGENTS.md + 插件清单，永远带
 *   L1 图谱层：相关子图的节点/连线摘要（无正文）
 *   L2 内容层：源节点的完整 payload
 */
export interface ContextPack {
  /** 触发的节点 */
  targetNodeId: string
  /** L0：项目级契约（AGENTS.md 内容 + 启用插件的一句话契约） */
  contract: string
  /** L1：本次涉及子图的图谱摘要 */
  graphSummary: GraphSummary
  /** L2：源节点完整内容（key = nodeId） */
  sourceContents: Record<string, NodeContent>
  /** 写盘后的项目目录（Agent 的 -C 工作目录） */
  projectDir: string
}

export interface GraphSummary {
  nodes: Array<Pick<CanvasNode, 'id' | 'type' | 'title'> & { meta?: string[] }>
  edges: Array<Pick<Edge, 'from' | 'to' | 'label'>>
}

/** 一个节点暴露给 Agent 的完整内容（payload 已序列化为可读形态） */
export interface NodeContent {
  type: string
  title: string
  text?: string
  meta?: string[]
  /** User-selected local/context attachments associated with this node. */
  attachments?: string[]
  payload?: Record<string, unknown>
  /** 产物文件路径（相对 projectDir；新运行使用 branch/run 隔离的不可变目录） */
  artifactFiles?: string[]
}

/* ---------------- 会话与任务 ---------------- */

/** 节点 ↔ Agent 会话的映射。sessionId 由底层 CLI（codex thread / acp session）提供，用于恢复。 */
export interface AgentSession {
  /** Logical canvas branch that owns this resumable session. */
  canvasBranch: string
  nodeId: string
  agentId: string
  sessionId: string | null   // null = 尚未建立（首轮）
  createdAt: number
  lastActiveAt: number
}

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
