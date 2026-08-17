import {
  MAX_SUGGESTED_ACTION_ID_LENGTH,
  MAX_SUGGESTED_ACTION_LABEL_LENGTH,
  MAX_SUGGESTED_ACTION_PROMPT_LENGTH,
  MAX_SUGGESTED_ACTIONS,
  type SuggestedAction,
} from './suggestedActions.js'
import {
  inspectGraphProposal,
  type GraphProposal,
} from './graphProposal.js'

export type { SuggestedAction } from './suggestedActions.js'

export const RUN_OUTCOME_SCHEMA_VERSION = 2
export const MAX_RUN_OUTPUT_HINTS = 32
export const MAX_RUN_TASK_PROPOSALS = 12
export const MAX_RUN_OUTPUT_KEY_LENGTH = 80
export const MAX_RUN_OUTPUT_PATH_LENGTH = 4_096
export const MAX_RUN_OUTPUT_PLUGIN_ID_LENGTH = 160
export const MAX_RUN_OUTPUT_TITLE_LENGTH = 240
export const MAX_RUN_OUTPUT_PARENTS = 8
export const MAX_RUN_TASK_PROPOSAL_DEPENDENCIES = 8
export const MAX_RUN_TASK_PROPOSAL_INPUTS = 32
export const MAX_RUN_TASK_PROPOSAL_TITLE_LENGTH = 240
export const MAX_RUN_TASK_PROPOSAL_PROMPT_LENGTH = 10_000

export type RunOutputRole = 'primary' | 'supporting' | 'auxiliary'

/**
 * A bounded Agent-authored presentation hint for one artifact.
 *
 * `key` and `derivedFrom` are outcome-local semantic keys, never canvas entity
 * ids. The daemon must intersect `path` and `pluginId` with its authoritative
 * manifest and plugin contract before materialization.
 */
export interface RunOutputHint {
  key: string
  /** Path relative to this run's authoritative `files/` directory. */
  path: string
  pluginId: string
  role: RunOutputRole
  title?: string
  derivedFrom: string[]
}

/**
 * A possible follow-up task, not a task entity or an executable command.
 * Entity ids and placement are assigned by trusted canvas code later.
 */
export interface RunTaskProposal {
  key: string
  title: string
  prompt: string
  /** Output keys from this outcome that provide task input. */
  inputOutputKeys: string[]
  /** Other proposal keys from this outcome, forming a bounded DAG. */
  dependsOn: string[]
}

/**
 * The complete Agent-writable result envelope.
 *
 * Exact-property validation deliberately excludes run/task/node/collection
 * ids, coordinates, payloads, arbitrary edges, and command fields.
 */
export interface RunOutcome {
  schemaVersion: 2
  suggestedActions: SuggestedAction[]
  outputs: RunOutputHint[]
  taskProposals: RunTaskProposal[]
  graphProposal?: GraphProposal
}

export type RunOutcomeInspection =
  | { status: 'valid'; outcome: RunOutcome }
  | { status: 'unsupported' }
  | { status: 'invalid'; reason: string }

/** Browser-safe POSIX path relative to a run's `files/` directory. */
export function isSafeRunRelativeArtifactPath(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_RUN_OUTPUT_PATH_LENGTH
    || value.startsWith('/')
    || value.endsWith('/')
    || value.includes('\\')
    || value.includes('\0')
    || value.includes('//')
  ) return false

  const segments = value.split('/')
  return segments.every((segment) =>
    segment.length > 0
    && segment !== '.'
    && segment !== '..'
    && segment.toLowerCase() !== '.ggai')
}

