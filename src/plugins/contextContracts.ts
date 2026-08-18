/**
 * Serializable Node-to-Agent context policies shared by browser plugins, the
 * Canvas context compiler, and the daemon. Keep this module data-only: a
 * policy may reduce persisted Node data, but it can never grant file access or
 * reinterpret an Edge contextRole.
 */

export const NODE_CONTEXT_POLICY_SCHEMA_VERSION = 1 as const
export const MAX_NODE_CONTEXT_SUMMARY_TEXT_CHARS = 4_000
export const MAX_NODE_CONTEXT_FULL_TEXT_CHARS = 1_000_000
export const MAX_NODE_CONTEXT_PAYLOAD_FIELDS = 64

export interface NodeContextPolicy {
  schemaVersion: typeof NODE_CONTEXT_POLICY_SCHEMA_VERSION
  summary: {
    /** 0 omits text. The compiler truncates by Unicode code points. */
    textMaxChars: number
    /** Only these top-level JSON payload fields are exposed. */
    payloadFields: string[]
  }
  full: {
    /** 0 omits text. This cannot exceed the Canvas Node text bound. */
    textMaxChars: number
    /** `all` preserves compatibility; an array is an explicit allow-list. */
    payloadFields: 'all' | string[]
    /** Artifact identities remain subject to Edge role and daemon manifest checks. */
    artifactRefs: 'all' | 'none'
  }
}

export interface NodeContextPolicyRegistration {
  id: string
  nodeContext: NodeContextPolicy
}

export type BuiltinNodeContextPluginId =
  | 'pdf'
  | 'web'
  | 'image'
  | 'text'
  | 'table'
  | 'formula'
  | 'code'
  | 'graphic'
  | 'smart'
  | 'file'

export type NodeContextPolicyInspection =
  | { status: 'valid'; policy: NodeContextPolicy }
  | { status: 'invalid'; reason: string }

/**
 * Compatibility policy for plugins registered before this contract existed.
 * New plugins should declare a narrower policy; old Runs remain reproducible.
 */
export const LEGACY_NODE_CONTEXT_POLICY: Readonly<NodeContextPolicy> = {
  schemaVersion: NODE_CONTEXT_POLICY_SCHEMA_VERSION,
  summary: { textMaxChars: 0, payloadFields: [] },
  full: {
    textMaxChars: MAX_NODE_CONTEXT_FULL_TEXT_CHARS,
    payloadFields: 'all',
    artifactRefs: 'all',
  },
}

export function inspectNodeContextPolicy(value: unknown): NodeContextPolicyInspection {
  try {
    return { status: 'valid', policy: parseNodeContextPolicy(value) }
  } catch (error) {
    return {
      status: 'invalid',
      reason: error instanceof Error ? error.message : 'node context policy is invalid',
    }
  }
}

export function defineNodeContextPolicy(value: unknown): NodeContextPolicy {
  const inspection = inspectNodeContextPolicy(value)
  if (inspection.status !== 'valid') {
    throw new TypeError(`node context policy is invalid: ${inspection.reason}`)
  }
  return inspection.policy
}

export function canonicalNodeContextPolicy(
  value: NodeContextPolicy | undefined,
): NodeContextPolicy {
  if (value === undefined) return structuredClone(LEGACY_NODE_CONTEXT_POLICY)
  return defineNodeContextPolicy(value)
}

function parseNodeContextPolicy(value: unknown): NodeContextPolicy {
  if (!isExactRecord(value, ['schemaVersion', 'summary', 'full'])
    || value.schemaVersion !== NODE_CONTEXT_POLICY_SCHEMA_VERSION) {
    throw new TypeError('policy envelope is invalid')
  }
  if (!isExactRecord(value.summary, ['textMaxChars', 'payloadFields'])) {
    throw new TypeError('summary policy is invalid')
  }
  if (!isExactRecord(value.full, ['textMaxChars', 'payloadFields', 'artifactRefs'])) {
    throw new TypeError('full policy is invalid')
  }
  const summaryTextMaxChars = boundedInteger(
    value.summary.textMaxChars,
    MAX_NODE_CONTEXT_SUMMARY_TEXT_CHARS,
    'summary.textMaxChars',
  )
  const fullTextMaxChars = boundedInteger(
    value.full.textMaxChars,
    MAX_NODE_CONTEXT_FULL_TEXT_CHARS,
    'full.textMaxChars',
  )
  const summaryPayloadFields = parsePayloadFields(
    value.summary.payloadFields,
    'summary.payloadFields',
  )
  const fullPayloadFields = value.full.payloadFields === 'all'
    ? 'all' as const
    : parsePayloadFields(value.full.payloadFields, 'full.payloadFields')
  if (value.full.artifactRefs !== 'all' && value.full.artifactRefs !== 'none') {
    throw new TypeError('full.artifactRefs is invalid')
  }
  return {
    schemaVersion: NODE_CONTEXT_POLICY_SCHEMA_VERSION,
    summary: {
      textMaxChars: summaryTextMaxChars,
      payloadFields: summaryPayloadFields,
    },
    full: {
      textMaxChars: fullTextMaxChars,
      payloadFields: fullPayloadFields,
      artifactRefs: value.full.artifactRefs,
    },
  }
}

