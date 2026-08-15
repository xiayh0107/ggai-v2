import {
  assertCanvasDocument,
  entityKey,
  type CanvasArtifactRef,
  type CanvasDocument,
  type CanvasEdgeContextRole,
  type CanvasEdgeRelation,
  type CanvasEntityRef,
  type CanvasNodeOrigin,
} from './model.js'
import type { SkillAssetRef } from '../skills/contracts.js'

export type CanvasNodeContentState = 'empty' | 'inline' | 'artifact' | 'mixed'

export interface CanvasNodeRelationshipContext {
  edgeId: string
  direction: 'incoming' | 'outgoing'
  peer: CanvasEntityRef
  peerTitle: string
  relation: CanvasEdgeRelation
  contextRole: CanvasEdgeContextRole
  /** Human-readable semantic equivalent of the persisted contextRole. */
  agentVisibility: 'full' | 'summary' | 'hidden'
}

export interface CanvasNodeContext {
  identity: {
    id: string
    type: string
    title: string
  }
  content: {
    state: CanvasNodeContentState
    text: string | null
    payload: Record<string, unknown> | null
    artifactRefs: CanvasArtifactRef[]
  }
  placement: {
    frame: { x: number; y: number; w: number; h: number; z: number }
    task: { id: string; title: string; goal: string } | null
    collection: { id: string; title: string } | null
  }
  provenance: {
    origin: CanvasNodeOrigin
    materialization: {
      planId: string
      runId: string
      taskId: string
      outputKey: string
    } | null
  }
  capabilities: {
    /** Whether workspace bindings for this Node type remain in force. */
    inheritTypeSkills: boolean
    /** Immutable instance-level additions, or the full replacement when inheritance is disabled. */
    skillBindings: SkillAssetRef[]
  }
  relationships: CanvasNodeRelationshipContext[]
}

/**
 * Canonical read model for one Node instance. It deliberately contains no
 * transient selection, Run phase, session, log, or renderer state; consumers
 * join those independent layers explicitly.
 */
export function selectCanvasNodeContext(
  document: CanvasDocument,
  nodeId: string,
): CanvasNodeContext | null {
  assertCanvasDocument(document)
  const node = document.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) return null
  const entities = new Map<string, string>()
  for (const candidate of document.nodes) {
    entities.set(entityKey({ kind: 'node', id: candidate.id }), candidate.title)
  }
  for (const task of document.tasks) {
    entities.set(entityKey({ kind: 'task', id: task.id }), task.title)
  }
  const nodeRef = { kind: 'node' as const, id: node.id }
  const nodeKey = entityKey(nodeRef)
  const relationships = document.edges.flatMap((edge): CanvasNodeRelationshipContext[] => {
    const fromKey = entityKey(edge.from)
    const toKey = entityKey(edge.to)
    if (fromKey !== nodeKey && toKey !== nodeKey) return []
    const direction = toKey === nodeKey ? 'incoming' as const : 'outgoing' as const
    const peer = direction === 'incoming' ? edge.from : edge.to
    return [{
      edgeId: edge.id,
      direction,
      peer: structuredClone(peer),
      peerTitle: entities.get(entityKey(peer)) ?? peer.id,
      relation: edge.relation,
      contextRole: edge.contextRole,
      agentVisibility: edge.contextRole === 'none' ? 'hidden' : edge.contextRole,
    }]
  })
  const task = node.homeTaskId
    ? document.tasks.find((candidate) => candidate.id === node.homeTaskId) ?? null
    : null
  const effectiveCollectionId = node.collectionId ?? task?.collectionId
  const collection = effectiveCollectionId
    ? document.collections.find((candidate) => candidate.id === effectiveCollectionId) ?? null
    : null
  const materialization = document.receipts.flatMap((receipt) => {
    if (receipt.kind !== 'materialization') return []
    const outcome = receipt.outcomes.find((candidate) => candidate.nodeId === node.id)
    return outcome ? [{
      planId: receipt.planId,
      runId: receipt.runId,
      taskId: receipt.taskId,
      outputKey: outcome.outputKey,
    }] : []
  })[0] ?? null
  const hasInline = Boolean(node.text?.trim()) || Object.keys(node.payload ?? {}).length > 0
  const hasArtifacts = node.artifactRefs.length > 0

  return {
    identity: { id: node.id, type: node.type, title: node.title },
    content: {
      state: hasInline && hasArtifacts
        ? 'mixed'
        : hasArtifacts
          ? 'artifact'
          : hasInline
            ? 'inline'
            : 'empty',
      text: node.text ?? null,
      payload: node.payload ? structuredClone(node.payload) : null,
      artifactRefs: structuredClone(node.artifactRefs),
    },
    placement: {
      frame: structuredClone(node.frame),
      task: task ? { id: task.id, title: task.title, goal: task.goal } : null,
      collection: collection ? { id: collection.id, title: collection.title } : null,
    },
    provenance: {
      origin: structuredClone(node.origin),
      materialization,
    },
    capabilities: {
      inheritTypeSkills: node.skillBindings?.inheritType ?? true,
      skillBindings: structuredClone(node.skillBindings?.skills ?? []),
    },
    relationships,
  }
}
