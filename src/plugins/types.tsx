import {
  Bold,
  Code2,
  File as FileIcon,
  FileQuestion,
  FileText,
  Heading1,
  Heading2,
  Image as ImageIcon,
  Italic,
  LayoutTemplate,
  Link2,
  Shapes,
  Sigma,
  Sparkles,
  Table2,
  Type,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react'
import { createElement } from 'react'
import type { CanvasNode } from '@/canvas/model'
import {
  ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
  inspectArtifactCapabilitySnapshotRequest,
  inspectArtifactClaimRegistry,
  type ArtifactCapabilitySnapshotRequest,
} from './artifactContracts'
import {
  BUILTIN_NODE_CONTEXT_PLUGIN_IDS,
  LEGACY_NODE_CONTEXT_POLICY,
  inspectNodeContextPolicy,
} from './contextContracts'
import {
  defineNodeUi,
  inspectNodeUiDefinition,
} from './uiContracts'
import {
  NODE_TYPE_DEFINITION_SCHEMA_VERSION,
  inspectNodeTypeDefinition,
  type NodeMarkDefinition,
  type NodeTypeDefinition,
  type NodeTypeIconId,
} from './nodeTypeContracts'

/**
 * GGAI 节点插件规范（v0.1）
 *
 * 画布上的一切节点——包括 9 种内置类型——都以完全相同的插件形态注册。
 * 内置插件与用户 / 社区插件能力完全对等：能看到的、能扩展的，就是这份规范。
 *
 * 一个节点插件 = 身份标识 + 数据化 UI 契约 + 指令配置 + Agent 能力声明。
 * 画布引擎（平移缩放、连线、选择、指令生命周期、持久化）对所有插件一视同仁。
 */

export type NodePayload = Record<string, unknown>

export type NodeContentPatch = Pick<Partial<CanvasNode>, 'title' | 'text' | 'payload'>

/** Daemon-verified artifact identity exposed to a browser-only pure projector. */
export type TrustedArtifactProjection = Readonly<{
  runId: string
  artifactId: string
  mediaType: string
  size: number
  contentDigest: string
  title: string
  /** Runtime-only verified artifact URL; it is never persisted in Canvas state. */
  url: string
}>

export interface NodeArtifactViewProps {
  artifact: TrustedArtifactProjection
  content: Readonly<NodeContentPatch>
  /**
   * 产物所属的当前节点（可选）：需要读取节点自身状态（如文本节点的
   * 粗体 / 斜体 / 标题 payload 标记）的产物视图使用；与 artifact 内容无关。
   */
  node?: CanvasNode
}

/** 选择工具条上的一个标记按钮（粗体 / 斜体 / 标题等）。 */
export interface NodeMark {
  id: string
  title: string
  icon: LucideIcon
  active: boolean
}

/** 注册表：Map 保序，注册顺序即创建菜单顺序 */
const registry = new Map<string, NodeTypeDefinition>()
const listeners = new Set<() => void>()
let registryVersion = 0
/** 未启用的插件不进创建菜单 / 首屏面板；已存在于画布的节点仍可正常渲染 */
const disabled = new Set<string>()

function emit() {
  registryVersion += 1
  listeners.forEach((l) => l())
}

export function getPluginRegistryVersion(): number {
  return registryVersion
}

export function subscribePlugins(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function registerPlugin(p: NodeTypeDefinition) {
  if (registry.has(p.id)) {
    throw new TypeError(`[ggai] 节点插件 "${p.id}" 重复注册`)
  }
  const definitionInspection = inspectNodeTypeDefinition(p)
  if (definitionInspection.status !== 'valid') {
    throw new TypeError(`[ggai] 节点类型 "${p.id}" 无效：${definitionInspection.reason}`)
  }
  const inspection = inspectArtifactClaimRegistry([{
    id: p.id,
    artifactClaims: p.artifactClaims,
  }])
  if (inspection.status !== 'valid') {
    throw new TypeError(`[ggai] 节点插件 "${p.id}" 的 artifactClaims 无效：${inspection.reason}`)
  }
  const contextInspection = inspectNodeContextPolicy(p.nodeContext)
  if (contextInspection.status !== 'valid') {
    throw new TypeError(`[ggai] 节点插件 "${p.id}" 的 nodeContext 无效：${contextInspection.reason}`)
  }
  const uiInspection = inspectNodeUiDefinition(p.ui)
  if (uiInspection.status !== 'valid') {
    throw new TypeError(`[ggai] 节点插件 "${p.id}" 的 ui 无效：${uiInspection.reason}`)
  }
  registry.set(p.id, {
    ...definitionInspection.definition,
    ui: uiInspection.definition,
    artifactClaims: inspection.registrations[0]?.artifactClaims ?? [],
    nodeContext: contextInspection.policy,
  })
  emit()
}

/** Explicit lifecycle hook for plugin unload/HMR; normal registration never overwrites. */
export function unregisterPlugin(id: string): boolean {
  const removed = registry.delete(id)
  if (!removed) return false
  disabled.delete(id)
  emit()
  return true
}

export function setPluginEnabled(id: string, enabled: boolean) {
  if (enabled) disabled.delete(id)
  else disabled.add(id)
  emit()
}

export function isPluginEnabled(id: string): boolean {
  return !disabled.has(id)
}

/** 渲染兜底：禁用/未知的类型也能安全取到一个插件（未知类型退化为通用占位） */
export function getPlugin(id: string): NodeTypeDefinition {
  const p = registry.get(id)
  if (p) return p
  return {
    schemaVersion: NODE_TYPE_DEFINITION_SCHEMA_VERSION,
    id, revision: 1, label: id, description: '未安装的节点类型',
    creatable: false, icon: 'file', defaultWidth: 300,
    initialPayloadSchema: 'ggai://schema/payload/open',
    initialPayload: {},
    ui: defineNodeUi('file'),
    instruction: { placeholder: '该节点类型未安装…', actions: [], marks: [] },
    containment: { canHaveChildren: false, allowedChildTypes: [], maxDepth: 0 },
    ports: [],
    exporters: [],
    agent: { constructible: false },
    artifactClaims: [],
    nodeContext: structuredClone(LEGACY_NODE_CONTEXT_POLICY),
  }
}

/** 全部已注册插件（管理界面用） */
export function listPlugins(): NodeTypeDefinition[] {
  return [...registry.values()]
}

/** 启用中的插件（创建菜单 / 首屏面板用） */
export function listEnabledPlugins(): NodeTypeDefinition[] {
  return listPlugins().filter((p) => !disabled.has(p.id))
}

/** Enabled plugins that users may explicitly create from menus. */
export function listCreatablePlugins(): NodeTypeDefinition[] {
  return listEnabledPlugins().filter((plugin) => plugin.creatable)
}

/**
 * Captures enabled browser plugin claims as strict data. Daemon-owned built-ins
 * are intentionally omitted because the daemon supplies and protects them.
 */
export function enabledArtifactCapabilitySnapshot(): ArtifactCapabilitySnapshotRequest {
  const inspection = inspectArtifactCapabilitySnapshotRequest({
    schemaVersion: ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
    plugins: listEnabledPlugins()
      .filter((plugin) => !BUILTIN_NODE_CONTEXT_PLUGIN_IDS.has(plugin.id))
      .filter((plugin) => plugin.artifactClaims.length > 0
        || JSON.stringify(plugin.nodeContext) !== JSON.stringify(LEGACY_NODE_CONTEXT_POLICY))
      .map((plugin) => ({
        id: plugin.id,
        artifactClaims: plugin.artifactClaims,
        nodeContext: plugin.nodeContext,
      })),
  })
  if (inspection.status !== 'valid') {
    throw new TypeError(`[ggai] 无法序列化插件能力快照：${inspection.reason}`)
  }
  return inspection.snapshot
}

const NODE_TYPE_ICONS: Readonly<Record<NodeTypeIconId, LucideIcon>> = {
  pdf: FileText,
  web: Link2,
  image: ImageIcon,
  text: Type,
  table: Table2,
  formula: Sigma,
  code: Code2,
  graphic: Shapes,
  smart: Sparkles,
  file: FileIcon,
  card: LayoutTemplate,
}

const MARK_ICONS: Readonly<Record<NodeMarkDefinition['icon'], LucideIcon>> = {
  bold: Bold,
  italic: Italic,
  'heading-1': Heading1,
  'heading-2': Heading2,
}

export function nodeTypeIcon(definition: NodeTypeDefinition): LucideIcon {
  return NODE_TYPE_ICONS[definition.icon] ?? FileQuestion
}

export function NodeTypeIconView({
  definition,
  ...props
}: { definition: NodeTypeDefinition } & LucideProps) {
  return createElement(NODE_TYPE_ICONS[definition.icon] ?? FileQuestion, props)
}

export function nodeTypeInitialPayload(definition: NodeTypeDefinition): NodePayload {
  return structuredClone(definition.initialPayload)
}

export function nodeTypeIsEmpty(_definition: NodeTypeDefinition, node: CanvasNode): boolean {
  return !node.text?.trim()
    && Object.keys(node.payload ?? {}).length === 0
    && node.artifactRefs.length === 0
}

export function nodeTypeMarks(
  definition: NodeTypeDefinition,
  node: CanvasNode,
): NodeMark[] {
  const payload = node.payload ?? {}
  return definition.instruction.marks.map((mark) => ({
    id: mark.id,
    title: mark.title,
    icon: MARK_ICONS[mark.icon],
    active: payload[mark.payloadKey] === mark.value,
  }))
}

export function toggleNodeTypeMark(
  definition: NodeTypeDefinition,
  node: CanvasNode,
  markId: string,
): Record<string, unknown> | null {
  const mark = definition.instruction.marks.find((candidate) => candidate.id === markId)
  if (!mark) return null
  const payload: Record<string, unknown> = { ...(node.payload ?? {}) }
  const active = payload[mark.payloadKey] === mark.value
  if (mark.exclusiveGroup) {
    for (const peer of definition.instruction.marks) {
      if (peer.exclusiveGroup === mark.exclusiveGroup) delete payload[peer.payloadKey]
    }
  }
  if (!active) payload[mark.payloadKey] = mark.value
  else delete payload[mark.payloadKey]
  return payload
}

export function nodeTypeActions(definition: NodeTypeDefinition): string[] {
  return [...definition.instruction.actions]
}

export type { NodeTypeDefinition } from './nodeTypeContracts'
