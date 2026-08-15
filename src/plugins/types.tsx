import { FileQuestion, type LucideIcon } from 'lucide-react'
import type { CanvasNode } from '@/canvas/model'
import {
  ARTIFACT_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
  inspectArtifactCapabilitySnapshotRequest,
  inspectArtifactClaimRegistry,
  type ArtifactCapabilitySnapshotRequest,
  type ArtifactClaimRule,
} from './artifactContracts'
import {
  BUILTIN_NODE_CONTEXT_PLUGIN_IDS,
  LEGACY_NODE_CONTEXT_POLICY,
  inspectNodeContextPolicy,
  type NodeContextPolicy,
} from './contextContracts'
import {
  defineNodeUi,
  inspectNodeUiDefinition,
  type NodeUiDefinition,
} from './uiContracts'

/**
 * GGAI 节点插件规范（v0.1）
 *
 * 画布上的一切节点——包括 9 种内置类型——都以完全相同的插件形态注册。
 * 内置插件与用户 / 社区插件能力完全对等：能看到的、能扩展的，就是这份规范。
 *
 * 一个节点插件 = 身份标识 + 数据化 UI 契约 + 指令配置 + Agent 能力声明。
 * 画布引擎（平移缩放、连线、选择、指令生命周期、持久化）对所有插件一视同仁。
 */

/** 内容载荷：节点的本体数据。各插件声明结构，持久化时随节点保存。 */
export type NodePayload = Record<string, unknown>

/** 空内容判定：决定节点显示空白态还是内容态（状态递进的基础，规范 2.3） */
export type IsEmpty = (node: CanvasNode) => boolean

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

/** 指令面板配置 */
export interface InstrConfig {
  /** 输入框占位提示 */
  placeholder: string
  /** 专属快捷指令（专精节点聚焦自身类型；通用型留空） */
  actions: string[]
  /**
   * 上下文相关的快捷指令（可选）：按节点当前内容与来源节点动态计算，
   * 结果追加在静态 actions 之后。用于"有产物才有意义"的指令（如改写 / 缩短），
   * 避免空白节点上指令脱离上下文。
   */
  actionsFor?: (node: CanvasNode, sources: CanvasNode[]) => string[]
  /**
   * 选择工具条的标记类按钮（可选）：如文本节点的粗体 / 斜体 / 标题。
   * 与快捷指令不同，标记直接改写节点自身（payload），不经过指令面板。
   * 返回非空数组时，选择工具条显示标记按钮而非快捷指令。
   */
  marksFor?: (node: CanvasNode) => NodeMark[]
  /** 应用标记：返回整体替换的新 payload；返回 null 表示该标记不适用。 */
  toggleMark?: (node: CanvasNode, markId: string) => Record<string, unknown> | null
}

/** 选择工具条上的一个标记按钮（粗体 / 斜体 / 标题等）。 */
export interface NodeMark {
  id: string
  title: string
  icon: LucideIcon
  active: boolean
}

export interface NodePlugin {
  /** 全局唯一 id，如 'pdf' / 'table'；社区插件建议带命名空间 '@author/video' */
  id: string
  /** 显示名（创建菜单、节点头部缺省标题） */
  label: string
  /** 一句话描述（首屏平铺面板） */
  desc: string
  /** False for projection-only types such as the generic `file` fallback. */
  creatable?: boolean
  icon: LucideIcon
  /** 缺省宽度（创建时） */
  defaultWidth: number
  /** 创建时的初始载荷 */
  initialPayload: () => NodePayload
  /** 空白判定 */
  isEmpty: IsEmpty
  /** 严格可序列化的内容模板；插件不能提供节点壳、CSS 或运行态。 */
  ui: NodeUiDefinition
  /** 指令区配置 */
  instr: InstrConfig
  /** 可序列化的产物声明；daemon 与浏览器使用同一份数据规则。 */
  artifactClaims: readonly ArtifactClaimRule[]
  /** 可序列化的 Node → Agent 上下文投影；不能扩大 Edge 或文件权限。 */
  nodeContext: NodeContextPolicy
}

/** 注册表：Map 保序，注册顺序即创建菜单顺序 */
const registry = new Map<string, NodePlugin>()
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

export function registerPlugin(p: NodePlugin) {
  if (registry.has(p.id)) {
    throw new TypeError(`[ggai] 节点插件 "${p.id}" 重复注册`)
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
    ...p,
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
export function getPlugin(id: string): NodePlugin {
  const p = registry.get(id)
  if (p) return p
  return {
    id, label: id, desc: '未安装的节点类型',
    icon: FileQuestion, defaultWidth: 300,
    initialPayload: () => ({}),
    isEmpty: (n) => !(n.text?.trim() || Object.keys(n.payload ?? {}).length),
    ui: defineNodeUi('file'),
    instr: { placeholder: '该节点类型未安装…', actions: [] },
    artifactClaims: [],
    nodeContext: structuredClone(LEGACY_NODE_CONTEXT_POLICY),
  }
}

/** 全部已注册插件（管理界面用） */
export function listPlugins(): NodePlugin[] {
  return [...registry.values()]
}

/** 启用中的插件（创建菜单 / 首屏面板用） */
export function listEnabledPlugins(): NodePlugin[] {
  return listPlugins().filter((p) => !disabled.has(p.id))
}

/** Enabled plugins that users may explicitly create from menus. */
export function listCreatablePlugins(): NodePlugin[] {
  return listEnabledPlugins().filter((plugin) => plugin.creatable !== false)
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
