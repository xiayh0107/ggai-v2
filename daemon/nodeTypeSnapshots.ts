import { createHash } from 'node:crypto'
import { artifactClaimsForBuiltin } from '../src/plugins/artifactContracts.js'
import {
  NODE_CONTEXT_POLICY_SCHEMA_VERSION,
  defineNodeContextPolicy,
  type NodeContextPolicy,
} from '../src/plugins/contextContracts.js'
import {
  NODE_TYPE_DEFINITION_SCHEMA_VERSION,
  inspectNodeTypeDefinition,
  type NodeTypeDefinition,
  type NodeTypeIconId,
  type NodeTypeSnapshot,
} from '../src/plugins/nodeTypeContracts.js'
import { defineNodeUi, type NodeContentTemplate } from '../src/plugins/uiContracts.js'
import {
  customNodeRuntimeId,
  type CustomNodeContentKind,
  type CustomNodeManifest,
} from '../src/node-studio/model.js'

export function snapshotCustomNodeType(manifest: CustomNodeManifest): NodeTypeSnapshot {
  const definition: NodeTypeDefinition = {
    schemaVersion: NODE_TYPE_DEFINITION_SCHEMA_VERSION,
    id: customNodeRuntimeId(manifest),
    revision: manifest.revision,
    label: manifest.label,
    description: manifest.description,
    creatable: manifest.installed,
    icon: iconForContentKind(manifest.icon),
    defaultWidth: manifest.defaultWidth,
    initialPayloadSchema: manifest.initialPayloadSchema,
    initialPayload: structuredClone(manifest.initialPayload),
    ui: defineNodeUi(templateForContentKind(manifest.contentKind)),
    instruction: {
      placeholder: manifest.placeholder,
      actions: [...manifest.actions],
      marks: [],
    },
    containment: structuredClone(manifest.containment),
    ports: structuredClone(manifest.ports),
    ...(manifest.execution ? { execution: structuredClone(manifest.execution) } : {}),
    exporters: [...manifest.exporters],
    agent: structuredClone(manifest.agent),
    artifactClaims: artifactClaimsForContentKind(manifest.contentKind),
    nodeContext: customNodeContextPolicy(manifest.contentKind),
  }
  const inspection = inspectNodeTypeDefinition(definition)
  if (inspection.status !== 'valid') {
    throw new TypeError(`custom node type snapshot is invalid: ${inspection.reason}`)
  }
  return {
    ...inspection.definition,
    digest: createHash('sha256')
      .update('ggai.node-type-definition.v2\0', 'utf8')
      .update(JSON.stringify(inspection.definition), 'utf8')
      .digest('hex'),
  }
}

function artifactClaimsForContentKind(kind: CustomNodeContentKind) {
  if (kind === 'image') return artifactClaimsForBuiltin('image')
  if (kind === 'table') return artifactClaimsForBuiltin('table')
  return artifactClaimsForBuiltin('text')
}

function templateForContentKind(kind: CustomNodeContentKind): NodeContentTemplate {
  if (kind === 'text') return 'document'
  if (kind === 'image') return 'media'
  if (kind === 'table') return 'table'
  return 'card'
}

function iconForContentKind(kind: CustomNodeContentKind): NodeTypeIconId {
  if (kind === 'text') return 'text'
  if (kind === 'image') return 'image'
  if (kind === 'table') return 'table'
  return 'card'
}

function customNodeContextPolicy(kind: CustomNodeContentKind): NodeContextPolicy {
  const textMaxChars = kind === 'text' || kind === 'table' ? 250_000 : 64_000
  return defineNodeContextPolicy({
    schemaVersion: NODE_CONTEXT_POLICY_SCHEMA_VERSION,
    summary: {
      textMaxChars: kind === 'image' ? 0 : 600,
      payloadFields: kind === 'image' ? [] : ['content'],
    },
    full: {
      textMaxChars,
      payloadFields: ['content'],
      artifactRefs: 'none',
    },
  })
}
