/**
 * 上下文打包器：把画布状态编译成发给 Agent 的 ContextPack。
 *
 * 这是"上下文暴露-优化-管理"的核心。原则：
 *   1. 增量，不是整库 dump——只打包本次执行涉及的子图
 *   2. 三层裁剪——契约 / 图谱 / 内容，按范围取层
 *   3. Agent 只读 .gg/context/ 和 artifacts/，不直接碰 nodes.json
 */

import type { CanvasNode, Edge } from '../types/canvas.js'
import type { ContextPack, GraphSummary, NodeContent } from './types.js'

/** 从触发节点出发，沿"来源"边反向收集相关子图 */
function collectSubgraph(
  targetId: string,
  nodes: CanvasNode[],
  edges: Edge[],
): { nodeIds: Set<string>; edges: Edge[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const nodeIds = new Set<string>([targetId])
  const subEdges: Edge[] = []

  // 预建反向邻接表，避免 BFS 每访问一个节点都重新扫描全部边。
  const incomingByNode = new Map<string, Edge[]>()
  for (const edge of edges) {
    const incoming = incomingByNode.get(edge.to)
    if (incoming) incoming.push(edge)
    else incomingByNode.set(edge.to, [edge])
  }

  // BFS：把"谁是我的来源"一路追溯上去（连线方向 from → to，来源是 from）
  const queue = [targetId]
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const cur = queue[cursor]
    for (const edge of incomingByNode.get(cur) ?? []) {
      if (!byId.has(edge.from)) continue

      // 每条边只会在其 to 节点出队时访问一次，因此无需 includes 去重。
      subEdges.push(edge)
      if (!nodeIds.has(edge.from)) {
        nodeIds.add(edge.from)
        queue.push(edge.from)
      }
    }
  }
  return { nodeIds, edges: subEdges }
}

/** L1 图谱摘要：只有标题/类型/meta，不含正文，控制 token */
function buildGraphSummary(
  nodeIds: Set<string>,
  nodes: CanvasNode[],
  edges: Edge[],
): GraphSummary {
  return {
    nodes: nodes
      .filter((n) => nodeIds.has(n.id))
      .map((n) => ({ id: n.id, type: n.type, title: n.title, meta: n.meta })),
    edges: edges.map((e) => ({ from: e.from, to: e.to, label: e.label })),
  }
}

/** L2 完整内容：对目标节点及其直接来源打包全文 */
function buildSourceContent(node: CanvasNode): NodeContent {
  // CanvasSnapshot is validated at the daemon boundary, but remain defensive
  // for older snapshots that predate the instruction field.
  const attachments = Array.isArray(node.instruction?.attachments)
    ? node.instruction.attachments.filter((entry): entry is string => typeof entry === 'string')
    : []
  return {
    type: node.type,
    title: node.title,
    text: node.text,
    meta: node.meta,
    payload: node.payload,
    ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
    artifactFiles: [], // daemon 落盘时按节点已持久化的产物引用填充
  }
}

/** L0 契约层：AGENTS.md 摘要 + 启用插件的一句话契约 */
function buildContract(): string {
  // daemon 落盘时会把完整 AGENTS.md 写进项目目录；这里给 Agent 的 prompt 只放索引
  return [
    '# GGAI 画布契约',
    '- 你在一个节点画布的项目目录里工作。节点即文件，关系即上下文。',
    '- 读本次 daemon Output contract 了解上下文和不可变产物目录。',
    '- 遵守项目根目录 AGENTS.md 与 DESIGN.md 的全部约定。',
  ].join('\n')
}

export interface PackInput {
  targetNodeId: string
  nodes: CanvasNode[]
  edges: Edge[]
  projectDir: string
}

/**
 * 打包一次执行的上下文。
 * 范围规则：
 *   - 无来源的单节点执行：L0 + 自身 L2
 *   - 拖线/框选创建的执行：L0 + 子图 L1 + 自身及所有直接来源 L2
 */
export function packContext({ targetNodeId, nodes, edges, projectDir }: PackInput): ContextPack {
  const { nodeIds, edges: subEdges } = collectSubgraph(targetNodeId, nodes, edges)
  const byId = new Map(nodes.map((n) => [n.id, n]))

  // L2 永远包含目标自身，并保留所有有边直接指向目标的来源节点。
  const sourceContentIds = new Set<string>([targetNodeId])
  for (const edge of subEdges) {
    if (edge.to === targetNodeId) sourceContentIds.add(edge.from)
  }

  const sourceContents: Record<string, NodeContent> = {}
  for (const sid of sourceContentIds) {
    const n = byId.get(sid)
    if (n) sourceContents[sid] = buildSourceContent(n)
  }

  return {
    targetNodeId,
    contract: buildContract(),
    graphSummary: buildGraphSummary(nodeIds, nodes, subEdges),
    sourceContents,
    projectDir,
  }
}

/** 把 ContextPack 渲染成发给 Agent 的 prompt 文本（daemon 也可落盘为 .gg/context/pack.md） */
export function renderPackPrompt(pack: ContextPack, userPrompt: string): string {
  const lines: string[] = [pack.contract, '', '## 相关节点图谱']
  for (const n of pack.graphSummary.nodes) {
    lines.push(`- [${n.type}] ${n.title} (${n.id})${n.meta?.length ? ` · ${n.meta.join(' · ')}` : ''}`)
  }
  if (pack.graphSummary.edges.length) {
    lines.push('', '## 关系')
    for (const e of pack.graphSummary.edges) lines.push(`- ${e.from} --${e.label}--> ${e.to}`)
  }
  const srcIds = Object.keys(pack.sourceContents)
  if (srcIds.length) {
    lines.push('', '## 目标与直接来源内容')
    for (const sid of srcIds) {
      const c = pack.sourceContents[sid]
      lines.push(`### ${c.title} (${sid})`)
      if (c.text) lines.push(c.text)
      if (c.attachments?.length) {
        lines.push('附件：', ...c.attachments.map((attachment) => `- ${attachment}`))
      }
      if (c.payload) lines.push('```json', JSON.stringify(c.payload, null, 2), '```')
    }
  }
  lines.push('', '## 任务', userPrompt)
  return lines.join('\n')
}
