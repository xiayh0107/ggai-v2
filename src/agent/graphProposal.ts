export const MAX_GRAPH_PROPOSAL_NODES = 256
export const MAX_GRAPH_PROPOSAL_EDGES = 512
export const MAX_GRAPH_PROPOSAL_INIT_BYTES = 256 * 1024

export interface GraphProposalNode {
  key: string
  typeId: string
  title: string
  parentKey?: string
  init: Record<string, unknown>
}

export interface GraphProposalEdge {
  fromKey: string
  fromPort: string
  toKey: string
  toPort: string
}

export interface GraphProposal {
  nodes: GraphProposalNode[]
  edges: GraphProposalEdge[]
}

export type GraphProposalInspection =
  | { status: 'valid'; proposal: GraphProposal }
  | { status: 'invalid'; reason: string }

export function inspectGraphProposal(value: unknown): GraphProposalInspection {
  if (!isRecord(value) || !exactKeys(value, ['edges', 'nodes'])
    || !Array.isArray(value.nodes) || value.nodes.length < 1
    || value.nodes.length > MAX_GRAPH_PROPOSAL_NODES
    || !Array.isArray(value.edges) || value.edges.length > MAX_GRAPH_PROPOSAL_EDGES) {
    return invalid('graphProposal envelope or bounds are invalid')
  }
  const nodes: GraphProposalNode[] = []
  const keys = new Set<string>()
  let initBytes = 0
  for (const [index, candidate] of value.nodes.entries()) {
    if (!isRecord(candidate)) return invalid(`graphProposal.nodes[${index}] is invalid`)
    const expected = ['init', 'key', 'title', 'typeId']
    if (candidate.parentKey !== undefined) expected.push('parentKey')
    if (!exactKeys(candidate, expected)
      || !stableKey(candidate.key) || !typeId(candidate.typeId)
      || !displayString(candidate.title, 240)
      || (candidate.parentKey !== undefined && !stableKey(candidate.parentKey))
      || !isRecord(candidate.init)
      || containsForbiddenAuthority(candidate.init)) {
      return invalid(`graphProposal.nodes[${index}] is invalid or contains authority fields`)
    }
    if (keys.has(candidate.key)) return invalid(`graphProposal.nodes[${index}].key is duplicated`)
    keys.add(candidate.key)
    initBytes += new TextEncoder().encode(JSON.stringify(candidate.init)).byteLength
    if (initBytes > MAX_GRAPH_PROPOSAL_INIT_BYTES) return invalid('graphProposal init exceeds byte limit')
    nodes.push({
      key: candidate.key,
      typeId: candidate.typeId,
      title: candidate.title,
      ...(typeof candidate.parentKey === 'string' ? { parentKey: candidate.parentKey } : {}),
      init: structuredClone(candidate.init),
    })
  }
  if (nodes.some((node) => node.parentKey !== undefined && !keys.has(node.parentKey))) {
    return invalid('graphProposal parentKey references a missing node')
  }
  const edges: GraphProposalEdge[] = []
  const edgeKeys = new Set<string>()
  for (const [index, candidate] of value.edges.entries()) {
    if (!isRecord(candidate)
      || !exactKeys(candidate, ['fromKey', 'fromPort', 'toKey', 'toPort'])
      || !stableKey(candidate.fromKey) || !portKey(candidate.fromPort)
      || !stableKey(candidate.toKey) || !portKey(candidate.toPort)
      || !keys.has(candidate.fromKey) || !keys.has(candidate.toKey)
      || candidate.fromKey === candidate.toKey) {
      return invalid(`graphProposal.edges[${index}] is invalid`)
    }
    const edgeKey = `${candidate.fromKey}\0${candidate.fromPort}\0${candidate.toKey}\0${candidate.toPort}`
    if (edgeKeys.has(edgeKey)) return invalid(`graphProposal.edges[${index}] is duplicated`)
    edgeKeys.add(edgeKey)
    edges.push(structuredClone(candidate) as unknown as GraphProposalEdge)
  }
  return { status: 'valid', proposal: { nodes, edges } }
}

function containsForbiddenAuthority(value: unknown, depth = 0): boolean {
  if (depth > 32) return true
  if (typeof value === 'string') return value.startsWith('/') || value.includes('\0')
  if (Array.isArray(value)) return value.some((entry) => containsForbiddenAuthority(entry, depth + 1))
  if (!isRecord(value)) return false
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:id|canvasId|x|y|frame|bounds|transform|matrix|orderKey|path|command|image|containerImage|secret|token|password|env|autoRun)$/iu.test(key)) {
      return true
    }
    if (containsForbiddenAuthority(child, depth + 1)) return true
  }
  return false
}

function stableKey(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 100
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
}

function portKey(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 120
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
}

function typeId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 160
    && /^@?[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)
    && !value.includes('..') && !value.includes('//')
}

function displayString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maxLength
    && value === value.trim() && !containsAsciiControl(value)
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join('\0') === expected.sort().join('\0')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(reason: string): GraphProposalInspection {
  return { status: 'invalid', reason }
}
