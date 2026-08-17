import type { ArtifactClaimRule } from './artifactContracts.js'
import type { NodeContextPolicy } from './contextContracts.js'
import type { NodeUiDefinition } from './uiContracts.js'

export const NODE_TYPE_DEFINITION_SCHEMA_VERSION = 2 as const

export type NodeTypeIconId =
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
  | 'card'

export type NodeMarkIconId = 'bold' | 'italic' | 'heading-1' | 'heading-2'

export interface NodeMarkDefinition {
  id: string
  title: string
  icon: NodeMarkIconId
  payloadKey: string
  value: boolean | number | string
  exclusiveGroup?: string
}

export interface PortDefinition {
  key: string
  direction: 'input' | 'output'
  schema: string
  cardinality: 'one' | 'many'
  materialization?: 'inline' | 'tray' | 'child-node' | 'canvas-node'
}

export interface NodeTypeDefinition {
  schemaVersion: typeof NODE_TYPE_DEFINITION_SCHEMA_VERSION
  id: string
  revision: number
  label: string
  description: string
  creatable: boolean
  icon: NodeTypeIconId
  defaultWidth: number
  initialPayloadSchema: string
  initialPayload: Record<string, unknown>
  ui: NodeUiDefinition
  instruction: {
    placeholder: string
    actions: string[]
    marks: NodeMarkDefinition[]
  }
  containment: {
    canHaveChildren: boolean
    allowedChildTypes: string[]
    maxDepth: number
  }
  ports: PortDefinition[]
  execution?: {
    capability: string
    policy: string
  }
  exporters: string[]
  agent: {
    constructible: boolean
    writableInitSchema?: string
  }
  artifactClaims: readonly ArtifactClaimRule[]
  nodeContext: NodeContextPolicy
}

export interface NodeTypeSnapshot extends NodeTypeDefinition {
  digest: string
}

export type NodeTypeDefinitionInspection =
  | { status: 'valid'; definition: NodeTypeDefinition }
  | { status: 'invalid'; reason: string }

const TYPE_ID = /^@?[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u
const SCHEMA_ID = /^ggai:\/\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/u
const CAPABILITY_ID = /^[a-z0-9][a-z0-9._-]*$/u
const MAX_PORTS = 128

export function inspectNodeTypeDefinition(value: unknown): NodeTypeDefinitionInspection {
  if (!isRecord(value)) return invalid('definition must be an object')
  const keys = [
    'schemaVersion', 'id', 'revision', 'label', 'description', 'creatable', 'icon',
    'defaultWidth', 'initialPayloadSchema', 'initialPayload', 'ui', 'instruction',
    'containment', 'ports', 'exporters', 'agent', 'artifactClaims', 'nodeContext',
    ...(value.execution === undefined ? [] : ['execution']),
  ].sort()
  if (!hasExactKeys(value, keys)) return invalid('definition has unsupported fields')
  if (value.schemaVersion !== NODE_TYPE_DEFINITION_SCHEMA_VERSION) {
    return invalid(`schemaVersion must be ${NODE_TYPE_DEFINITION_SCHEMA_VERSION}`)
  }
  if (!validTypeId(value.id)) return invalid('id is invalid')
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    return invalid('revision must be a positive safe integer')
  }
  if (!boundedString(value.label, 1, 120)) return invalid('label is invalid')
  if (!boundedString(value.description, 0, 1_000)) return invalid('description is invalid')
  if (typeof value.creatable !== 'boolean') return invalid('creatable must be boolean')
  if (!NODE_TYPE_ICON_IDS.includes(value.icon as NodeTypeIconId)) return invalid('icon is invalid')
  if (!Number.isSafeInteger(value.defaultWidth)
    || (value.defaultWidth as number) < 280
    || (value.defaultWidth as number) > 640) return invalid('defaultWidth is invalid')
  if (!isNodeSchemaId(value.initialPayloadSchema)) return invalid('initialPayloadSchema is invalid')
  if (!isRecord(value.initialPayload)) return invalid('initialPayload must be an object')
  if (!validInstruction(value.instruction)) return invalid('instruction is invalid')
  if (!validContainment(value.containment)) return invalid('containment is invalid')
  if (!Array.isArray(value.ports) || value.ports.length > MAX_PORTS) return invalid('ports are invalid')
  const ports = value.ports.map(inspectPort)
  if (ports.some((port) => port === null)) return invalid('ports contain an invalid definition')
  if (new Set(ports.map((port) => `${port!.direction}:${port!.key}`)).size !== ports.length) {
    return invalid('ports contain duplicate direction/key pairs')
  }
  if (!stringList(value.exporters, 64, 120, CAPABILITY_ID)) return invalid('exporters are invalid')
  if (!validAgent(value.agent)) return invalid('agent policy is invalid')
  if (value.execution !== undefined && !validExecution(value.execution)) {
    return invalid('execution is invalid')
  }

  return {
    status: 'valid',
    definition: structuredClone(value) as unknown as NodeTypeDefinition,
  }
}

