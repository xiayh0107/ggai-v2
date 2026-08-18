import {
  compileTaskContext,
  taskContextArtifactRefs,
} from '../src/agent/taskContext.js'
import {
  projectNodeContext,
  type NodeContextProjectionReceipt,
} from '../src/agent/nodeContextProjection.js'
import type { CanvasDocument, CanvasNode } from '../src/canvas/model.js'
import type { NodeContextPolicy } from '../src/plugins/contextContracts.js'
import {
  projectionPluginContracts,
  type ProjectionPluginCapabilitySnapshot,
} from './pluginCapabilities.js'
import { ProtocolError } from './protocol.js'
import type { RunArtifactLookup } from './runArtifactStorage.js'
import type { RunManager } from './runs.js'
import type { RunIntent } from './taskRunProtocol.js'
import {
  MAX_RESOLVED_NODE_ATTACHMENT_ARTIFACT_REFS,
  MAX_RESOLVED_NODE_ATTACHMENT_CONTENT_BYTES,
  MAX_RESOLVED_NODE_ATTACHMENT_PAYLOAD_BYTES,
  MAX_RESOLVED_NODE_ATTACHMENT_TEXT_BYTES,
  type ResolvedArtifactAttachment,
  type ResolvedNodeAttachment,
} from './taskRunTypes.js'

export async function resolveRunIntentAttachments(
  intent: RunIntent,
  document: CanvasDocument,
  runs: Pick<RunManager, 'lookupRunArtifact'>,
  projectDir: string,
  pluginCapabilities: ProjectionPluginCapabilitySnapshot,
): Promise<{
  artifacts: ResolvedArtifactAttachment[]
  nodes: ResolvedNodeAttachment[]
}> {
  type ArtifactAuthority = 'intent' | 'node-attachment' | 'context-edge'
  interface PendingArtifactReference {
    runId: string
    artifactId: string
    authorities: Set<ArtifactAuthority>
  }

  const nodesById = new Map(document.nodes.map((node) => [node.id, node]))
  const references = new Map<string, PendingArtifactReference>()
  const artifacts: ResolvedArtifactAttachment[] = []
  const nodes: ResolvedNodeAttachment[] = []
  const contentBudget = { remaining: MAX_RESOLVED_NODE_ATTACHMENT_CONTENT_BYTES }
  let nodeArtifactRefCount = 0
  const projectionPlugins = projectionPluginContracts(pluginCapabilities)
  const nodeContextPolicies = new Map<string, NodeContextPolicy>(
    projectionPlugins.flatMap((plugin) =>
      plugin.nodeContext ? [[plugin.id, plugin.nodeContext] as const] : []),
  )

  const appendReference = (
    runId: string,
    artifactId: string,
    authority: ArtifactAuthority,
  ) => {
    const key = `${runId}\0${artifactId}`
    const existing = references.get(key)
    if (existing) {
      existing.authorities.add(authority)
      return
    }
    references.set(key, {
      runId,
      artifactId,
      authorities: new Set([authority]),
    })
  }

  for (const attachment of intent.attachments) {
    if (attachment.kind === 'artifact') {
      appendReference(attachment.runId, attachment.artifactId, 'intent')
      continue
    }

    const node = nodesById.get(attachment.nodeId)
    if (!node) {
      throw new ProtocolError(
        `attachment node does not exist at the requested revision: ${attachment.nodeId}`,
        'attachment_not_found',
        404,
      )
    }
    const nodeSnapshot = snapshotExplicitNodeAttachment(
      node,
      contentBudget,
      nodeContextPolicies.get(node.type),
    )
    nodeArtifactRefCount += nodeSnapshot.artifactRefs.length
    if (nodeArtifactRefCount > MAX_RESOLVED_NODE_ATTACHMENT_ARTIFACT_REFS) {
      throw new ProtocolError(
        'explicit node attachments reference too many artifacts',
        'node_attachment_too_large',
        413,
      )
    }
    nodes.push(nodeSnapshot)
    for (const reference of nodeSnapshot.artifactRefs) {
      appendReference(reference.runId, reference.artifactId, 'node-attachment')
    }
  }

  const contextPack = compileTaskContext({
    document,
    taskId: intent.taskId,
    nodeContextPolicies: projectionPlugins.flatMap((plugin) =>
      plugin.nodeContext ? [{ id: plugin.id, nodeContext: plugin.nodeContext }] : []),
  })
  for (const reference of taskContextArtifactRefs(contextPack)) {
    appendReference(reference.runId, reference.artifactId, 'context-edge')
  }

  for (const reference of references.values()) {
    let artifact: RunArtifactLookup | null
    try {
      artifact = await runs.lookupRunArtifact(
        reference.runId,
        reference.artifactId,
        projectDir,
      )
    } catch {
      if (reference.authorities.has('context-edge')) {
        throw new ProtocolError(
          `full context edge references an unavailable artifact: ${reference.artifactId}`,
          'context_artifact_unavailable',
          409,
        )
      }
      if (reference.authorities.has('node-attachment')) {
        throw new ProtocolError(
          `explicit node attachment artifact failed integrity verification: ${reference.artifactId}`,
          'node_attachment_artifact_unavailable',
          409,
        )
      }
      throw new ProtocolError(
        `artifact failed its closed-manifest integrity check: ${reference.artifactId}`,
        'artifact_integrity_error',
        409,
      )
    }
    if (!artifact) {
      if (reference.authorities.has('context-edge')) {
        throw new ProtocolError(
          `full context edge references an unavailable artifact: ${reference.artifactId}`,
          'context_artifact_unavailable',
          409,
        )
      }
      if (reference.authorities.has('node-attachment')) {
        throw new ProtocolError(
          `explicit node attachment references an unavailable artifact: ${reference.artifactId}`,
          'node_attachment_artifact_unavailable',
          409,
        )
      }
      throw new ProtocolError(
        `attachment artifact does not exist or failed verification: ${reference.artifactId}`,
        'attachment_not_found',
        404,
      )
    }
    artifacts.push({
      runId: artifact.runId,
      artifactId: artifact.artifactId,
      projectRelativePath: artifact.projectRelativePath,
      mediaType: artifact.mediaType,
      size: artifact.size,
      contentDigest: artifact.contentDigest,
    })
  }
  return { artifacts, nodes }
}

