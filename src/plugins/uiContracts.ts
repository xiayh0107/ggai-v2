/**
 * Serializable Node UI contract.
 *
 * A plugin or Agent may choose one of these platform-owned content templates.
 * It cannot provide JSX, CSS, shell chrome, empty states or running states.
 */
export const NODE_UI_SCHEMA_VERSION = 1 as const

export const NODE_CONTENT_TEMPLATES = [
  'document',
  'code',
  'formula',
  'link',
  'table',
  'media',
  'card',
  'file',
] as const

export type NodeContentTemplate = typeof NODE_CONTENT_TEMPLATES[number]

export interface NodeUiDefinition {
  schemaVersion: typeof NODE_UI_SCHEMA_VERSION
  template: NodeContentTemplate
}

export type NodeUiDefinitionInspection =
  | { status: 'valid'; definition: NodeUiDefinition }
  | { status: 'invalid'; reason: string }

export function defineNodeUi(template: NodeContentTemplate): NodeUiDefinition {
  return Object.freeze({
    schemaVersion: NODE_UI_SCHEMA_VERSION,
    template,
  })
}

export function inspectNodeUiDefinition(value: unknown): NodeUiDefinitionInspection {
  if (!isRecord(value)) return invalid('ui must be an object')
  const keys = Object.keys(value).sort()
  if (keys.length !== 2 || keys[0] !== 'schemaVersion' || keys[1] !== 'template') {
    return invalid('ui must contain exactly schemaVersion and template')
  }
  if (value.schemaVersion !== NODE_UI_SCHEMA_VERSION) {
    return invalid(`unsupported ui schemaVersion ${String(value.schemaVersion)}`)
  }
  if (typeof value.template !== 'string'
    || !(NODE_CONTENT_TEMPLATES as readonly string[]).includes(value.template)) {
    return invalid(`unsupported content template ${String(value.template)}`)
  }
  return {
    status: 'valid',
    definition: defineNodeUi(value.template as NodeContentTemplate),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(reason: string): NodeUiDefinitionInspection {
  return { status: 'invalid', reason }
}
