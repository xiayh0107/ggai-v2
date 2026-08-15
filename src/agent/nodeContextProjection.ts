import type {
  CanvasArtifactRef,
  CanvasEdgeContextRole,
  CanvasNode,
} from '../canvas/model.js'
import {
  canonicalNodeContextPolicy,
  type NodeContextPolicy,
} from '../plugins/contextContracts.js'

export interface NodeContextProjectionReceipt {
  policySource: 'plugin' | 'compatibility'
  text: {
    sourceChars: number
    includedChars: number
    truncated: boolean
  }
  payload: {
    sourceFields: number
    includedFields: string[]
    omittedFields: number
  }
  artifactRefs: {
    source: number
    included: number
    omittedByPolicy: number
    omittedByBudget: number
  }
}

export interface ProjectedNodeContext {
  text: string | null
  payload: Record<string, unknown> | null
  artifactRefs: CanvasArtifactRef[]
  receipt: NodeContextProjectionReceipt
}

export interface ProjectNodeContextInput {
  node: CanvasNode
  contextRole: Exclude<CanvasEdgeContextRole, 'none'>
  policy?: NodeContextPolicy
}

/**
 * Deterministically projects one persisted Node into Agent-readable data.
 * `summary` is always artifact-free; a plugin policy can only remove or bound
 * content and never increase the authority granted by the Edge role.
 */
export function projectNodeContext(input: ProjectNodeContextInput): ProjectedNodeContext {
  const policy = canonicalNodeContextPolicy(input.policy)
  const rolePolicy = input.contextRole === 'summary' ? policy.summary : policy.full
  const projectedText = projectText(input.node.text, rolePolicy.textMaxChars)
  const payloadFields = input.contextRole === 'summary'
    ? policy.summary.payloadFields
    : policy.full.payloadFields
  const projectedPayload = projectPayload(input.node.payload, payloadFields)
  const sourceArtifactRefs = input.node.artifactRefs.length
  const includeArtifacts = input.contextRole === 'full' && policy.full.artifactRefs === 'all'
  const artifactRefs = includeArtifacts ? structuredClone(input.node.artifactRefs) : []

  return {
    text: projectedText.value,
    payload: projectedPayload.value,
    artifactRefs,
    receipt: {
      policySource: input.policy ? 'plugin' : 'compatibility',
      text: projectedText.receipt,
      payload: projectedPayload.receipt,
      artifactRefs: {
        source: sourceArtifactRefs,
        included: artifactRefs.length,
        omittedByPolicy: includeArtifacts ? 0 : sourceArtifactRefs,
        omittedByBudget: 0,
      },
    },
  }
}

export function applyArtifactBudgetToNodeContext(
  projection: ProjectedNodeContext,
  selected: readonly CanvasArtifactRef[],
): ProjectedNodeContext {
  const refs = structuredClone([...selected])
  const omittedByBudget = Math.max(0, projection.artifactRefs.length - refs.length)
  return {
    ...projection,
    artifactRefs: refs,
    receipt: {
      ...projection.receipt,
      artifactRefs: {
        ...projection.receipt.artifactRefs,
        included: refs.length,
        omittedByBudget,
      },
    },
  }
}

function projectText(
  value: string | undefined,
  maxChars: number,
): {
  value: string | null
  receipt: NodeContextProjectionReceipt['text']
} {
  const sourceChars = value ? [...value].length : 0
  if (!value || maxChars === 0) {
    return {
      value: null,
      receipt: {
        sourceChars,
        includedChars: 0,
        truncated: sourceChars > 0,
      },
    }
  }
  if (sourceChars <= maxChars) {
    return {
      value,
      receipt: { sourceChars, includedChars: sourceChars, truncated: false },
    }
  }
  const truncated = [...value].slice(0, maxChars).join('')
  return {
    value: truncated,
    receipt: { sourceChars, includedChars: maxChars, truncated: true },
  }
}

function projectPayload(
  payload: Record<string, unknown> | undefined,
  fields: 'all' | readonly string[],
): {
  value: Record<string, unknown> | null
  receipt: NodeContextProjectionReceipt['payload']
} {
  const sourceFields = payload ? Object.keys(payload).length : 0
  if (!payload || sourceFields === 0) {
    return {
      value: null,
      receipt: { sourceFields, includedFields: [], omittedFields: 0 },
    }
  }
  const includedFields = fields === 'all'
    ? Object.keys(payload).sort((left, right) => left.localeCompare(right))
    : fields.filter((field) => Object.prototype.hasOwnProperty.call(payload, field))
  const projected = Object.fromEntries(
    includedFields.map((field) => [field, structuredClone(payload[field])]),
  )
  return {
    value: includedFields.length > 0 ? projected : null,
    receipt: {
      sourceFields,
      includedFields,
      omittedFields: sourceFields - includedFields.length,
    },
  }
}
