import type { CanvasDocumentV2 } from '../src/canvas-v2/model.js'
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

/** RunIntent after the daemon has pinned and validated its persisted Canvas revision. */
export interface ResolvedTaskRunRequestV2 extends RunIntentV2 {
  projectDir: string
  canvasDocument: CanvasDocumentV2
  resolvedArtifactAttachments: ResolvedArtifactAttachmentV2[]
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
