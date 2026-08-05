import type { CanvasCommandV2 } from '../src/canvas-v2/commands.js'
import {
  collectCanvasV2ValidationIssues,
  emptyCanvasDocumentV2,
  parseEntityKeyV2,
  type CanvasCollectionV2,
  type CanvasEntityRef,
  type CanvasTaskV2,
} from '../src/canvas-v2/model.js'
import { parseCanvasBranch, ProtocolError } from './protocol.js'

export const MAX_CANVAS_COMMAND_ENTITIES_V2 = 500
export const MAX_ACCEPTED_TASK_PROPOSALS_V2 = 12
export const MAX_PROPOSAL_KEY_LENGTH_V2 = 80
export const MAX_PROPOSAL_EDIT_TITLE_LENGTH_V2 = 240
export const MAX_PROPOSAL_EDIT_PROMPT_LENGTH_V2 = 10_000

type TrustedPlanCommandV2 = Extract<CanvasCommandV2, {
  type: 'MaterializeProjectionPlan' | 'AcceptTaskProposals' | 'DismissPlan'
}>

export type OrdinaryCanvasCommandV2 = Exclude<CanvasCommandV2, TrustedPlanCommandV2>

export interface TaskProposalEditWireV2 {
  title?: string
  prompt?: string
}

/**
 * Browser-writable command wire shape.
 *
 * Plan operations contain only an opaque plan id. The daemon resolves and
 * validates the trusted plan before constructing an internal CanvasCommandV2.
 */
export type CanvasCommandWireV2 =
  | OrdinaryCanvasCommandV2
  | { type: 'MaterializeProjectionPlan'; planId: string }
  | {
      type: 'AcceptTaskProposals'
      planId: string
      proposalKeys: string[]
      edits?: Record<string, TaskProposalEditWireV2>
    }
  | { type: 'DismissPlan'; planId: string }

export interface CanvasCommandRequestWireV2 {
  branch: string
  baseRevision: number
  mutationId: string
  command: CanvasCommandWireV2
}

/** Strict parser for the JSON body of POST /canvas/commands. */
export function parseCanvasCommandRequestV2(value: unknown): CanvasCommandRequestWireV2 {
  if (!isExactRecord(value, ['branch', 'baseRevision', 'mutationId', 'command'])) {
    throw new ProtocolError('canvas command request has an invalid envelope')
  }
  const branch = parseCanvasBranch(value.branch)
  if (!Number.isSafeInteger(value.baseRevision) || (value.baseRevision as number) < 0) {
    throw new ProtocolError('baseRevision must be a non-negative safe integer')
  }
  const mutationId = parseIdentifier(value.mutationId, 'mutationId')
  return {
    branch,
    baseRevision: value.baseRevision as number,
    mutationId,
    command: parseCanvasCommandWireV2(value.command),
  }
}

export function parseCanvasCommandWireV2(value: unknown): CanvasCommandWireV2 {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new ProtocolError('command must be an object with a type')
  }
  switch (value.type) {
    case 'MaterializeProjectionPlan':
      assertCommandKeys(value, ['type', 'planId'], ['type', 'planId'])
      return { type: value.type, planId: parsePlanId(value.planId) }
    case 'AcceptTaskProposals':
      return parseAcceptTaskProposals(value)
    case 'DismissPlan':
      assertCommandKeys(value, ['type', 'planId'], ['type', 'planId'])
      return { type: value.type, planId: parsePlanId(value.planId) }
    case 'CreateTask':
      assertCommandKeys(value, ['type', 'task'], ['type', 'task'])
      return { type: value.type, task: parseUserTask(value.task) }
    case 'UpdateTaskGoal':
      assertCommandKeys(value, ['type', 'taskId', 'goal'], ['type', 'taskId', 'goal'])
      return {
        type: value.type,
        taskId: parseIdentifier(value.taskId, 'command.taskId'),
        goal: parseString(value.goal, 'command.goal', 250_000, true),
      }
    case 'MoveEntities':
      return parseMoveEntities(value)
    case 'CreateCollectionFromSelection':
      assertCommandKeys(
        value,
        ['type', 'collection', 'members'],
        ['type', 'collection', 'members'],
      )
      return {
        type: value.type,
        collection: parseCollection(value.collection),
        members: parseEntityRefs(value.members, 'command.members', true),
      }
    case 'AssignToCollection':
      assertCommandKeys(
        value,
        ['type', 'collectionId', 'members'],
        ['type', 'collectionId', 'members'],
      )
      return {
        type: value.type,
        collectionId: parseIdentifier(value.collectionId, 'command.collectionId'),
        members: parseEntityRefs(value.members, 'command.members', true),
      }
    case 'DissolveCollection':
      assertCommandKeys(value, ['type', 'collectionId'], ['type', 'collectionId'])
      return {
        type: value.type,
        collectionId: parseIdentifier(value.collectionId, 'command.collectionId'),
      }
    case 'DeleteTask':
      assertCommandKeys(value, ['type', 'taskId'], ['type', 'taskId'])
      return {
        type: value.type,
        taskId: parseIdentifier(value.taskId, 'command.taskId'),
      }
    case 'DeleteCollection':
      assertCommandKeys(value, ['type', 'collectionId'], ['type', 'collectionId'])
      return {
        type: value.type,
        collectionId: parseIdentifier(value.collectionId, 'command.collectionId'),
      }
    case 'DuplicateTaskAsDraft':
      return parseDuplicateTask(value)
    default:
      throw new ProtocolError(`unsupported canvas command type: ${value.type}`)
  }
}

