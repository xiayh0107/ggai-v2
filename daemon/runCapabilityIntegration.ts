import { createHash, randomUUID } from 'node:crypto'
import type { Disposer } from './runtime/effects.js'
import type { CapabilityProfileSnapshot } from './runtime/composition.js'
import type { CapabilityExecutionScopes, RunCapabilityScope } from './capabilityScopes.js'
import {
  RunCapabilityReceiptStore,
  type SemanticCapabilityReceipt,
} from './capabilityReceipt.js'
import {
  BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT,
} from './pluginCapabilities.js'
import { resolveProjectDir } from './permissions.js'
import type { RunStreamMessage, RunSummary } from './protocol.js'
import {
  isResolvedTaskRunRequest,
  type RunExecutionRequest,
} from './taskRunTypes.js'
import type { RunCreationOptions } from './runs.js'

const AGENT_SELECTION_DIGEST_DOMAIN = 'ggai.agent-selection.v1'

export interface PreparedRunCapabilityRequest {
  readonly request: RunExecutionRequest
  readonly semanticCapabilities?: readonly SemanticCapabilityReceipt[]
  readonly pin?: (projectDir: string) => Promise<void>
}

export interface RunCapabilityReceiptIntegrationOptions {
  readonly projectRoot: string
  readonly scopes: CapabilityExecutionScopes
  readonly profile: CapabilityProfileSnapshot
  readonly agentProvider: (agentId: string) => string | undefined
  readonly projectionProvider?: string
  readonly skillProvider?: string
  readonly prepareRequest?: (
    request: RunExecutionRequest,
  ) => PreparedRunCapabilityRequest | Promise<PreparedRunCapabilityRequest>
}

export interface CapabilityReceiptRunManager {
  create(
    request: RunExecutionRequest,
    options?: RunCreationOptions,
  ): Promise<RunSummary>
  subscribe(
    runId: string,
    listener: (message: RunStreamMessage & { readonly id: number }) => void,
    afterId?: number,
  ): {
    readonly history: readonly (RunStreamMessage & { readonly id: number })[]
    readonly closed: boolean
    readonly replayGap: boolean
    unsubscribe(): void
  } | null
}

/**
 * Decorates the existing RunManager acceptance seam without giving runtime
 * plugins access to Run internals. Receipts and prepared semantic snapshots are
 * pinned while the Run reservation is held, before transport execution starts.
 */
export function installRunCapabilityReceiptIntegration(
  runs: CapabilityReceiptRunManager,
  options: RunCapabilityReceiptIntegrationOptions,
): Disposer {
  const originalMethod = runs.create
  const originalCreate = originalMethod.bind(runs)
  let installed = true

  const decoratedCreate: CapabilityReceiptRunManager['create'] = async (
    request,
    creationOptions = {},
  ) => {
    if (!installed) return originalCreate(request, creationOptions)
    const runId = request.runId ?? randomUUID()
    const initialRequest = { ...request, runId } as RunExecutionRequest
    const prepared = options.prepareRequest
      ? await options.prepareRequest(initialRequest)
      : { request: initialRequest }
    if (prepared.request.runId !== runId) {
      throw new TypeError('prepared Run capability request changed runId')
    }
    const acceptedRequest = prepared.request
    let runScope: RunCapabilityScope | undefined
    const priorValidation = creationOptions.validateReserved

    try {
      const summary = await originalCreate(acceptedRequest, {
        ...creationOptions,
        validateReserved: async () => {
          await priorValidation?.()
          const projectDir = await resolveProjectDir(
            options.projectRoot,
            acceptedRequest.projectDir ?? '.',
          )
          await prepared.pin?.(projectDir)
          runScope = options.scopes.workspace(projectDir).run(runId)
          const receipt = runScope.acceptCapabilities(
            options.profile,
            semanticCapabilities(
              acceptedRequest,
              options,
              prepared.semanticCapabilities ?? [],
            ),
          )
          await new RunCapabilityReceiptStore(projectDir).pin(receipt)
        },
      })

      if (runScope) await retainScopeUntilClose(runs, runId, runScope)
      return summary
    } catch (error) {
      await runScope?.dispose().catch(() => undefined)
      throw error
    }
  }

  runs.create = decoratedCreate
  return () => {
    if (!installed) return
    installed = false
    if (runs.create === decoratedCreate) runs.create = originalMethod
  }
}

function semanticCapabilities(
  request: RunExecutionRequest,
  options: RunCapabilityReceiptIntegrationOptions,
  additional: readonly SemanticCapabilityReceipt[],
): SemanticCapabilityReceipt[] {
  const provider = options.agentProvider(request.agentId)
  if (!provider) {
    throw new Error(`Agent provider is unavailable for capability receipt: ${request.agentId}`)
  }
  const capabilities: SemanticCapabilityReceipt[] = [{
    key: 'ggai.agent-selection.v1',
    provider,
    digest: digestText(AGENT_SELECTION_DIGEST_DOMAIN, request.agentId),
  }]

  if (isResolvedTaskRunRequest(request)) {
    capabilities.push({
      key: 'ggai.node-projection.v2',
      provider: options.projectionProvider ?? '@ggai/projection-capability-authority',
      digest: request.pluginCapabilities?.digest
        ?? BUILTIN_PROJECTION_PLUGIN_CAPABILITY_SNAPSHOT.digest,
    })
    capabilities.push({
      key: 'ggai.run-skills.v1',
      provider: options.skillProvider ?? '@ggai/skill-asset-authority',
      digest: request.skillCapabilityDigest,
    })
  }
  capabilities.push(...additional.map((capability) => ({ ...capability })))
  return capabilities
}

async function retainScopeUntilClose(
  runs: CapabilityReceiptRunManager,
  runId: string,
  scope: RunCapabilityScope,
): Promise<void> {
  let disposed = false
  let subscription: ReturnType<CapabilityReceiptRunManager['subscribe']> = null
  const dispose = async () => {
    if (disposed) return
    disposed = true
    subscription?.unsubscribe()
    await scope.dispose()
  }
  subscription = runs.subscribe(runId, (message) => {
    if (message.event === 'close') void dispose()
  })
  if (!subscription || subscription.closed) await dispose()
}

function digestText(domain: string, value: string): string {
  return createHash('sha256')
    .update(`${domain}\0`, 'utf8')
    .update(value, 'utf8')
    .digest('hex')
}
