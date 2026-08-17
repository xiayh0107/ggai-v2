import type {
  CanvasDocument,
  CanvasEntityRef,
  CanvasPoint,
} from '@/canvas/model'
import type { CanvasEdgeEndpoint } from './CanvasEdgeLayer'
import type { CanvasConnectionPortSide } from './CanvasConnectionPort'
import type { PortDefinition } from '@/plugins/nodeTypeContracts'

export type CanvasConnectionEndpoint = (CanvasEdgeEndpoint & {
  portSide?: CanvasConnectionPortSide
  dataPort?: PortDefinition
}) | {
  kind: 'selection'
  id: string
  members: CanvasEntityRef[]
  portSide?: CanvasConnectionPortSide
}

export interface CanvasCreateNodeMenuState {
  sx: number
  sy: number
  world: CanvasPoint
  cascade: boolean
  source?: {
    endpoint: CanvasConnectionEndpoint
    side: CanvasConnectionPortSide
  }
  tipWorld?: CanvasPoint
}

export function connectionEndpointKey(endpoint: CanvasConnectionEndpoint): string {
  if (endpoint.kind !== 'selection') {
    return `${endpoint.kind}:${endpoint.id}:${endpoint.dataPort?.direction ?? ''}:${endpoint.dataPort?.key ?? ''}`
  }
  return `selection:${endpoint.members
    .map((member) => `${member.kind}:${member.id}`)
    .sort()
    .join('|')}`
}

export function connectionEndpointLabel(
  document: CanvasDocument,
  endpoint: CanvasConnectionEndpoint,
): string {
  if (endpoint.kind === 'selection') return `组合节点（${endpoint.members.length} 项）`
  if (endpoint.kind === 'collection') {
    return `集合“${document.collections.find((entry) => entry.id === endpoint.id)?.title ?? endpoint.id}”`
  }
  if (endpoint.kind === 'task') {
    return `任务“${document.tasks.find((entry) => entry.id === endpoint.id)?.title ?? endpoint.id}”`
  }
  const title = document.nodes.find((entry) => entry.id === endpoint.id)?.title ?? endpoint.id
  return endpoint.dataPort
    ? `节点“${title}”的 ${endpoint.dataPort.key} 端口`
    : `节点“${title}”`
}

export function connectionEndpointTitle(
  document: CanvasDocument,
  endpoint: CanvasConnectionEndpoint,
): string {
  if (endpoint.kind === 'selection') return `组合节点 · ${endpoint.members.length} 项`
  if (endpoint.kind === 'collection') {
    return document.collections.find((entry) => entry.id === endpoint.id)?.title ?? endpoint.id
  }
  if (endpoint.kind === 'task') {
    return document.tasks.find((entry) => entry.id === endpoint.id)?.title ?? endpoint.id
  }
  return document.nodes.find((entry) => entry.id === endpoint.id)?.title ?? endpoint.id
}
