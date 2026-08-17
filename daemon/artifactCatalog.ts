import { createHash } from 'node:crypto'
import type { RunClosePayload, RunSummary } from './protocol.js'

export const DEFAULT_ARTIFACT_CATALOG_LIMIT = 200
export const MAX_ARTIFACT_CATALOG_LIMIT = 500
const MAX_ARTIFACT_CATALOG_RUN_SCAN = 2_000

export interface ArtifactCatalogEntry {
  runId: string
  artifactId: string
  taskId: string
  canvasBranch: string
  relativePath: string
  mediaType: string
  size: number
  contentDigest: string
  createdAt: number
}

export interface ArtifactCatalogPage {
  schemaVersion: 2
  artifacts: ArtifactCatalogEntry[]
  truncated: boolean
  partial: boolean
  nextCursor: string | null
}

export interface VerifiedArtifactCatalogEntry {
  runId: string
  artifactId: string
  canvasBranch: string
  relativePath: string
  mediaType: string
  size: number
  contentDigest: string
}

export class ArtifactCatalogCursorError extends Error {
  constructor(message = 'artifact catalog cursor is invalid or no longer available') {
    super(message)
    this.name = 'ArtifactCatalogCursorError'
  }
}

export interface ArtifactCatalogRunSource {
  listRunHistory(
    projectDir: string,
    filter: {
      taskOwned: true
      canvasBranch?: string
      limit: number
      before?: { startedAt: number; runId: string }
      includeBefore?: boolean
    },
  ): Promise<RunSummary[]>
  readTerminalClose(runId: string, projectDir: string): Promise<RunClosePayload | null>
  lookupRunArtifact(
    runId: string,
    artifactId: string,
    projectDir: string,
  ): Promise<VerifiedArtifactCatalogEntry | null>
}

/**
 * Builds the project resource inventory from durable Run-owned manifests.
 *
 * Canvas nodes are only references to these identities, so deleting the last
 * node that points at an artifact does not remove it from this catalog. The
 * catalog deliberately ignores retired path-only output. Safe entries from a
 * partial manifest remain discoverable, while each returned identity is first
 * resolved through the verified artifact store and can only be read through
 * `/runs/:runId/artifacts/:artifactId` route, which still fails closed if the
 * file has been changed or removed after the Run closed.
 */
export async function listArtifactCatalog(
  source: ArtifactCatalogRunSource,
  projectDir: string,
  options: { canvasBranch?: string; limit?: number; cursor?: string } = {},
): Promise<ArtifactCatalogPage> {
  if (typeof projectDir !== 'string' || projectDir.length === 0) {
    throw new TypeError('projectDir must not be empty')
  }
  const limit = options.limit ?? DEFAULT_ARTIFACT_CATALOG_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ARTIFACT_CATALOG_LIMIT) {
    throw new TypeError(`limit must be between 1 and ${MAX_ARTIFACT_CATALOG_LIMIT}`)
  }
  const scope = artifactCatalogScope(projectDir, options.canvasBranch)
  const requestedCursor = options.cursor === undefined
    ? null
    : parseArtifactCatalogCursor(options.cursor, scope)

  const summaries = await source.listRunHistory(projectDir, {
    taskOwned: true,
    ...(options.canvasBranch ? { canvasBranch: options.canvasBranch } : {}),
    limit: MAX_ARTIFACT_CATALOG_RUN_SCAN,
    ...(requestedCursor?.window ? {
      before: {
        startedAt: requestedCursor.window.startedAt,
        runId: requestedCursor.window.runId,
      },
      includeBefore: requestedCursor.window.inclusive,
    } : {}),
  })
  const activeWindow = requestedCursor?.window?.inclusive
    ? requestedCursor.window
    : summaries[0]
      ? {
          startedAt: summaries[0].startedAt,
          runId: summaries[0].runId,
          inclusive: true as const,
        }
      : null
  const artifacts: ArtifactCatalogEntry[] = []
  let partial = false
  let cursorFound = requestedCursor?.anchor === null || requestedCursor === null
  let lastEmittedIdentity: { runId: string; artifactId: string } | null = null
  let hasMore = false

  scan:
  for (const summary of summaries) {
    if (!summary.taskId) continue
    let close: RunClosePayload | null
    try {
      close = await source.readTerminalClose(summary.runId, projectDir)
    } catch {
      // A damaged historical Run must not make every other resource disappear.
      // The individual verified read still fails closed for that Run.
      partial = true
      continue
    }
    const manifest = close?.artifactManifest
    if (!close) {
      if (isTerminalRunStatus(summary.status)) partial = true
      continue
    }
    if (close.runId !== summary.runId
      || !manifest
      || manifest.runId !== summary.runId) {
      partial = true
      continue
    }
    if (close.status !== summary.status) partial = true
    if (!close.artifactsComplete || !manifest.complete) partial = true

    for (const artifact of manifest.entries) {
      if (!cursorFound) {
        if (summary.runId === requestedCursor?.anchor?.runId
          && artifact.artifactId === requestedCursor.anchor.artifactId) {
          cursorFound = true
        }
        continue
      }

      let verified: VerifiedArtifactCatalogEntry | null
      try {
        verified = await source.lookupRunArtifact(
          summary.runId,
          artifact.artifactId,
          projectDir,
        )
      } catch {
        partial = true
        continue
      }
      const canvasBranch = summary.canvasBranch
      if (!verified
        || verified.runId !== summary.runId
        || verified.artifactId !== artifact.artifactId
        || verified.canvasBranch !== canvasBranch
        || verified.relativePath !== artifact.relativePath
        || verified.mediaType !== artifact.mediaType
        || verified.size !== artifact.size
        || verified.contentDigest !== artifact.contentDigest) {
        partial = true
        continue
      }
      if (artifacts.length >= limit) {
        hasMore = true
        break scan
      }
      artifacts.push({
        runId: summary.runId,
        artifactId: artifact.artifactId,
        taskId: summary.taskId,
        canvasBranch,
        relativePath: artifact.relativePath,
        mediaType: artifact.mediaType,
        size: artifact.size,
        contentDigest: artifact.contentDigest,
        createdAt: summary.finishedAt ?? summary.startedAt,
      })
      lastEmittedIdentity = {
        runId: summary.runId,
        artifactId: artifact.artifactId,
      }
    }
  }

  if (!cursorFound) throw new ArtifactCatalogCursorError()

  const scanLimitReached = summaries.length === MAX_ARTIFACT_CATALOG_RUN_SCAN
  const lastSummary = summaries.at(-1)
  const nextCursor = hasMore && activeWindow && lastEmittedIdentity
    ? encodeArtifactCatalogCursor({
        schemaVersion: 2,
        scope,
        window: activeWindow,
        anchor: lastEmittedIdentity,
      })
    : scanLimitReached && lastSummary
      ? encodeArtifactCatalogCursor({
          schemaVersion: 2,
          scope,
          window: {
            startedAt: lastSummary.startedAt,
            runId: lastSummary.runId,
            inclusive: false,
          },
          anchor: null,
        })
      : null
  return {
    schemaVersion: 2,
    artifacts,
    truncated: nextCursor !== null,
    partial,
    nextCursor,
  }
}

