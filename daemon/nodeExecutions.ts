import { createHash, randomBytes } from 'node:crypto'
import type { CanvasDocument, CanvasNode } from '../src/canvas/model.js'
import {
  validateExecutionOutputs,
  type NodeExecution,
  type ValueRef,
} from '../src/execution/contracts.js'
import type { MetadataStore } from './metadataStore.js'

export interface NodeExecutorInput {
  executionId: string
  artifactRunId: string
  projectDir?: string
  canvasBranch: string
  document: CanvasDocument
  node: CanvasNode
  inputs: Record<string, ValueRef[]>
  signal: AbortSignal
}

export interface NodeExecutor {
  id: string
  environmentDigest: string
  supports(nodeTypeId: string): boolean
  execute(input: NodeExecutorInput): Promise<Record<string, ValueRef[]>>
}

export class NodeExecutorRegistry {
  readonly #providers = new Map<string, NodeExecutor>()

  register(provider: NodeExecutor): () => void {
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(provider.id)
      || !/^[0-9a-f]{64}$/u.test(provider.environmentDigest)
      || this.#providers.has(provider.id)) throw new TypeError('Node executor descriptor is invalid')
    this.#providers.set(provider.id, provider)
    return () => {
      if (this.#providers.get(provider.id) === provider) this.#providers.delete(provider.id)
    }
  }

  resolve(nodeTypeId: string): NodeExecutor | null {
    return [...this.#providers.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .find((provider) => provider.supports(nodeTypeId)) ?? null
  }
}

export class NodeExecutionError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'NodeExecutionError'
    this.code = code
    this.status = status
  }
}

export class NodeExecutionService {
  readonly #metadata: MetadataStore
  readonly #executors: NodeExecutorRegistry
  readonly #active = new Map<string, AbortController>()

  constructor(metadata: MetadataStore, executors = new NodeExecutorRegistry()) {
    this.#metadata = metadata
    this.#executors = executors
  }

  get executors(): NodeExecutorRegistry {
    return this.#executors
  }

