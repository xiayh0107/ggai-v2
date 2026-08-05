import { isArtifactReferenceForNode } from './artifactPaths.js'
import type {
  CanvasDocumentV1,
  DaemonRunStatus,
} from './protocol.js'

export const DEFAULT_CHECKPOINT_METADATA_LIMITS = Object.freeze({
  maxReferencedRuns: 2_000,
  runLoadConcurrency: 8,
  maxArtifactPathsPerNode: 500,
  maxArtifactPaths: 20_000,
  maxArtifactPathBytes: 2 * 1024 * 1024,
})

export interface CheckpointMetadataLimits {
  maxReferencedRuns: number
  runLoadConcurrency: number
  maxArtifactPathsPerNode: number
  maxArtifactPaths: number
  maxArtifactPathBytes: number
}

/** Sanitized run metadata safe to retain in immutable Canvas Git history. */
export interface CheckpointRunMetadataV1 {
  version: 1
  runId: string
  nodeId: string
  agentId: string
  canvasBranch: string
  status: DaemonRunStatus
  startedAt: number
  finishedAt?: number
  logAvailable: boolean
}

export interface CheckpointRunCollectionIndexV1 {
  version: 1
  kind: 'run-summaries'
  referenced: number
  attempted: number
  included: number
  rejected: number
  complete: boolean
  truncated: boolean
}

/** Per-node references only; artifact contents remain outside Canvas Git. */
export interface CheckpointArtifactManifestV1 {
  version: 1
  nodeId: string
  paths: string[]
  totalSafePaths: number
  truncated: boolean
}

export interface CheckpointArtifactCollectionIndexV1 {
  version: 1
  kind: 'artifact-manifests'
  referencedNodes: number
  includedNodes: number
  referencedPaths: number
  includedPaths: number
  invalidPaths: number
  complete: boolean
  truncated: boolean
}

export interface LoadedCheckpointRunSummary {
  /** Loader-reported project scope; mismatches are never retained. */
  projectDir: string
  summary: unknown
}

export interface CheckpointRunLoadRequest {
  projectDir: string
  runId: string
}

export type CheckpointRunSummaryLoader = (
  request: CheckpointRunLoadRequest,
) => Promise<LoadedCheckpointRunSummary | null>

export interface BuildCheckpointMetadataInput {
  projectDir: string
  branch: string
  /** Must already have passed parseCanvasDocument at the daemon boundary. */
  document: CanvasDocumentV1
  loadRunSummary: CheckpointRunSummaryLoader
  limits?: Partial<CheckpointMetadataLimits>
}

export interface CheckpointMetadata {
  runs: CheckpointRunMetadataV1[]
  runIndex: CheckpointRunCollectionIndexV1
  artifacts: CheckpointArtifactManifestV1[]
  artifactIndex: CheckpointArtifactCollectionIndexV1
}

interface ReferencedRun {
  runId: string
  nodeIds: ReadonlySet<string>
}

const RUN_STATUSES = new Set<DaemonRunStatus>([
  'preparing',
  'running',
  'awaiting-permission',
  'done',
  'error',
  'cancelled',
  'interrupted',
])

/**
 * Builds bounded, deterministic Canvas Git metadata. Loader failures and
 * stale/cross-scope summaries reduce completeness but never fail a checkpoint.
 */
export async function buildCheckpointMetadata(
  input: BuildCheckpointMetadataInput,
): Promise<CheckpointMetadata> {
  if (!input.projectDir.trim()) throw new TypeError('projectDir must not be empty')
  if (!input.branch.trim()) throw new TypeError('branch must not be empty')
  const limits = resolveLimits(input.limits)
  const artifacts = buildArtifactMetadata(input.document, limits)
  const runs = await buildRunMetadata(input, limits)
  return { ...runs, ...artifacts }
}

function buildArtifactMetadata(
  document: CanvasDocumentV1,
  limits: CheckpointMetadataLimits,
): Pick<CheckpointMetadata, 'artifacts' | 'artifactIndex'> {
  const artifacts: CheckpointArtifactManifestV1[] = []
  let referencedNodes = 0
  let referencedPaths = 0
  let includedPaths = 0
  let includedBytes = 0
  let invalidPaths = 0

  const nodes = [...document.nodes].sort((left, right) => left.id.localeCompare(right.id))
  for (const node of nodes) {
    const values = Array.isArray(node.payload?.artifactFiles)
      ? node.payload.artifactFiles
      : []
    const safePaths = new Set<string>()
    for (const value of values) {
      if (isArtifactReferenceForNode(value, node.id)) safePaths.add(value)
      else invalidPaths += 1
    }
    const paths = [...safePaths].sort((left, right) => left.localeCompare(right))
    if (paths.length === 0) continue

    referencedNodes += 1
    referencedPaths += paths.length
    const included: string[] = []
    for (const path of paths) {
      if (included.length >= limits.maxArtifactPathsPerNode
        || includedPaths >= limits.maxArtifactPaths) break
      const bytes = Buffer.byteLength(path, 'utf8')
      if (includedBytes + bytes > limits.maxArtifactPathBytes) continue
      included.push(path)
      includedPaths += 1
      includedBytes += bytes
    }
    if (included.length > 0) {
      artifacts.push({
        version: 1,
        nodeId: node.id,
        paths: included,
        totalSafePaths: paths.length,
        truncated: included.length < paths.length,
      })
    }
  }

  const truncated = includedPaths < referencedPaths
  const complete = !truncated && invalidPaths === 0
  return {
    artifacts,
    artifactIndex: {
      version: 1,
      kind: 'artifact-manifests',
      referencedNodes,
      includedNodes: artifacts.length,
      referencedPaths,
      includedPaths,
      invalidPaths,
      complete,
      truncated,
    },
  }
}