export const EMPTY_NODE_PAYLOAD_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'ggai://schema/payload/open',
  type: 'object',
  additionalProperties: true,
})

export const NODE_TYPE_ICON_IDS: readonly NodeTypeIconId[] = Object.freeze([
  'pdf', 'web', 'image', 'text', 'table', 'formula', 'code', 'graphic', 'smart', 'file', 'card',
])

function inspectPort(value: unknown): PortDefinition | null {
  if (!isRecord(value)) return null
  const allowed = ['key', 'direction', 'schema', 'cardinality']
  if (value.materialization !== undefined) allowed.push('materialization')
  if (!hasExactKeys(value, allowed.sort())
    || typeof value.key !== 'string' || !KEY.test(value.key)
    || (value.direction !== 'input' && value.direction !== 'output')
    || !isNodeSchemaId(value.schema)
    || (value.cardinality !== 'one' && value.cardinality !== 'many')
    || (value.materialization !== undefined
      && !['inline', 'tray', 'child-node', 'canvas-node'].includes(String(value.materialization)))) {
    return null
  }
  return structuredClone(value) as unknown as PortDefinition
}

function validInstruction(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['actions', 'marks', 'placeholder'])) return false
  if (!boundedString(value.placeholder, 1, 500)
    || !stringList(value.actions, 6, 80)) return false
  if (!Array.isArray(value.marks) || value.marks.length > 12) return false
  return value.marks.every((mark) => isRecord(mark)
    && hasExactKeys(mark, [
      'id', 'title', 'icon', 'payloadKey', 'value',
      ...(mark.exclusiveGroup === undefined ? [] : ['exclusiveGroup']),
    ].sort())
    && typeof mark.id === 'string' && KEY.test(mark.id)
    && boundedString(mark.title, 1, 80)
    && ['bold', 'italic', 'heading-1', 'heading-2'].includes(String(mark.icon))
    && typeof mark.payloadKey === 'string' && KEY.test(mark.payloadKey)
    && ['boolean', 'number', 'string'].includes(typeof mark.value)
    && (mark.exclusiveGroup === undefined
      || (typeof mark.exclusiveGroup === 'string' && KEY.test(mark.exclusiveGroup))))
}

function validContainment(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['allowedChildTypes', 'canHaveChildren', 'maxDepth'])
    && typeof value.canHaveChildren === 'boolean'
    && Array.isArray(value.allowedChildTypes)
    && value.allowedChildTypes.length <= 128
    && value.allowedChildTypes.every(validTypeId)
    && new Set(value.allowedChildTypes).size === value.allowedChildTypes.length
    && Number.isSafeInteger(value.maxDepth)
    && (value.maxDepth as number) >= 0
    && (value.maxDepth as number) <= 32
    && (value.canHaveChildren || value.allowedChildTypes.length === 0)
}

function validAgent(value: unknown): boolean {
  if (!isRecord(value)) return false
  const keys = ['constructible', ...(value.writableInitSchema === undefined ? [] : ['writableInitSchema'])]
  return hasExactKeys(value, keys.sort())
    && typeof value.constructible === 'boolean'
    && (value.writableInitSchema === undefined || isNodeSchemaId(value.writableInitSchema))
}

function validExecution(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['capability', 'policy'])
    && typeof value.capability === 'string' && CAPABILITY_ID.test(value.capability)
    && typeof value.policy === 'string' && CAPABILITY_ID.test(value.policy)
}

export function isNodeSchemaId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 240 && SCHEMA_ID.test(value)
}

function validTypeId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 160
    && TYPE_ID.test(value)
    && !value.includes('..')
    && !value.includes('//')
}

function stringList(
  value: unknown,
  maxItems: number,
  maxLength: number,
  pattern?: RegExp,
): value is string[] {
  return Array.isArray(value)
    && value.length <= maxItems
    && value.every((item) => boundedString(item, 1, maxLength) && (!pattern || pattern.test(item)))
    && new Set(value).size === value.length
}

function boundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(reason: string): NodeTypeDefinitionInspection {
  return { status: 'invalid', reason }
}
