import { Image, LayoutTemplate, Table2, Type } from 'lucide-react'
import {
  getPlugin,
  listPlugins,
  registerPlugin,
  unregisterPlugin,
  type NodePlugin,
} from '@/plugins/types'
import {
  NODE_CONTEXT_POLICY_SCHEMA_VERSION,
  defineNodeContextPolicy,
  type NodeContextPolicy,
} from '@/plugins/contextContracts'
import { artifactClaimsForBuiltin } from '@/plugins/artifactContracts'
import { defineNodeUi, type NodeContentTemplate } from '@/plugins/uiContracts'
import {
  customNodeRuntimeId,
  type CustomNodeContentKind,
  type CustomNodeManifest,
} from './model'

const registeredCustomIds = new Set<string>()

const ICONS = {
  text: Type,
  image: Image,
  table: Table2,
  card: LayoutTemplate,
} as const

export function registerCustomNodePlugins(manifests: CustomNodeManifest[]): void {
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
): NodePlugin {
  const runtimeId = customNodeRuntimeId(manifest)
  if (registeredCustomIds.has(runtimeId)) {
    unregisterPlugin(runtimeId)
    registeredCustomIds.delete(runtimeId)
  } else if (listPlugins().some((plugin) => plugin.id === runtimeId)) {
    throw new TypeError(`节点 ID ${runtimeId} 已被占用`)
  }
  const plugin = createCustomNodePlugin(manifest, creatable)
  registerPlugin(plugin)
  registeredCustomIds.add(runtimeId)
  return getPlugin(runtimeId)
}

export function createCustomNodePlugin(manifest: CustomNodeManifest, creatable = true): NodePlugin {
  const Icon = ICONS[manifest.icon]
  return {
    id: customNodeRuntimeId(manifest),
    label: manifest.label,
    desc: manifest.description,
    creatable,
    icon: Icon,
    defaultWidth: manifest.defaultWidth,
    initialPayload: () => ({}),
    isEmpty: (node) => !node.text?.trim() && !node.payload?.content,
    ui: defineNodeUi(templateForContentKind(manifest.contentKind)),
    instr: {
      placeholder: manifest.placeholder,
      actions: manifest.actions,
    },
    nodeContext: customNodeContextPolicy(manifest.contentKind),
    artifactClaims: artifactClaimsForContentKind(manifest.contentKind),
  }
}

function artifactClaimsForContentKind(
  kind: CustomNodeContentKind,
): NodePlugin['artifactClaims'] {
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
