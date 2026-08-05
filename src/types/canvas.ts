import type { SuggestedAction } from '../agent/outcome.js'

/**
 * 节点类型是完全开放的：任何在插件注册表（src/plugins）中注册的类型 id 都合法。
 * 内置类型（pdf / web / image / text / table / formula / code / graphic / smart）
 * 与社区 / 用户自定义类型没有任何区别——它们只是自带的插件。
 */
export type NodeType = string

export type PortSide = 'top' | 'right' | 'bottom' | 'left'

/** 指令状态机：未执行 → 生成中 → 完成（规范 5.3，适用于所有节点） */
export type InstrPhase = 'idle' | 'generating' | 'done'

/** Agent 运行结束后在节点上的轻量物化视图；权威结果仍在 run log 中。 */
export interface SuggestedActionsCache {
  runId: string
  actions: SuggestedAction[]
}

/**
 * 指令区是每一个节点的标配能力：
 * 专精节点（PDF/图像/文本…）接受与其内容类型相关的指令，
 * 智能节点是通用型，接受任意生成指令。
 */
export interface InstructionState {
  phase: InstrPhase
  prompt: string
  attachments: string[]
  /** @deprecated 仅作旧画布兼容镜像；来源关系的权威事实源是 Edge。 */
  sources: string[]
  suggestedActions?: SuggestedActionsCache
  open: boolean     // 指令面板是否展开（提交后自动收起为摘要条）
}

/** 智能节点专属的通用生成参数 */
export interface SmartParams {
  chartType: '柱状图' | '折线图' | '面积图'
  style: '简洁' | '学术' | '信息图'
  count: number
  seed: number // 控制产物变体
}

export interface CanvasNode {
  id: string
  /** 插件 id（src/plugins 注册表中的 NodePlugin.id） */
  type: NodeType
  x: number
  y: number
  w: number
  h: number // 由 ResizeObserver 实测回填
  title: string
  text?: string
  meta?: string[]
  bold?: boolean
  italic?: boolean
  heading?: 0 | 1 | 2
  instruction: InstructionState
  smart?: SmartParams
  /** 插件自定义内容载荷（各节点插件自行定义结构） */
  payload?: Record<string, unknown>
}

export interface Edge {
  id: string
  from: string
  to: string
  label: string
}

export interface Camera { x: number; y: number; zoom: number }

export interface CreateMenuState {
  /** 屏幕坐标（菜单渲染在屏幕层，贴近触发点） */
  sx: number
  sy: number
  /** 对应的世界坐标（新节点落点） */
  wx: number
  wy: number
  /**
   * 引用来源节点（创建后自动建立关系，规范 10.2）。
   * 支持多个：从连线中点或框选多个节点触发时，新节点同时引用所有来源。
   */
  sourceIds?: string[]
  /** 从端口拖出触发时出线的端口侧（菜单打开期间用于持续绘制虚线） */
  fromSide?: PortSide
  /** 虚线端点（世界坐标），通常是拖拽释放点 / 连线中点 / 框选中心 */
  tipWx?: number
  tipWy?: number
  /** 从多选组框的端口拖出时：虚线从组框端口出发（组 = 大号节点） */
  groupPort?: { side: PortSide; wx: number; wy: number }
}

export interface ConnectingState {
  fromId: string
  side: PortSide
  /** 当前光标的屏幕坐标 */
  sx: number
  sy: number
}

/** 连线默认关系（规范 4.3） */
export const EDGE_LABELS = ['来源于', '提取自', '引用了', '生成自', '修改自', '对照', '替换']

let seq = 0
export const uid = (p = 'n') => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`