function snapshotExplicitNodeAttachment(
  node: CanvasNode,
  contentBudget: { remaining: number },
  policy?: NodeContextPolicy,
): ResolvedNodeAttachment {
  const projected = projectNodeContext({
    node,
    contextRole: 'full',
    policy,
  })
  const text = projected.text === null
    ? undefined
    : boundedNodeAttachmentText(projected.text, Math.min(
        contentBudget.remaining,
        MAX_RESOLVED_NODE_ATTACHMENT_TEXT_BYTES,
      ))
  if (text) contentBudget.remaining -= text.bytes

  const payload = projected.payload === null
    ? undefined
    : boundedNodeAttachmentPayload(projected.payload, Math.min(
        contentBudget.remaining,
        MAX_RESOLVED_NODE_ATTACHMENT_PAYLOAD_BYTES,
      ))
  if (payload) contentBudget.remaining -= payload.bytes

  return {
    id: node.id,
    title: node.title,
    type: node.type,
    ...(text?.value === undefined ? {} : { text: text.value }),
    ...(payload?.value === undefined ? {} : { payload: payload.value }),
    artifactRefs: projected.artifactRefs,
    contextProjection: explicitAttachmentProjectionReceipt(
      projected.receipt,
      text?.value,
      payload?.value,
    ),
    truncation: {
      text: text?.truncated ?? false,
      payload: payload?.truncated ?? false,
    },
  }
}

function explicitAttachmentProjectionReceipt(
  receipt: NodeContextProjectionReceipt,
  text: string | undefined,
  payload: Record<string, unknown> | undefined,
): NodeContextProjectionReceipt {
  const includedFields = Object.keys(payload ?? {}).sort((left, right) =>
    left.localeCompare(right))
  const includedChars = text ? [...text].length : 0
  return {
    ...receipt,
    text: {
      ...receipt.text,
      includedChars,
      truncated: receipt.text.truncated || includedChars < receipt.text.includedChars,
    },
    payload: {
      ...receipt.payload,
      includedFields,
      omittedFields: Math.max(0, receipt.payload.sourceFields - includedFields.length),
    },
  }
}

function boundedNodeAttachmentText(
  value: string,
  maxBytes: number,
): { value?: string; bytes: number; truncated: boolean } {
  if (maxBytes < 2) return { bytes: 0, truncated: true }
  const serialized = JSON.stringify(value)
  const serializedBytes = Buffer.byteLength(serialized)
  if (serializedBytes <= maxBytes) {
    return { value, bytes: serializedBytes, truncated: false }
  }

  const chunks: string[] = []
  let bytes = 2
  for (const character of value) {
    const encoded = JSON.stringify(character).slice(1, -1)
    const characterBytes = Buffer.byteLength(encoded)
    if (bytes + characterBytes > maxBytes) break
    chunks.push(character)
    bytes += characterBytes
  }
  return { value: chunks.join(''), bytes, truncated: true }
}

function boundedNodeAttachmentPayload(
  value: Record<string, unknown>,
  maxBytes: number,
): { value?: Record<string, unknown>; bytes: number; truncated: boolean } {
  if (maxBytes < 2) return { bytes: 0, truncated: true }
  const serialized = JSON.stringify(value)
  const serializedBytes = Buffer.byteLength(serialized)
  if (serializedBytes <= maxBytes) {
    return { value: structuredClone(value), bytes: serializedBytes, truncated: false }
  }

  const selected: Record<string, unknown> = {}
  let bytes = 2
  let selectedCount = 0
  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
    const propertyBytes = Buffer.byteLength(JSON.stringify(key))
      + 1
      + Buffer.byteLength(JSON.stringify(value[key]))
      + (selectedCount > 0 ? 1 : 0)
    if (bytes + propertyBytes > maxBytes) continue
    selected[key] = structuredClone(value[key])
    bytes += propertyBytes
    selectedCount += 1
  }
  return { value: selected, bytes, truncated: true }
}
