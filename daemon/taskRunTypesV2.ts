import type {
  CanvasArtifactRefV2,
  CanvasDocumentV2,
} from '../src/canvas-v2/model.js'
import type { ProjectionPluginCapabilitySnapshotV2 } from './pluginCapabilitiesV2.js'
import type { CreateRunRequest } from './protocol.js'
import type { RunIntentV2 } from './taskRunProtocolV2.js'

export interface ResolvedArtifactAttachmentV2 {
  runId: string
  artifactId: string
  projectRelativePath: string
  mediaType: string
  size: number
  contentDigest: string
}

/**
 * Explicit Node attachments are immutable snapshots from RunIntent.baseRevision.
 * Their content is bounded before it reaches an Agent context pack. Artifact
 * identities remain lossless and are resolved separately through closed manifests.
 */
export interface ResolvedNodeAttachmentV2 {
  id: string
  title: string
  type: string
  text?: string
  payload?: Record<string, unknown>
  artifactRefs: CanvasArtifactRefV2[]
  truncation: {
    text: boolean
    payload: boolean
  }
}

export const MAX_RESOLVED_NODE_ATTACHMENT_TEXT_BYTES_V2 = 128 * 1024
export const MAX_RESOLVED_NODE_ATTACHMENT_PAYLOAD_BYTES_V2 = 128 * 1024
export const MAX_RESOLVED_NODE_ATTACHMENT_CONTENT_BYTES_V2 = 1024 * 1024
export const MAX_RESOLVED_NODE_ATTACHMENT_ARTIFACT_REFS_V2 = 2_000

/** RunIntent after the daemon has pinned and validated its persisted Canvas revision. */
export interface ResolvedTaskRunRequestV2 extends RunIntentV2 {
  projectDir: string
  canvasDocument: CanvasDocumentV2
  resolvedArtifactAttachments: ResolvedArtifactAttachmentV2[]
  resolvedNodeAttachments: ResolvedNodeAttachmentV2[]
  /** Daemon-resolved immutable registry. Absent callers are pinned to built-ins at acceptance. */
  pluginCapabilities?: ProjectionPluginCapabilitySnapshotV2
  automationMode: 'confirm'
}

export type RunExecutionRequest = CreateRunRequest | ResolvedTaskRunRequestV2

export function isResolvedTaskRunRequestV2(
  request: RunExecutionRequest,
): request is ResolvedTaskRunRequestV2 {
  return 'schemaVersion' in request
    && request.schemaVersion === 2
    && 'taskId' in request
    && 'canvasDocument' in request
}

export function runTargetId(request: RunExecutionRequest): string {
  return isResolvedTaskRunRequestV2(request) ? request.taskId : request.nodeId
}

export function requestedRunSessionId(request: RunExecutionRequest): string | null {
  return isResolvedTaskRunRequestV2(request) ? null : request.sessionId ?? null
}
