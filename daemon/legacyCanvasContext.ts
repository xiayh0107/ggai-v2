/**
 * Compatibility adapter for Node Studio's pre-Task snapshot request.
 *
 * The product has one Canvas model. This small, daemon-only shape remains only
 * so an in-flight Node Studio request can be packed without importing a second
 * frontend Canvas implementation.
 */
export interface LegacyCanvasNode {
  id: string
  type: string
  x: number
  y: number
  w: number
  h: number
  title: string
  text?: string
  meta?: string[]
  bold?: boolean
  italic?: boolean
  heading?: 0 | 1 | 2
  instruction?: {
    phase?: 'idle' | 'generating' | 'done'
    prompt?: string
    attachments?: string[]
    sources?: string[]
    open?: boolean
  }
  smart?: {
    chartType: '柱状图' | '折线图' | '面积图'
    style: '简洁' | '学术' | '信息图'
    count: number
    seed: number
  }
  payload?: Record<string, unknown>
}

export interface LegacyCanvasEdge {
  id: string
  from: string
  to: string
  label: string
}

export interface LegacyNodeContent {
  type: string
  title: string
  text?: string
  meta?: string[]
  attachments?: string[]
  payload?: Record<string, unknown>
  artifactFiles?: string[]
}

export interface LegacyContextPack {
  targetNodeId: string
  contract: string
  graphSummary: {
    nodes: Array<{ id: string; type: string; title: string; meta?: string[] }>
    edges: Array<{ from: string; to: string; label: string }>
  }
  sourceContents: Record<string, LegacyNodeContent>
  projectDir: string
}

export function packLegacyCanvasContext(input: {
  targetNodeId: string
  nodes: LegacyCanvasNode[]
  edges: LegacyCanvasEdge[]
  projectDir: string
}): LegacyContextPack {
  const byId = new Map(input.nodes.map((node) => [node.id, node]))
  const nodeIds = new Set<string>([input.targetNodeId])
  const edges: LegacyCanvasEdge[] = []
  const incomingByNode = new Map<string, LegacyCanvasEdge[]>()
  for (const edge of input.edges) {
    const incoming = incomingByNode.get(edge.to)
    if (incoming) incoming.push(edge)
    else incomingByNode.set(edge.to, [edge])
  }
  const queue = [input.targetNodeId]
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const edge of incomingByNode.get(queue[cursor]) ?? []) {
      if (!byId.has(edge.from)) continue
      edges.push(edge)
      if (!nodeIds.has(edge.from)) {
        nodeIds.add(edge.from)
        queue.push(edge.from)
      }
    }
  }

  const sourceIds = new Set<string>([input.targetNodeId])
  for (const edge of edges) {
    if (edge.to === input.targetNodeId) sourceIds.add(edge.from)
  }
  const sourceContents: Record<string, LegacyNodeContent> = {}
  for (const id of sourceIds) {
    const node = byId.get(id)
    if (!node) continue
    const attachments = Array.isArray(node.instruction?.attachments)
      ? node.instruction.attachments.filter((value): value is string => typeof value === 'string')
      : []
    sourceContents[id] = {
      type: node.type,
      title: node.title,
      ...(node.text === undefined ? {} : { text: node.text }),
      ...(node.meta === undefined ? {} : { meta: node.meta }),
      ...(attachments.length === 0 ? {} : { attachments }),
      ...(node.payload === undefined ? {} : { payload: node.payload }),
      artifactFiles: [],
    }
  }
  return {
    targetNodeId: input.targetNodeId,
    contract: [
      '# GGAI Canvas contract',
      '- Read this run context and write deliverables only to the declared artifact directory.',
      '- Follow the project AGENTS.md and DESIGN.md.',
    ].join('\n'),
    graphSummary: {
      nodes: input.nodes.filter((node) => nodeIds.has(node.id)).map((node) => ({
        id: node.id,
        type: node.type,
        title: node.title,
        ...(node.meta === undefined ? {} : { meta: node.meta }),
      })),
      edges: edges.map((edge) => ({ from: edge.from, to: edge.to, label: edge.label })),
    },
    sourceContents,
    projectDir: input.projectDir,
  }
}

export function renderLegacyCanvasPrompt(pack: LegacyContextPack, userPrompt: string): string {
  const lines = [pack.contract, '', '## Related Canvas graph']
  for (const node of pack.graphSummary.nodes) {
    lines.push(`- [${node.type}] ${node.title} (${node.id})${node.meta?.length ? ` · ${node.meta.join(' · ')}` : ''}`)
  }
  if (pack.graphSummary.edges.length > 0) {
    lines.push('', '## Relations')
    for (const edge of pack.graphSummary.edges) {
      lines.push(`- ${edge.from} --${edge.label}--> ${edge.to}`)
    }
  }
  const sourceIds = Object.keys(pack.sourceContents)
  if (sourceIds.length > 0) {
    lines.push('', '## Target and direct source content')
    for (const id of sourceIds) {
      const content = pack.sourceContents[id]
      lines.push(`### ${content.title} (${id})`)
      if (content.text) lines.push(content.text)
      if (content.attachments?.length) {
        lines.push('Attachments:', ...content.attachments.map((item) => `- ${item}`))
      }
      if (content.payload) lines.push('```json', JSON.stringify(content.payload, null, 2), '```')
    }
  }
  lines.push('', '## Task', userPrompt)
  return lines.join('\n')
}