function parseAcceptTaskProposals(
  value: Record<string, unknown>,
): Extract<CanvasCommandWireV2, { type: 'AcceptTaskProposals' }> {
  assertCommandKeys(
    value,
    ['type', 'planId', 'proposalKeys', 'edits'],
    ['type', 'planId', 'proposalKeys'],
  )
  const planId = parsePlanId(value.planId)
  const proposalKeys = parseProposalKeys(value.proposalKeys)
  const edits = value.edits === undefined
    ? undefined
    : parseProposalEdits(value.edits, new Set(proposalKeys))
  return {
    type: 'AcceptTaskProposals',
    planId,
    proposalKeys,
    ...(edits ? { edits } : {}),
  }
}

function parseMoveEntities(
  value: Record<string, unknown>,
): Extract<OrdinaryCanvasCommandV2, { type: 'MoveEntities' }> {
  assertCommandKeys(
    value,
    ['type', 'entities', 'collectionIds', 'dx', 'dy'],
    ['type', 'entities', 'dx', 'dy'],
  )
  const collectionIds = value.collectionIds === undefined
    ? undefined
    : parseIdentifierArray(value.collectionIds, 'command.collectionIds', false)
  return {
    type: 'MoveEntities',
    entities: parseEntityRefs(value.entities, 'command.entities', false),
    ...(collectionIds ? { collectionIds } : {}),
    dx: parseFinite(value.dx, 'command.dx'),
    dy: parseFinite(value.dy, 'command.dy'),
  }
}

function parseDuplicateTask(
  value: Record<string, unknown>,
): Extract<OrdinaryCanvasCommandV2, { type: 'DuplicateTaskAsDraft' }> {
  assertCommandKeys(
    value,
    ['type', 'sourceTaskId', 'newTaskId', 'offset', 'title'],
    ['type', 'sourceTaskId', 'newTaskId', 'offset'],
  )
  if (!isExactRecord(value.offset, ['x', 'y'])) {
    throw new ProtocolError('command.offset has an invalid shape')
  }
  const title = value.title === undefined
    ? undefined
    : parseString(value.title, 'command.title', 1_000, false)
  return {
    type: 'DuplicateTaskAsDraft',
    sourceTaskId: parseIdentifier(value.sourceTaskId, 'command.sourceTaskId'),
    newTaskId: parseIdentifier(value.newTaskId, 'command.newTaskId'),
    offset: {
      x: parseFinite(value.offset.x, 'command.offset.x'),
      y: parseFinite(value.offset.y, 'command.offset.y'),
    },
    ...(title ? { title } : {}),
  }
}

function parseUserTask(value: unknown): CanvasTaskV2 {
  if (!isRecord(value)
    || !isExactRecord(value.origin, ['kind'])
    || value.origin.kind !== 'user') {
    throw new ProtocolError('CreateTask only accepts a user-origin task')
  }
  const document = emptyCanvasDocumentV2()
  document.tasks = [structuredClone(value) as unknown as CanvasTaskV2]
  if (typeof value.collectionId === 'string') {
    document.collections = [{
      id: value.collectionId,
      title: 'Validation placeholder',
      anchor: { x: 0, y: 0 },
    }]
  }
  assertModelFragment(document, 'command.task')
  return structuredClone(value) as unknown as CanvasTaskV2
}

function parseCollection(value: unknown): CanvasCollectionV2 {
  const document = emptyCanvasDocumentV2()
  document.collections = [structuredClone(value) as CanvasCollectionV2]
  assertModelFragment(document, 'command.collection')
  return structuredClone(value) as CanvasCollectionV2
}

function assertModelFragment(document: ReturnType<typeof emptyCanvasDocumentV2>, label: string): void {
  const issues = collectCanvasV2ValidationIssues(document)
  if (issues.length === 0) return
  const detail = issues.slice(0, 3).map((issue) => `${issue.path}: ${issue.message}`).join('; ')
  throw new ProtocolError(`${label} is invalid: ${detail}`)
}