async function buildRunMetadata(
  input: BuildCheckpointMetadataInput,
  limits: CheckpointMetadataLimits,
): Promise<Pick<CheckpointMetadata, 'runs' | 'runIndex'>> {
  const references = referencedRuns(input.document)
  const selected = references.slice(0, limits.maxReferencedRuns)
  const runs: CheckpointRunMetadataV1[] = []
  let rejected = 0

  for (let offset = 0; offset < selected.length; offset += limits.runLoadConcurrency) {
    const batch = selected.slice(offset, offset + limits.runLoadConcurrency)
    const loaded = await Promise.all(batch.map(async (reference) => {
      try {
        return await input.loadRunSummary({
          projectDir: input.projectDir,
          runId: reference.runId,
        })
      } catch {
        return null
      }
    }))
    for (const [index, candidate] of loaded.entries()) {
      const reference = batch[index]
      const metadata = reference
        ? sanitizeRunSummary(candidate, input.projectDir, input.branch, reference)
        : null
      if (metadata) runs.push(metadata)
      else rejected += 1
    }
  }

  const truncated = selected.length < references.length
  return {
    runs,
    runIndex: {
      version: 1,
      kind: 'run-summaries',
      referenced: references.length,
      attempted: selected.length,
      included: runs.length,
      rejected,
      complete: !truncated && rejected === 0,
      truncated,
    },
  }
}

function referencedRuns(document: CanvasDocumentV1): ReferencedRun[] {
  const byRunId = new Map<string, Set<string>>()
  const add = (nodeId: string, runId: string | undefined) => {
    if (!runId) return
    let nodeIds = byRunId.get(runId)
    if (!nodeIds) {
      nodeIds = new Set<string>()
      byRunId.set(runId, nodeIds)
    }
    nodeIds.add(nodeId)
  }

  for (const node of document.nodes) {
    add(node.id, document.latestRunByNodeId[node.id])
    add(node.id, document.runRefsByNodeId[node.id]?.runId)
  }
  return [...byRunId.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([runId, nodeIds]) => ({ runId, nodeIds }))
}

function sanitizeRunSummary(
  loaded: LoadedCheckpointRunSummary | null,
  projectDir: string,
  branch: string,
  reference: ReferencedRun,
): CheckpointRunMetadataV1 | null {
  if (!loaded || loaded.projectDir !== projectDir || !isRecord(loaded.summary)) return null
  const summary = loaded.summary
  const canvasBranch = summary.canvasBranch === undefined ? 'main' : summary.canvasBranch
  if (
    summary.runId !== reference.runId
    || typeof summary.nodeId !== 'string'
    || !reference.nodeIds.has(summary.nodeId)
    || canvasBranch !== branch
    || typeof summary.agentId !== 'string'
    || summary.agentId.length === 0
    || summary.agentId.length > 160
    || typeof summary.status !== 'string'
    || !RUN_STATUSES.has(summary.status as DaemonRunStatus)
    || !isTimestamp(summary.startedAt)
    || (summary.finishedAt !== undefined && !isTimestamp(summary.finishedAt))
    || (summary.logAvailable !== undefined && typeof summary.logAvailable !== 'boolean')
  ) return null

  return {
    version: 1,
    runId: reference.runId,
    nodeId: summary.nodeId,
    agentId: summary.agentId,
    canvasBranch: branch,
    status: summary.status as DaemonRunStatus,
    startedAt: summary.startedAt,
    ...(summary.finishedAt === undefined ? {} : { finishedAt: summary.finishedAt }),
    logAvailable: summary.logAvailable !== false,
  }
}

function resolveLimits(
  overrides: Partial<CheckpointMetadataLimits> | undefined,
): CheckpointMetadataLimits {
  const limits = { ...DEFAULT_CHECKPOINT_METADATA_LIMITS, ...overrides }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${name} must be a positive safe integer`)
    }
  }
  return limits
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}
