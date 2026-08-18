import { canvasOrderKey, canvasOrderNumber, type CanvasEdge } from '@/canvas/model'
import type { CanvasConnectionEndpoint } from './CanvasConnectionState'

export type DataPortConnectionResult =
  | { handled: false }
  | { handled: true; error: string }
  | { handled: true; edge: CanvasEdge }

export function resolveDataPortConnection(input: {
  source: CanvasConnectionEndpoint
  target: CanvasConnectionEndpoint
  edges: readonly CanvasEdge[]
  edgeId: string
}): DataPortConnectionResult {
  const sourcePort = input.source.kind === 'node' ? input.source.dataPort : undefined
  const targetPort = input.target.kind === 'node' ? input.target.dataPort : undefined
  if (!sourcePort && !targetPort) return { handled: false }
  if (input.source.kind !== 'node'
    || input.target.kind !== 'node'
    || sourcePort?.direction !== 'output'
    || targetPort?.direction !== 'input') {
    return { handled: true, error: '数据连接必须从 output port 指向 input port' }
  }
  if (sourcePort.schema !== targetPort.schema) {
    return {
      handled: true,
      error: `端口类型不兼容：${sourcePort.schema} → ${targetPort.schema}`,
    }
  }
  const inbound = input.edges.filter((edge) => edge.relation === 'data'
    && edge.to.kind === 'node'
    && edge.to.id === input.target.id
    && edge.to.port === targetPort.key)
  if (targetPort.cardinality === 'one' && inbound.length > 0) {
    return { handled: true, error: `输入端口 ${targetPort.key} 只允许一条连接` }
  }
  const order = inbound.reduce(
    (maximum, edge) => Math.max(maximum, canvasOrderNumber(edge.orderKey ?? '')),
    -1,
  ) + 1
  return {
    handled: true,
    edge: {
      id: input.edgeId,
      from: { kind: 'node', id: input.source.id, port: sourcePort.key },
      to: { kind: 'node', id: input.target.id, port: targetPort.key },
      relation: 'data',
      contextRole: 'none',
      orderKey: canvasOrderKey(order),
      origin: { kind: 'user' },
    },
  }
}
