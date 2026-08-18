import type { KeyboardEvent, PointerEvent } from 'react'
import {
  canvasNodeWorldFrame,
  canvasRootNode,
  type CanvasDocument,
  type CanvasNode,
} from '@/canvas/model'
import { deriveTaskStatus, type CanvasBounds, type CanvasTaskRuntime } from '@/canvas/selectors'
import { getPlugin } from '@/plugins/types'
import CanvasNodeCard from './CanvasNodeCard'

export default function CanvasLooseNodeLayer({
  document,
  roots,
  children,
  nodeFrames,
  projectDir,
  canvasBranch,
  selectedNodeIds,
  compoundSelectedNodeIds,
  compoundSelection,
  runtimeByTaskId,
  activeKey,
  onFocus,
  onKeyDown,
  onDragStart,
  onResizeStart,
  onMenuAction,
  onOpenIsolation,
  onSelectExecution,
  registerFocusable,
}: {
  document: CanvasDocument
  roots: CanvasNode[]
  children: CanvasNode[]
  nodeFrames: ReadonlyMap<string, CanvasBounds>
  projectDir: string
  canvasBranch: string
  selectedNodeIds: ReadonlySet<string>
  compoundSelectedNodeIds: ReadonlySet<string>
  compoundSelection: boolean
  runtimeByTaskId: Record<string, CanvasTaskRuntime | undefined>
  activeKey: string | null
  onFocus: (key: string) => void
  onKeyDown: (key: string, event: KeyboardEvent<HTMLButtonElement>) => void
  onDragStart: (event: PointerEvent<HTMLElement>, node: CanvasNode) => void
  onResizeStart: (event: PointerEvent<HTMLButtonElement>, node: CanvasNode) => void
  onMenuAction: (node: CanvasNode, action: string) => void
  onOpenIsolation: (node: CanvasNode) => void
  onSelectExecution: (nodeId: string, executionId: string | null) => void
  registerFocusable: (key: string, element: HTMLButtonElement | null) => void
}) {
  return <>{[...roots, ...children].map((node) => {
    const root = canvasRootNode(document, node)
    const taskId = root.homeTaskId
      ?? (root.origin.kind === 'agent-output' ? root.origin.taskId : undefined)
    const key = `node:${node.id}`
    return (
      <CanvasNodeCard
        key={node.id}
        node={node}
        frame={nodeFrames.get(node.id) ?? canvasNodeWorldFrame(document, node)}
        projectDir={projectDir}
        canvasBranch={canvasBranch}
        selected={selectedNodeIds.has(node.id)}
        compoundSelected={compoundSelection && compoundSelectedNodeIds.has(node.id)}
        taskStatus={taskId ? deriveTaskStatus(runtimeByTaskId[taskId]) : undefined}
        taskRunId={taskId ? runtimeByTaskId[taskId]?.runId : undefined}
        tabIndex={activeKey === key ? 0 : -1}
        onFocus={() => onFocus(key)}
        onKeyDown={(event) => onKeyDown(key, event)}
        onDragStart={onDragStart}
        onResizeStart={onResizeStart}
        onMenuAction={onMenuAction}
        onOpenIsolation={getPlugin(node.typeRef.id).containment.canHaveChildren
          ? onOpenIsolation
          : undefined}
        onSelectExecution={onSelectExecution}
        registerFocusable={(element) => registerFocusable(key, element)}
      />
    )
  })}</>
}