export function inspectRunOutcome(value: unknown): RunOutcomeInspection {
  if (!isRecord(value)) return invalid('outcome must be an object')
  if (!Object.prototype.hasOwnProperty.call(value, 'schemaVersion')
    || !Number.isSafeInteger(value.schemaVersion)) {
    return invalid('schemaVersion must be an integer')
  }
  if (value.schemaVersion !== RUN_OUTCOME_SCHEMA_VERSION) return { status: 'unsupported' }
  if (!isExactRecord(value, [
    'schemaVersion',
    'suggestedActions',
    'outputs',
    'taskProposals',
    ...(value.graphProposal === undefined ? [] : ['graphProposal']),
  ])) return invalid('outcome has unsupported properties')

  const suggestedActions = inspectSuggestedActions(value.suggestedActions)
  if (!suggestedActions) return invalid('suggestedActions is invalid')
  if (!Array.isArray(value.outputs) || value.outputs.length > MAX_RUN_OUTPUT_HINTS) {
    return invalid('outputs exceeds the supported bound')
  }
  if (!Array.isArray(value.taskProposals)
    || value.taskProposals.length > MAX_RUN_TASK_PROPOSALS) {
    return invalid('taskProposals exceeds the supported bound')
  }

  const outputs: RunOutputHint[] = []
  const outputKeys = new Set<string>()
  for (const [index, candidate] of value.outputs.entries()) {
    const inspected = inspectOutputHint(candidate, index)
    if (inspected.status === 'invalid') return inspected
    if (outputKeys.has(inspected.output.key)) return invalid(`outputs[${index}].key is duplicated`)
    outputKeys.add(inspected.output.key)
    outputs.push(inspected.output)
  }
  const outputGraphError = validateDependencyGraph(
    outputs.map((output) => ({ key: output.key, dependencies: output.derivedFrom })),
    'outputs.derivedFrom',
  )
  if (outputGraphError) return invalid(outputGraphError)

  const taskProposals: RunTaskProposal[] = []
  const proposalKeys = new Set<string>()
  for (const [index, candidate] of value.taskProposals.entries()) {
    const inspected = inspectTaskProposal(candidate, index)
    if (inspected.status === 'invalid') return inspected
    if (proposalKeys.has(inspected.proposal.key)) {
      return invalid(`taskProposals[${index}].key is duplicated`)
    }
    proposalKeys.add(inspected.proposal.key)
    taskProposals.push(inspected.proposal)
  }
  if (taskProposals.some((proposal) =>
    proposal.inputOutputKeys.some((key) => !outputKeys.has(key)))) {
    return invalid('taskProposals.inputOutputKeys references a missing output key')
  }
  const proposalGraphError = validateDependencyGraph(
    taskProposals.map((proposal) => ({
      key: proposal.key,
      dependencies: proposal.dependsOn,
    })),
    'taskProposals.dependsOn',
  )
  if (proposalGraphError) return invalid(proposalGraphError)

  const graphInspection = value.graphProposal === undefined
    ? null
    : inspectGraphProposal(value.graphProposal)
  if (graphInspection?.status === 'invalid') return invalid(graphInspection.reason)

  return {
    status: 'valid',
    outcome: {
      schemaVersion: RUN_OUTCOME_SCHEMA_VERSION,
      suggestedActions,
      outputs,
      taskProposals,
      ...(graphInspection?.status === 'valid'
        ? { graphProposal: graphInspection.proposal }
        : {}),
    },
  }
}

function inspectSuggestedActions(value: unknown): SuggestedAction[] | null {
  if (!Array.isArray(value) || value.length > MAX_SUGGESTED_ACTIONS) return null
  const ids = new Set<string>()
  const contents = new Set<string>()
  const actions: SuggestedAction[] = []
  for (const candidate of value) {
    if (!isExactRecord(candidate, ['id', 'label', 'prompt'])
      || !isStableKey(candidate.id, MAX_SUGGESTED_ACTION_ID_LENGTH)
      || !isDisplayString(candidate.label, MAX_SUGGESTED_ACTION_LABEL_LENGTH)
      || !isDisplayString(candidate.prompt, MAX_SUGGESTED_ACTION_PROMPT_LENGTH)) return null
    const contentKey = JSON.stringify([candidate.label, candidate.prompt])
    if (ids.has(candidate.id) || contents.has(contentKey)) return null
    ids.add(candidate.id)
    contents.add(contentKey)
    actions.push({ id: candidate.id, label: candidate.label, prompt: candidate.prompt })
  }
  return actions
}

function inspectOutputHint(
  value: unknown,
  index: number,
): { status: 'valid'; output: RunOutputHint } | { status: 'invalid'; reason: string } {
  const label = `outputs[${index}]`
  if (!isRecord(value)) return invalid(`${label} must be an object`)
  if (!hasOnlyKeys(value, ['key', 'path', 'pluginId', 'role', 'title', 'derivedFrom'])) {
    return invalid(`${label} has unsupported properties`)
  }
  if (!isStableKey(value.key, MAX_RUN_OUTPUT_KEY_LENGTH)) {
    return invalid(`${label}.key is invalid`)
  }
  if (!isSafeRunRelativeArtifactPath(value.path)) return invalid(`${label}.path is unsafe`)
  if (!isPluginId(value.pluginId)) return invalid(`${label}.pluginId is invalid`)
  if (!isOutputRole(value.role)) return invalid(`${label}.role is invalid`)
  if (value.title !== undefined && !isDisplayString(value.title, MAX_RUN_OUTPUT_TITLE_LENGTH)) {
    return invalid(`${label}.title is invalid`)
  }
  if (value.derivedFrom !== undefined && (
    !Array.isArray(value.derivedFrom)
    || value.derivedFrom.length > MAX_RUN_OUTPUT_PARENTS
    || !value.derivedFrom.every((key) => isStableKey(key, MAX_RUN_OUTPUT_KEY_LENGTH))
    || new Set(value.derivedFrom).size !== value.derivedFrom.length
  )) return invalid(`${label}.derivedFrom is invalid`)

  return {
    status: 'valid',
    output: {
      key: value.key,
      path: value.path,
      pluginId: value.pluginId,
      role: value.role,
      ...(typeof value.title === 'string' ? { title: value.title } : {}),
      derivedFrom: Array.isArray(value.derivedFrom) ? [...value.derivedFrom] as string[] : [],
    },
  }
}