function parseEntityRefs(value: unknown, label: string, requireNonEmpty: boolean): CanvasEntityRef[] {
  if (!Array.isArray(value)
    || value.length > MAX_CANVAS_COMMAND_ENTITIES_V2
    || (requireNonEmpty && value.length === 0)) {
    throw new ProtocolError(`${label} must be a bounded${requireNonEmpty ? ' non-empty' : ''} array`)
  }
  const seen = new Set<string>()
  return value.map((candidate, index) => {
    if (!isExactRecord(candidate, ['kind', 'id'])
      || (candidate.kind !== 'node' && candidate.kind !== 'task')
      || typeof candidate.id !== 'string') {
      throw new ProtocolError(`${label}[${index}] is invalid`)
    }
    const parsed = parseEntityKeyV2(`${candidate.kind}:${candidate.id}`)
    if (!parsed) throw new ProtocolError(`${label}[${index}] is invalid`)
    const key = `${parsed.kind}:${parsed.id}`
    if (seen.has(key)) throw new ProtocolError(`${label} contains a duplicate entity`)
    seen.add(key)
    return parsed
  })
}

function parseIdentifierArray(value: unknown, label: string, requireNonEmpty: boolean): string[] {
  if (!Array.isArray(value)
    || value.length > MAX_CANVAS_COMMAND_ENTITIES_V2
    || (requireNonEmpty && value.length === 0)) {
    throw new ProtocolError(`${label} must be a bounded${requireNonEmpty ? ' non-empty' : ''} array`)
  }
  const parsed = value.map((candidate, index) =>
    parseIdentifier(candidate, `${label}[${index}]`))
  if (new Set(parsed).size !== parsed.length) {
    throw new ProtocolError(`${label} contains duplicate ids`)
  }
  return parsed
}

function parseProposalKeys(value: unknown): string[] {
  if (!Array.isArray(value)
    || value.length === 0
    || value.length > MAX_ACCEPTED_TASK_PROPOSALS_V2) {
    throw new ProtocolError('command.proposalKeys must contain 1 to 12 keys')
  }
  const keys = value.map((candidate, index) =>
    parseStableKey(candidate, `command.proposalKeys[${index}]`))
  if (new Set(keys).size !== keys.length) {
    throw new ProtocolError('command.proposalKeys contains duplicate keys')
  }
  return keys
}

function parseProposalEdits(
  value: unknown,
  acceptedKeys: ReadonlySet<string>,
): Record<string, TaskProposalEditWireV2> {
  if (!isRecord(value)) throw new ProtocolError('command.edits must be an object')
  const entries = Object.entries(value)
  if (entries.length > MAX_ACCEPTED_TASK_PROPOSALS_V2) {
    throw new ProtocolError('command.edits has too many entries')
  }
  const edits: Record<string, TaskProposalEditWireV2> = {}
  for (const [rawKey, candidate] of entries) {
    const key = parseStableKey(rawKey, 'command.edits key')
    if (!acceptedKeys.has(key)) {
      throw new ProtocolError(`command.edits.${key} is not present in proposalKeys`)
    }
    if (!isRecord(candidate)) throw new ProtocolError(`command.edits.${key} must be an object`)
    assertCommandKeys(candidate, ['title', 'prompt'], [])
    if (Object.keys(candidate).length === 0) {
      throw new ProtocolError(`command.edits.${key} must change title or prompt`)
    }
    const title = candidate.title === undefined
      ? undefined
      : parseDisplayString(
        candidate.title,
        `command.edits.${key}.title`,
        MAX_PROPOSAL_EDIT_TITLE_LENGTH_V2,
      )
    const prompt = candidate.prompt === undefined
      ? undefined
      : parseDisplayString(
        candidate.prompt,
        `command.edits.${key}.prompt`,
        MAX_PROPOSAL_EDIT_PROMPT_LENGTH_V2,
      )
    if (title === undefined && prompt === undefined) {
      throw new ProtocolError(`command.edits.${key} must change title or prompt`)
    }
    edits[key] = {
      ...(title ? { title } : {}),
      ...(prompt ? { prompt } : {}),
    }
  }
  return edits
}

function parsePlanId(value: unknown): string {
  if (typeof value !== 'string' || !/^plan_[0-9a-f]{64}$/u.test(value)) {
    throw new ProtocolError('command.planId is invalid')
  }
  return value
}

function parseIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 160
    || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(value)
    || value.includes('..')) throw new ProtocolError(`${label} is invalid`)
  return value
}

function parseStableKey(value: unknown, label: string): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_PROPOSAL_KEY_LENGTH_V2
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    throw new ProtocolError(`${label} is invalid`)
  }
  return value
}

function parseString(
  value: unknown,
  label: string,
  maxLength: number,
  allowEmpty: boolean,
): string {
  if (typeof value !== 'string'
    || value.length > maxLength
    || (!allowEmpty && value.length === 0)) throw new ProtocolError(`${label} is invalid`)
  return value
}

function parseDisplayString(value: unknown, label: string, maxLength: number): string {
  const result = parseString(value, label, maxLength, false)
  if (result !== result.trim()) throw new ProtocolError(`${label} must be trimmed`)
  for (let index = 0; index < result.length; index += 1) {
    const code = result.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) throw new ProtocolError(`${label} has control characters`)
  }
  return result
}

function parseFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProtocolError(`${label} must be finite`)
  }
  return value
}

function assertCommandKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))
    || required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new ProtocolError(`${String(value.type ?? 'command')} has unsupported or missing fields`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}