function boundedInteger(value: unknown, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new TypeError(`${label} must be an integer from 0 to ${maximum}`)
  }
  return value as number
}

function parsePayloadFields(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_NODE_CONTEXT_PAYLOAD_FIELDS) {
    throw new TypeError(`${label} is invalid`)
  }
  if (!value.every(isPayloadField) || new Set(value).size !== value.length) {
    throw new TypeError(`${label} contains invalid or duplicate fields`)
  }
  return [...value].sort((left, right) => left.localeCompare(right))
}

function isPayloadField(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 120
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
    && value !== '__proto__'
    && value !== 'constructor'
    && value !== 'prototype'
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function policy(input: Omit<NodeContextPolicy, 'schemaVersion'>): NodeContextPolicy {
  return defineNodeContextPolicy({
    schemaVersion: NODE_CONTEXT_POLICY_SCHEMA_VERSION,
    ...input,
  })
}

/**
 * Daemon-owned semantic projections for built-ins. Presentation-only payload
 * fields are excluded unless they materially affect how content is understood.
 */
export const BUILTIN_NODE_CONTEXT_POLICY_REGISTRY: readonly NodeContextPolicyRegistration[] = [
  {
    id: 'pdf',
    nodeContext: policy({
      summary: { textMaxChars: 0, payloadFields: [] },
      full: { textMaxChars: 16_000, payloadFields: [], artifactRefs: 'all' },
    }),
  },
  {
    id: 'web',
    nodeContext: policy({
      summary: { textMaxChars: 400, payloadFields: ['url'] },
      full: { textMaxChars: 64_000, payloadFields: ['url'], artifactRefs: 'none' },
    }),
  },
  {
    id: 'image',
    nodeContext: policy({
      summary: { textMaxChars: 0, payloadFields: [] },
      full: { textMaxChars: 8_000, payloadFields: [], artifactRefs: 'all' },
    }),
  },
  {
    id: 'text',
    nodeContext: policy({
      summary: { textMaxChars: 800, payloadFields: ['heading'] },
      full: {
        textMaxChars: 250_000,
        payloadFields: ['bold', 'heading', 'italic'],
        artifactRefs: 'all',
      },
    }),
  },
  {
    id: 'table',
    nodeContext: policy({
      summary: { textMaxChars: 400, payloadFields: [] },
      full: {
        textMaxChars: 250_000,
        payloadFields: ['columns', 'content', 'rows'],
        artifactRefs: 'all',
      },
    }),
  },
  {
    id: 'formula',
    nodeContext: policy({
      summary: { textMaxChars: 800, payloadFields: ['latex'] },
      full: { textMaxChars: 64_000, payloadFields: ['latex'], artifactRefs: 'none' },
    }),
  },
  {
    id: 'code',
    nodeContext: policy({
      summary: { textMaxChars: 800, payloadFields: ['language'] },
      full: { textMaxChars: 250_000, payloadFields: ['language'], artifactRefs: 'all' },
    }),
  },
  {
    id: 'graphic',
    nodeContext: policy({
      summary: { textMaxChars: 400, payloadFields: [] },
      full: { textMaxChars: 64_000, payloadFields: ['content'], artifactRefs: 'none' },
    }),
  },
  {
    id: 'smart',
    nodeContext: policy({
      summary: { textMaxChars: 400, payloadFields: [] },
      full: { textMaxChars: 64_000, payloadFields: ['content'], artifactRefs: 'none' },
    }),
  },
  {
    id: 'file',
    nodeContext: policy({
      summary: { textMaxChars: 0, payloadFields: [] },
      full: { textMaxChars: 8_000, payloadFields: [], artifactRefs: 'all' },
    }),
  },
]

export const BUILTIN_NODE_CONTEXT_PLUGIN_IDS: ReadonlySet<string> = new Set(
  BUILTIN_NODE_CONTEXT_POLICY_REGISTRY.map(({ id }) => id),
)

/** Returns a mutable declaration suitable for one browser NodeTypeDefinition. */
export function nodeContextPolicyForBuiltin(id: BuiltinNodeContextPluginId): NodeContextPolicy {
  const registration = BUILTIN_NODE_CONTEXT_POLICY_REGISTRY.find((candidate) => candidate.id === id)
  if (!registration) throw new TypeError(`unknown built-in node context policy: ${id}`)
  return structuredClone(registration.nodeContext)
}
