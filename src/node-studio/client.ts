import {
  isNodeStudioDefinition,
  validateNodeStudioDefinition,
  type NodeStudioDefinition,
} from './model'

export class NodeDefinitionRequestError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'NodeDefinitionRequestError'
    this.status = status
    this.code = code
  }
}

export interface NodeDefinitionApi {
  list(signal?: AbortSignal): Promise<NodeStudioDefinition[]>
  save(manifest: NodeStudioDefinition, signal?: AbortSignal): Promise<NodeStudioDefinition>
  delete(id: string, signal?: AbortSignal): Promise<void>
  startAgent(requirement: string, definition: NodeStudioDefinition, signal?: AbortSignal): Promise<string>
  getAgentRun(runId: string, signal?: AbortSignal): Promise<NodeStudioAgentRun>
  cancelAgentRun(runId: string, signal?: AbortSignal): Promise<void>
}

export interface NodeStudioAgentRun {
  runId: string
  status: 'preparing' | 'running' | 'awaiting-permission' | 'done' | 'error' | 'cancelled' | 'interrupted'
  progress?: string
  error?: string
  definition?: NodeStudioDefinition
}

export class NodeDefinitionClient implements NodeDefinitionApi {
  readonly baseUrl: string

  constructor({ baseUrl }: { baseUrl: string }) {
    this.baseUrl = baseUrl.replace(/\/$/u, '')
  }

  async list(signal?: AbortSignal): Promise<NodeStudioDefinition[]> {
    const payload = await this.request('/node-definitions', { signal })
    if (!isRecord(payload)
      || !hasExactKeys(payload, ['schemaVersion', 'definitions'])
      || payload.schemaVersion !== 1
      || !Array.isArray(payload.definitions)) {
      throw new TypeError('节点定义列表响应格式无效')
    }
    if (!payload.definitions.every(isValidNodeStudioDefinition)) {
      throw new TypeError('节点定义列表包含无效项目')
    }
    return structuredClone(payload.definitions)
  }

  async save(manifest: NodeStudioDefinition, signal?: AbortSignal): Promise<NodeStudioDefinition> {
    if (!isValidNodeStudioDefinition(manifest)) throw new TypeError('节点定义保存请求无效')
    const payload = await this.request(`/node-definitions/${encodeURIComponent(manifest.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
      signal,
    })
    if (!isRecord(payload)
      || !hasExactKeys(payload, ['schemaVersion', 'definition'])
      || payload.schemaVersion !== 1
      || !isValidNodeStudioDefinition(payload.definition)) {
      throw new TypeError('节点定义保存响应格式无效')
    }
    if (payload.definition.id !== manifest.id) throw new TypeError('节点定义保存响应 ID 不一致')
    if (payload.definition.revision !== manifest.revision + 1) {
      throw new TypeError('节点定义保存响应版本不连续')
    }
    return structuredClone(payload.definition)
  }

  async delete(id: string, signal?: AbortSignal): Promise<void> {
    if (!isLocalNodeId(id)) throw new TypeError('节点定义删除请求 ID 无效')
    const payload = await this.request(`/node-definitions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      signal,
    })
    if (!isRecord(payload)
      || !hasExactKeys(payload, ['schemaVersion', 'deletedId'])
      || payload.schemaVersion !== 1
      || payload.deletedId !== id) {
      throw new TypeError('节点定义删除响应格式无效')
    }
  }

  async startAgent(
    requirement: string,
    definition: NodeStudioDefinition,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!requirement.trim() || !isValidNodeStudioDefinition(definition)) {
      throw new TypeError('节点设计 Agent 请求无效')
    }
    const payload = await this.request('/node-studio/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requirement: requirement.trim(), definition }),
      signal,
    })
    if (!isRecord(payload)
      || !hasExactKeys(payload, ['schemaVersion', 'runId', 'status'])
      || payload.schemaVersion !== 1
      || typeof payload.runId !== 'string'
      || !payload.runId
      || !isAgentRunStatus(payload.status)) {
      throw new TypeError('节点设计 Agent 启动响应格式无效')
    }
    return payload.runId
  }

  async getAgentRun(runId: string, signal?: AbortSignal): Promise<NodeStudioAgentRun> {
    const payload = await this.request(`/node-studio/runs/${encodeURIComponent(runId)}`, { signal })
    if (!isRecord(payload)
      || !hasExactKeys(
        payload,
        ['schemaVersion', 'runId', 'status'],
        ['progress', 'error', 'definition'],
      )
      || payload.schemaVersion !== 1
      || payload.runId !== runId
      || !isAgentRunStatus(payload.status)) {
      throw new TypeError('节点设计 Agent 状态响应格式无效')
    }
    if ((payload.progress !== undefined && typeof payload.progress !== 'string')
      || (payload.error !== undefined && typeof payload.error !== 'string')) {
      throw new TypeError('节点设计 Agent 状态响应格式无效')
    }
    if (payload.definition !== undefined && !isValidNodeStudioDefinition(payload.definition)) {
      throw new TypeError('节点设计 Agent 返回了无效定义')
    }
    if ((payload.status === 'done') !== (payload.definition !== undefined)) {
      throw new TypeError('节点设计 Agent 终态响应格式无效')
    }
    return {
      runId,
      status: payload.status,
      ...(typeof payload.progress === 'string' ? { progress: payload.progress } : {}),
      ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
      ...(payload.definition ? { definition: structuredClone(payload.definition) } : {}),
    }
  }

  async cancelAgentRun(runId: string, signal?: AbortSignal): Promise<void> {
    const payload = await this.request(`/node-studio/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal,
    })
    if (!isRecord(payload)
      || !hasExactKeys(payload, ['schemaVersion', 'runId', 'status'])
      || payload.schemaVersion !== 1
      || payload.runId !== runId
      || payload.status !== 'cancelled') {
      throw new TypeError('节点设计 Agent 取消响应格式无效')
    }
  }

  async request(pathname: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${pathname}`, init)
    const payload: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const nestedError = isRecord(payload) && isRecord(payload.error) ? payload.error : null
      const message = nestedError && typeof nestedError.message === 'string'
        ? nestedError.message
        : isRecord(payload) && typeof payload.message === 'string'
          ? payload.message
          : `节点工作台请求失败（${response.status}）`
      const code = nestedError && typeof nestedError.code === 'string'
        ? nestedError.code
        : 'node_studio_request_failed'
      throw new NodeDefinitionRequestError(response.status, code, message)
    }
    return payload
  }
}

function isAgentRunStatus(value: unknown): value is NodeStudioAgentRun['status'] {
  return typeof value === 'string' && [
    'preparing', 'running', 'awaiting-permission', 'done', 'error', 'cancelled', 'interrupted',
  ].includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidNodeStudioDefinition(value: unknown): value is NodeStudioDefinition {
  return isNodeStudioDefinition(value) && validateNodeStudioDefinition(value).length === 0
}

function isLocalNodeId(value: string): boolean {
  return /^@local\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const actual = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key))
    && actual.every((key) => allowed.has(key))
}
