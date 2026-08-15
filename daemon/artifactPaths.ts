import path from 'node:path'
import { canvasBranchStorageId } from './canvasBranch.js'
import { parseCanvasBranch, parseNodeId, parseRunId } from './protocol.js'

export const ARTIFACT_CONTROL_DIRECTORY = '.ggai'

/** Control metadata is never a user-facing artifact, regardless of nesting. */
export function isArtifactControlPath(value: string): boolean {
  return value.split(/[\\/]/u).includes(ARTIFACT_CONTROL_DIRECTORY)
}

/** Immutable namespace for one run; logical branch names never enter the path. */
export function artifactRunRelativeDir(
  canvasBranch: string,
  runId: string,
  nodeId: string,
): string {
  return path.posix.join(
    'artifacts',
    '.branches',
    canvasBranchStorageId(parseCanvasBranch(canvasBranch)),
    parseRunId(runId),
    parseNodeId(nodeId),
  )
}

export function artifactRunDir(
  projectDir: string,
  canvasBranch: string,
  runId: string,
  nodeId: string,
): string {
  return path.resolve(
    projectDir,
    ...artifactRunRelativeDir(canvasBranch, runId, nodeId).split('/'),
  )
}

export function isSafeArtifactReference(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 4_096
    || value.includes('\\')
    || value.includes('\0')
    || path.posix.isAbsolute(value)
  ) return false
  const normalized = path.posix.normalize(value)
  return normalized === value
    && value.startsWith('artifacts/')
    && !value.split('/').includes('..')
    && !isArtifactControlPath(value)
}

/**
 * Artifact references are durable node data, so inherited immutable paths may
 * belong to another canvas branch/run, but never to another node.
 */
export function isArtifactReferenceForNode(value: unknown, nodeId: string): value is string {
  if (!isSafeArtifactReference(value)) return false
  const segments = value.split('/')
  if (segments[0] !== 'artifacts') return false

  if (segments[1] !== '.branches') {
    return segments.length >= 3 && segments[1] === parseNodeId(nodeId)
  }

  if (
    segments.length < 6
    || !/^[0-9a-f]{64}$/u.test(segments[2] ?? '')
    || segments[4] !== parseNodeId(nodeId)
  ) return false
  try {
    parseRunId(segments[3])
    return true
  } catch {
    return false
  }
}