  async start(input: {
    projectId: string
    projectDir?: string
    canvasBranch: string
    document: CanvasDocument
    nodeId: string
    force: boolean
  }): Promise<NodeExecution> {
    const node = input.document.nodes.find((entry) => entry.id === input.nodeId)
    if (!node) throw new NodeExecutionError('node_not_found', `Node does not exist: ${input.nodeId}`, 404)
    const executor = this.#executors.resolve(node.typeRef.id)
    if (!executor) {
      throw new NodeExecutionError(
        'node_executor_unavailable',
        `No trusted executor is available for ${node.typeRef.id}`,
        409,
      )
    }
    const { inputs, inputsDigest } = await this.#resolveInputs(
      input.projectId,
      input.canvasBranch,
      input.document,
      node,
    )
    const codeDigest = createHash('sha256')
      .update(JSON.stringify(executionNodeSnapshot(input.document, node.id)))
      .digest('hex')
    const cacheKey = createHash('sha256').update(JSON.stringify({
      nodeTypeRef: node.typeRef,
      executorId: executor.id,
      environmentDigest: executor.environmentDigest,
      inputsDigest,
      codeDigest,
    })).digest('hex')
    if (!input.force) {
      const cached = await this.#metadata.findCachedExecution({
        projectId: input.projectId,
        canvasBranch: input.canvasBranch,
        nodeId: node.id,
        cacheKey,
      })
      if (cached) return cached
    }

    const executionId = `execution_${randomBytes(16).toString('hex')}`
    const execution: NodeExecution = {
      executionId,
      projectId: input.projectId,
      canvasBranch: input.canvasBranch,
      nodeId: node.id,
      nodeTypeRef: structuredClone(node.typeRef),
      executorId: executor.id,
      artifactRunId: `execution-artifacts-${executionId}`,
      inputsDigest,
      codeDigest,
      environmentDigest: executor.environmentDigest,
      cacheKey,
      status: 'running',
      outputs: {},
      startedAt: new Date().toISOString(),
    }
    const created = await this.#metadata.createExecution(execution)
    const controller = new AbortController()
    this.#active.set(executionId, controller)
    void this.#run(
      created,
      executor,
      structuredClone(input.document),
      structuredClone(node),
      inputs,
      controller,
      input.projectDir,
    )
    return created
  }

  list(projectId: string, canvasBranch: string, nodeId: string): Promise<NodeExecution[]> {
    return this.#metadata.listExecutions({ projectId, canvasBranch, nodeId })
  }

  get(executionId: string): Promise<NodeExecution | null> {
    return this.#metadata.getExecution(executionId)
  }

  outputs(executionId: string): Promise<Record<string, ValueRef[]> | null> {
    return this.get(executionId).then((execution) => execution?.outputs ?? null)
  }

  provenance(projectId: string, nodeId: string) {
    return this.#metadata.queryProvenance(projectId, `node:${nodeId}`)
  }

  recordTaskRun(input: {
    projectId: string
    taskId: string
    runId: string
    agentId: string
  }): Promise<void> {
    return this.#metadata.appendProvenance([{
      projectId: input.projectId,
      relationKind: 'was-generated-by',
      subjectId: `task:${input.taskId}`,
      objectId: `run:${input.runId}`,
      attributes: {},
    }, {
      projectId: input.projectId,
      relationKind: 'was-associated-with',
      subjectId: `run:${input.runId}`,
      objectId: `agent:${input.agentId}`,
      attributes: {},
    }])
  }

  cancel(executionId: string): boolean {
    const controller = this.#active.get(executionId)
    if (!controller) return false
    controller.abort()
    return true
  }

  async #run(
    execution: NodeExecution,
    executor: NodeExecutor,
    document: CanvasDocument,
    node: CanvasNode,
    inputs: Record<string, ValueRef[]>,
    controller: AbortController,
    projectDir?: string,
  ): Promise<void> {
    try {
      const outputs = await executor.execute({
        executionId: execution.executionId,
        artifactRunId: execution.artifactRunId,
        projectDir,
        canvasBranch: execution.canvasBranch,
        document,
        node,
        inputs,
        signal: controller.signal,
      })
      validateExecutionOutputs(outputs)
      await this.#metadata.completeExecution({
        executionId: execution.executionId,
        status: controller.signal.aborted ? 'cancelled' : 'succeeded',
        outputs: controller.signal.aborted ? {} : outputs,
        finishedAt: new Date().toISOString(),
      })
      await this.#metadata.appendProvenance([{
        projectId: execution.projectId,
        relationKind: 'was-generated-by',
        subjectId: `node:${execution.nodeId}`,
        objectId: `execution:${execution.executionId}`,
        attributes: { executorId: execution.executorId },
      }, {
        projectId: execution.projectId,
        relationKind: 'was-associated-with',
        subjectId: `execution:${execution.executionId}`,
        objectId: `executor:${execution.executorId}`,
        attributes: { environmentDigest: execution.environmentDigest },
      }, ...Object.values(outputs).flatMap((values) => values
        .filter((value): value is Extract<ValueRef, { kind: 'artifact' }> => value.kind === 'artifact')
        .map((value) => ({
          projectId: execution.projectId,
          relationKind: 'was-generated-by' as const,
          subjectId: `artifact:${value.runId}:${value.artifactId}`,
          objectId: `execution:${execution.executionId}`,
          attributes: {},
        }))), ...Object.values(inputs).flatMap((values) => values
        .filter((value): value is Extract<ValueRef, { kind: 'artifact' }> => value.kind === 'artifact')
        .map((value) => ({
          projectId: execution.projectId,
          relationKind: 'used' as const,
          subjectId: `execution:${execution.executionId}`,
          objectId: `artifact:${value.runId}:${value.artifactId}`,
          attributes: {},
        })))])
    } catch (error) {
      await this.#metadata.completeExecution({
        executionId: execution.executionId,
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        outputs: {},
        finishedAt: new Date().toISOString(),
        error: {
          code: controller.signal.aborted ? 'cancelled' : 'executor_failed',
          message: error instanceof Error ? error.message : String(error),
        },
      }).catch(() => undefined)
    } finally {
      this.#active.delete(execution.executionId)
    }
  }

  async #resolveInputs(
    projectId: string,
    canvasBranch: string,
    document: CanvasDocument,
    node: CanvasNode,
  ): Promise<{ inputs: Record<string, ValueRef[]>; inputsDigest: string }> {
    const inputs: Record<string, ValueRef[]> = {}
    const inbound = document.edges.filter((edge) => edge.relation === 'data'
      && edge.to.kind === 'node' && edge.to.id === node.id)
      .sort((left, right) => (left.orderKey ?? '').localeCompare(right.orderKey ?? ''))
    for (const edge of inbound) {
      if (edge.from.kind !== 'node' || !edge.from.port || edge.to.kind !== 'node' || !edge.to.port) {
        throw new NodeExecutionError('invalid_data_edge', 'Data edge is missing a named port')
      }
      const source = document.nodes.find((entry) => entry.id === edge.from.id)
      if (!source) throw new NodeExecutionError('execution_input_missing', 'Data source node is missing')
      const history = await this.#metadata.listExecutions({
        projectId,
        canvasBranch,
        nodeId: source.id,
        limit: 100,
      })
      const upstream = source.selectedExecutionId
        ? history.find((entry) => entry.executionId === source.selectedExecutionId)
        : history.find((entry) => entry.status === 'succeeded')
      const values = upstream?.outputs[edge.from.port]
      if (!upstream || !values) {
        throw new NodeExecutionError(
          'execution_input_unavailable',
          `Input ${edge.to.port} has no successful upstream output`,
        )
      }
      ;(inputs[edge.to.port] ??= []).push(...structuredClone(values))
    }
    return {
      inputs,
      inputsDigest: createHash('sha256').update(JSON.stringify(inputs)).digest('hex'),
    }
  }
}

function executionNodeSnapshot(document: CanvasDocument, rootId: string) {
  const included = new Set([rootId])
  let changed = true
  while (changed) {
    changed = false
    for (const node of document.nodes) {
      if (node.parentId && included.has(node.parentId) && !included.has(node.id)) {
        included.add(node.id)
        changed = true
      }
    }
  }
  return document.nodes.filter((node) => included.has(node.id))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((node) => ({
      id: node.id,
      typeRef: node.typeRef,
      parentId: node.parentId,
      orderKey: node.orderKey,
      bounds: node.bounds,
      transform: node.transform,
      coordinateSpace: node.coordinateSpace ?? null,
      text: node.text ?? null,
      payload: node.payload ?? null,
      artifactRefs: node.artifactRefs,
    }))
}
