import type { CanvasAgentEvent } from '../../src/agent/types.js'
import type { AgentDescriptor, AgentTransportKind } from '../protocol.js'

export interface TransportRunOptions {
  runId: string
  nodeId: string
  agentId: string
  sessionId: string | null
  prompt: string
  projectDir: string
  /** Explicitly bound, writable source worktree; absent keeps source read-only. */
  sourceProjectDir?: string
  contextFile: string
  artifactDir: string
  signal: AbortSignal
  onEvent: (event: CanvasAgentEvent) => void
  onSessionId: (sessionId: string) => void
}

export interface TransportRunResult {
  sessionId: string | null
}

export interface AgentProcessTransport {
  readonly kind: AgentTransportKind
  run(options: TransportRunOptions): Promise<TransportRunResult>
  cancel(runId: string): Promise<boolean>
}

export interface AgentRegistryTransport {
  probe(): Promise<AgentDescriptor[]>
}

export class TransportError extends Error {
  readonly code: string

  constructor(message: string, code = 'transport_error') {
    super(message)
    this.name = 'TransportError'
    this.code = code
  }
}

export function abortError(): Error {
  const error = new Error('Agent run was cancelled')
  error.name = 'AbortError'
  return error
}