interface ArtifactCatalogCursorPayload {
  schemaVersion: 2
  scope: string
  window: {
    startedAt: number
    runId: string
    inclusive: boolean
  } | null
  anchor: {
    runId: string
    artifactId: string
  } | null
}

function parseArtifactCatalogCursor(
  value: unknown,
  expectedScope: string,
): ArtifactCatalogCursorPayload {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 1_024
    || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new ArtifactCatalogCursorError()
  }
  let decoded: unknown
  try {
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.toString('base64url') !== value) throw new Error('cursor is not canonical')
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new ArtifactCatalogCursorError()
  }
  if (!isExactRecord(decoded, ['schemaVersion', 'scope', 'window', 'anchor'])
    || decoded.schemaVersion !== 2
    || decoded.scope !== expectedScope
    || !isArtifactCatalogCursorWindow(decoded.window)
    || !isArtifactCatalogCursorAnchor(decoded.anchor)
    || decoded.window === null
    || (decoded.anchor === null && decoded.window.inclusive)
    || (decoded.anchor !== null && !decoded.window.inclusive)) {
    throw new ArtifactCatalogCursorError()
  }
  return {
    schemaVersion: 2,
    scope: decoded.scope,
    window: decoded.window,
    anchor: decoded.anchor,
  }
}

function encodeArtifactCatalogCursor(payload: ArtifactCatalogCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function artifactCatalogScope(
  projectDir: string,
  canvasBranch: string | undefined,
): string {
  return createHash('sha256')
    .update('ggai-artifact-catalog-scope-v2\0', 'utf8')
    .update(projectDir, 'utf8')
    .update('\0', 'utf8')
    .update(canvasBranch ?? '*', 'utf8')
    .digest('hex')
}

function isArtifactCatalogCursorWindow(
  value: unknown,
): value is ArtifactCatalogCursorPayload['window'] {
  return value === null
    || (isExactRecord(value, ['startedAt', 'runId', 'inclusive'])
      && typeof value.startedAt === 'number'
      && Number.isFinite(value.startedAt)
      && value.startedAt >= 0
      && isRunId(value.runId)
      && typeof value.inclusive === 'boolean')
}

function isArtifactCatalogCursorAnchor(
  value: unknown,
): value is ArtifactCatalogCursorPayload['anchor'] {
  return value === null
    || (isExactRecord(value, ['runId', 'artifactId'])
      && isRunId(value.runId)
      && typeof value.artifactId === 'string'
      && /^artifact_[0-9a-f]{64}$/u.test(value.artifactId))
}

function isRunId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/u.test(value)
    && !value.includes('..')
}

function isTerminalRunStatus(status: RunSummary['status']): boolean {
  return status === 'done'
    || status === 'error'
    || status === 'cancelled'
    || status === 'interrupted'
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
}