function inspectTaskProposal(
  value: unknown,
  index: number,
): { status: 'valid'; proposal: RunTaskProposal } | { status: 'invalid'; reason: string } {
  const label = `taskProposals[${index}]`
  if (!isRecord(value)) return invalid(`${label} must be an object`)
  if (!hasOnlyKeys(value, ['key', 'title', 'prompt', 'inputOutputKeys', 'dependsOn'])
    || !hasRequiredKeys(value, ['key', 'title', 'prompt', 'inputOutputKeys'])) {
    return invalid(`${label} has unsupported properties`)
  }
  if (!isStableKey(value.key, MAX_RUN_OUTPUT_KEY_LENGTH)) {
    return invalid(`${label}.key is invalid`)
  }
  if (!isDisplayString(value.title, MAX_RUN_TASK_PROPOSAL_TITLE_LENGTH)) {
    return invalid(`${label}.title is invalid`)
  }
  if (!isDisplayString(value.prompt, MAX_RUN_TASK_PROPOSAL_PROMPT_LENGTH)) {
    return invalid(`${label}.prompt is invalid`)
  }
  if (!Array.isArray(value.inputOutputKeys)
    || value.inputOutputKeys.length > MAX_RUN_TASK_PROPOSAL_INPUTS
    || !value.inputOutputKeys.every((key) => isStableKey(key, MAX_RUN_OUTPUT_KEY_LENGTH))
    || new Set(value.inputOutputKeys).size !== value.inputOutputKeys.length
  ) return invalid(`${label}.inputOutputKeys is invalid`)
  if (value.dependsOn !== undefined && (
    !Array.isArray(value.dependsOn)
    || value.dependsOn.length > MAX_RUN_TASK_PROPOSAL_DEPENDENCIES
    || !value.dependsOn.every((key) => isStableKey(key, MAX_RUN_OUTPUT_KEY_LENGTH))
    || new Set(value.dependsOn).size !== value.dependsOn.length
  )) return invalid(`${label}.dependsOn is invalid`)

  return {
    status: 'valid',
    proposal: {
      key: value.key,
      title: value.title,
      prompt: value.prompt,
      inputOutputKeys: [...value.inputOutputKeys] as string[],
      dependsOn: Array.isArray(value.dependsOn) ? [...value.dependsOn] as string[] : [],
    },
  }
}

function validateDependencyGraph(
  entries: readonly { key: string; dependencies: readonly string[] }[],
  label: string,
): string | null {
  const dependenciesByKey = new Map(entries.map((entry) => [entry.key, entry.dependencies]))
  for (const entry of entries) {
    for (const dependency of entry.dependencies) {
      if (!dependenciesByKey.has(dependency)) return `${label} references a missing key`
      if (dependency === entry.key) return `${label} contains a self dependency`
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return true
    if (visited.has(key)) return false
    visiting.add(key)
    for (const dependency of dependenciesByKey.get(key) ?? []) {
      if (visit(dependency)) return true
    }
    visiting.delete(key)
    visited.add(key)
    return false
  }
  return entries.some((entry) => visit(entry.key)) ? `${label} contains a cycle` : null
}

function isStableKey(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
}

function isPluginId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_RUN_OUTPUT_PLUGIN_ID_LENGTH
    && /^@?[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)
    && !value.includes('..')
    && !value.includes('//')
}

function isOutputRole(value: unknown): value is RunOutputRole {
  return value === 'primary' || value === 'supporting' || value === 'auxiliary'
}

function isDisplayString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value === value.trim()
    && !containsAsciiControl(value)
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function invalid(reason: string): { status: 'invalid'; reason: string } {
  return { status: 'invalid', reason }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExactRecord(value: unknown, expectedKeys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value)
    && Object.keys(value).length === expectedKeys.length
    && expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key))
}

function hasRequiredKeys(value: Record<string, unknown>, requiredKeys: readonly string[]): boolean {
  return requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}
