import { FileQuestion, type LucideIcon } from 'lucide-react'
import type { ComponentType } from 'react'
import type { CanvasNode } from '@/types/canvas'
import type { RunOutcome } from '@/agent/outcome'

/**
 * GGAI 节点插件规范（v0.1）
 *
 * 画布上的一切节点——包括 9 种内置类型——都以完全相同的插件形态注册。
 * 内置插件与用户 / 社区插件能力完全对等：能看到的、能扩展的，就是这份规范。
 *
 * 一个节点插件 = 身份标识 + 内容契约 + 状态视图 + 指令配置。
 * 画布引擎（平移缩放、连线、选择、指令生命周期、持久化）对所有插件一视同仁。
 */

/** 内容载荷：节点的本体数据。各插件自行定义结构，持久化时随节点保存 */
export type NodePayload = Record<string, unknown>

/** 空内容判定：决定节点显示空白态还是内容态（状态递进的基础，规范 2.3） */
export type IsEmpty = (node: CanvasNode) => boolean

/**
 * 首次执行指令后的演示结果（原型阶段）。
 * 返回要合并进节点的补丁：标题 / 文本 / meta / payload。
 * 返回 null 表示内容无变化（仅在 meta 追加一条「✓ 已完成」）。
 */
export type DemoResult = (node: CanvasNode, prompt: string) => Partial<CanvasNode> | null

/** 节点插件可选择如何把一次通用 run 结果投影成自己的内容。 */
export interface NodeRunResult {
  responseText: string
  artifactFiles: string[]
  outcome?: RunOutcome
}

export type NodeContentPatch = Pick<Partial<CanvasNode>, 'title' | 'text' | 'meta' | 'payload'>
export type MaterializeRunResult = (
  node: CanvasNode,
  result: NodeRunResult,
) => NodeContentPatch | null

/** 指令参数槽：渲染在指令面板底部控制条左侧（如智能节点的图表类型 / 风格 / 张数） */
export interface ParamSlotProps {
  node: CanvasNode
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
  /** 底部控制条的参数槽（可选） */
  ParamSlot?: ComponentType<ParamSlotProps>
}

/** 节点插件的视图组件契约 */
export interface NodeViewProps {
  node: CanvasNode
  selected: boolean
}

export interface NodeViews {
  /** 空白态（无内容时） */
  Empty: ComponentType<NodeViewProps>
  /** 内容态（有内容时） */
  Content: ComponentType<NodeViewProps>
}

export interface NodePlugin {
  /** 全局唯一 id，如 'pdf' / 'table'；社区插件建议带命名空间 '@author/video' */
  id: string
  /** 显示名（创建菜单、节点头部缺省标题） */
  label: string
  /** 一句话描述（首屏平铺面板） */
  desc: string
  icon: LucideIcon
  /** 缺省宽度（创建时） */
  defaultWidth: number
  /** 创建时的初始载荷 */
  initialPayload: () => NodePayload
  /** 空白判定 */
  isEmpty: IsEmpty
  /** 视图 */
  views: NodeViews
  /** 指令区配置 */
  instr: InstrConfig
  /** 可选：把 Agent 文本/产物投影到插件内容，画布内核不分支具体节点 id。 */
  materializeRunResult?: MaterializeRunResult
  /** 首次指令演示结果 */
  demoResult: DemoResult
}

/** 注册表：Map 保序，注册顺序即创建菜单顺序 */
const registry = new Map<string, NodePlugin>()
const listeners = new Set<() => void>()
/** 未启用的插件不进创建菜单 / 首屏面板；已存在于画布的节点仍可正常渲染 */
const disabled = new Set<string>()

function emit() {
  listeners.forEach((l) => l())
}

export function subscribePlugins(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function registerPlugin(p: NodePlugin) {
  if (registry.has(p.id)) {
    console.warn(`[ggai] 节点插件 "${p.id}" 重复注册，已覆盖`)
  }
  registry.set(p.id, p)
  emit()
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
    isEmpty: (n) => !(n.text?.trim() || (n.meta ?? []).length),
    views: {
      Empty: () => null,
      Content: ({ node }) => (
        <div className="rounded-[10px] bg-gg-subtle p-3 text-[11.5px] text-gg-muted">
          节点类型「{id}」未安装，内容已保留
          {node.text ? <p className="mt-1 text-gg-ink">{node.text}</p> : null}
        </div>
      ),
    },
    instr: { placeholder: '该节点类型未安装…', actions: [] },
    demoResult: () => null,
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
