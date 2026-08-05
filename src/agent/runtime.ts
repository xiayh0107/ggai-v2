/**
 * Agent Runtime：一次执行的生命周期。
 *
 * 这一层很薄——它不启动进程、不解析 stdio，那些交给 daemon（Node/Electron 侧）
 * 和现成的 ACP/acpx 底座。这里只做三件事：
 *   1. 打包上下文（packContext）
 *   2. 把会话恢复委托给 transport（真实 daemon 以 sessions.json 为唯一事实源）
 *   3. 把统一事件翻译回画布状态（generating → done，产物对账）
 *
 * 浏览器原型里用 MockTransport 演示；接入真实 Agent 时换成 ACPTransport，
 * 上层（InstructionPanel / NodeCard / store）完全不用改。
 */

import type { CanvasNode, Edge } from '@/types/canvas'
import { packContext } from './context'
import type { CanvasAgentEvent, ContextPack } from './types'
import type { RunOutcome } from './outcome'

export interface AgentPluginContract {
  id: string
  label: string
  description: string
  instruction?: { placeholder: string; actions: string[] }
  initialPayload?: Record<string, unknown>
}

export interface AgentCanvasSnapshot {
  nodes: CanvasNode[]
  edges: Edge[]
  plugins?: AgentPluginContract[]
}

export interface AgentTransportRunResult {
  /** Null is valid for stateless/plain-text transports that cannot resume. */
  sessionId: string | null
  /** Authoritative terminal snapshot when the transport can provide one. */
  artifacts?: string[]
  artifactsComplete?: boolean
  /** Optional versioned semantic result; absent for legacy/stateless transports. */
  outcome?: RunOutcome
}

/** 传输层契约：daemon 侧实现。浏览器原型用 Mock，桌面端用 ACP/acpx。 */
export interface AgentTransport {
  /**
   * 发送一次执行。sessionId 为显式恢复提示；null 表示由 transport 决定是否恢复。
   * DaemonClient 总是传 null，让 daemon 的持久 sessions.json 保持权威。
   */
  run(opts: {
    nodeId: string
    agentId: string
    sessionId: string | null
    prompt: string
    projectDir: string
    canvasSnapshot: AgentCanvasSnapshot
    onEvent: (e: CanvasAgentEvent) => void
    signal?: AbortSignal
  }): Promise<AgentTransportRunResult>
  /** 检测某个 Agent 是否可用（已安装、已登录） */
  probe(agentId: string): Promise<{ available: boolean; authStatus?: string }>
  cancel(sessionId: string): Promise<void>
}

/* ---------------- 执行入口 ---------------- */

export interface RunInput {
  nodeId: string
  agentId: string
  prompt: string
  nodes: CanvasNode[]
  edges: Edge[]
  projectDir: string
  plugins?: AgentPluginContract[]
  /** 事件回调：UI 用它更新节点状态/进度 */
  onEvent: (e: CanvasAgentEvent) => void
  signal?: AbortSignal
}

/**
 * 执行一次指令。可恢复 transport 返回会话 id；stateless transport 返回 null。
 * 流程：packContext（供调用方检查）→ transport.run（daemon 负责最终落盘，带会话恢复）
 */
export async function runInstruction(
  transport: AgentTransport,
  input: RunInput,
): Promise<AgentTransportRunResult & { pack: ContextPack }> {
  const pack = packContext({
    targetNodeId: input.nodeId,
    nodes: input.nodes,
    edges: input.edges,
    projectDir: input.projectDir,
  })
  const result = await transport.run({
    nodeId: input.nodeId,
    agentId: input.agentId,
    // A browser-global cache can resume a session from the wrong project/daemon.
    // The transport owns persistence and resolves the node/agent mapping itself.
    sessionId: null,
    prompt: input.prompt,
    projectDir: input.projectDir,
    canvasSnapshot: { nodes: input.nodes, edges: input.edges, plugins: input.plugins },
    onEvent: input.onEvent,
    signal: input.signal,
  })
  return { ...result, pack }
}

/* ---------------- Mock 传输层（浏览器原型用，演示事件流） ---------------- */

export class MockTransport implements AgentTransport {
  async run({ onEvent }: Parameters<AgentTransport['run']>[0]) {
    const steps: CanvasAgentEvent[] = [
      { type: 'thinking', text: '理解节点上下文与来源…' },
      { type: 'tool-call', name: 'read_context', input: { dir: '.gg/context' } },
      { type: 'thinking', text: '生成产物…' },
      { type: 'file-write', path: 'artifacts/demo/output.png' },
      { type: 'done', stopReason: 'end_turn' },
    ]
    for (const e of steps) {
      await new Promise((r) => setTimeout(r, 300))
      onEvent(e)
    }
    return { sessionId: `mock_${Date.now().toString(36)}` }
  }
  async probe() { return { available: true, authStatus: 'mock' } }
  async cancel() { /* no-op */ }
}
