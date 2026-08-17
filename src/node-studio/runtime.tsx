import {
  getPlugin,
  listPlugins,
  registerPlugin,
  unregisterPlugin,
  type NodeTypeDefinition,
} from '@/plugins/types'
import {
  NODE_CONTEXT_POLICY_SCHEMA_VERSION,
  defineNodeContextPolicy,
  type NodeContextPolicy,
} from '@/plugins/contextContracts'
import { artifactClaimsForBuiltin } from '@/plugins/artifactContracts'
import { defineNodeUi, type NodeContentTemplate } from '@/plugins/uiContracts'
import { NODE_TYPE_DEFINITION_SCHEMA_VERSION, type NodeTypeIconId } from '@/plugins/nodeTypeContracts'
import {
  customNodeRuntimeId,
  type CustomNodeContentKind,
  type CustomNodeManifest,
} from './model'

const registeredCustomIds = new Set<string>()

export function registerCustomNodeTypes(manifests: CustomNodeManifest[]): void {
  const installed = manifests.filter((manifest) => manifest.installed && manifest.revision > 0)
  const latestById = new Map<string, number>()
  installed.forEach((manifest) => {
    latestById.set(manifest.id, Math.max(latestById.get(manifest.id) ?? 0, manifest.revision))
  })
  installed.forEach((manifest) => {
    try {
      installCustomNodeManifest(manifest, latestById.get(manifest.id) === manifest.revision)
    } catch {
      // One damaged local manifest must not prevent the app from booting.
    }
  })
}

export function installCustomNodeManifest(
  manifest: CustomNodeManifest,
  creatable = true,
): NodeTypeDefinition {
  const runtimeId = customNodeRuntimeId(manifest)
  if (registeredCustomIds.has(runtimeId)) {
    unregisterPlugin(runtimeId)
    registeredCustomIds.delete(runtimeId)
  } else if (listPlugins().some((plugin) => plugin.id === runtimeId)) {
    throw new TypeError(`节点 ID ${runtimeId} 已被占用`)
  }
  const plugin = createCustomNodeType(manifest, creatable)
  registerPlugin(plugin)
  registeredCustomIds.add(runtimeId)
  return getPlugin(runtimeId)
}

export function createCustomNodeType(
  manifest: CustomNodeManifest,
  creatable = true,
): NodeTypeDefinition {
  return {
    schemaVersion: NODE_TYPE_DEFINITION_SCHEMA_VERSION,
    id: customNodeRuntimeId(manifest),
    revision: manifest.revision,
    label: manifest.label,
    description: manifest.description,
    creatable,
    icon: iconForContentKind(manifest.icon),
    defaultWidth: manifest.defaultWidth,
    initialPayloadSchema: manifest.initialPayloadSchema,
    initialPayload: structuredClone(manifest.initialPayload),
    ui: defineNodeUi(templateForContentKind(manifest.contentKind)),
    instruction: {
      placeholder: manifest.placeholder,
      actions: manifest.actions,
      marks: [],
    },
    containment: structuredClone(manifest.containment),
    ports: structuredClone(manifest.ports),
    ...(manifest.execution ? { execution: structuredClone(manifest.execution) } : {}),
    exporters: [...manifest.exporters],
    agent: {
      constructible: creatable && manifest.agent.constructible,
      ...(creatable && manifest.agent.writableInitSchema
        ? { writableInitSchema: manifest.agent.writableInitSchema }
        : {}),
    },
    nodeContext: customNodeContextPolicy(manifest.contentKind),
    artifactClaims: artifactClaimsForContentKind(manifest.contentKind),
  }
}

function artifactClaimsForContentKind(
  kind: CustomNodeContentKind,
): NodeTypeDefinition['artifactClaims'] {
  if (kind === 'image') return artifactClaimsForBuiltin('image')
  if (kind === 'table') return artifactClaimsForBuiltin('table')
  return artifactClaimsForBuiltin('text')
}

function iconForContentKind(kind: CustomNodeContentKind): NodeTypeIconId {
  if (kind === 'text') return 'text'
  if (kind === 'image') return 'image'
  if (kind === 'table') return 'table'
  return 'card'
}

function templateForContentKind(kind: CustomNodeContentKind): NodeContentTemplate {
  if (kind === 'text') return 'document'
  if (kind === 'image') return 'media'
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
