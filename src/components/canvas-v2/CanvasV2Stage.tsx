import {
  Minus,
  Plus,
  ScanSearch,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  mergeSelectionV2,
  nextRovingKeyV2,
  normalizedBoundsV2,
  screenToWorldV2,
  selectionFromMarqueeV2,
  selectionKeyV2,
  updateSelectionV2,
  zoomCameraAtV2,
  type CanvasV2SelectableBounds,
  type CanvasV2ViewportRect,
} from '@/canvas-v2/interaction'
import { TASK_CHROME_LAYOUT_V2 } from '@/canvas-v2/layout'
import type {
  CanvasDocumentV2,
  CanvasEntityRef,
  CanvasNodeV2,
  CanvasTaskV2,
} from '@/canvas-v2/model'
import type { CanvasV2SelectionTarget } from '@/canvas-v2/persistence'
import type { CanvasBoundsV2, CanvasTaskViewV2 } from '@/canvas-v2/selectors'
import { useCanvasV2State, useCanvasV2Store } from '@/canvas-v2/hooks'
import { useThrottledAnnouncement } from '@/canvas-v2/useThrottledAnnouncement'
import CanvasV2NodeCard from './CanvasV2NodeCard'
import CanvasV2TaskGroup from './CanvasV2TaskGroup'

type Gesture =
  | {
      kind: 'pan'
      pointerId: number
      startX: number
      startY: number
      cameraX: number
      cameraY: number
      zoom: number
    }
  | {
      kind: 'marquee'
      pointerId: number
      startX: number
      startY: number
      startWorld: { x: number; y: number }
      camera: { x: number; y: number; zoom: number }
      viewport: CanvasV2ViewportRect
      additive: boolean
    }
  | {
      kind: 'task' | 'node'
      pointerId: number
      id: string
      startX: number
      startY: number
      zoom: number
    }
  | {
      kind: 'resize'
      pointerId: number
      id: string
      startX: number
      startY: number
      zoom: number
      frame: CanvasNodeV2['frame']
    }

type GesturePreview =
  | { kind: 'task' | 'node'; id: string; dx: number; dy: number }
  | { kind: 'resize'; id: string; frame: CanvasNodeV2['frame'] }
  | null

export default function CanvasV2Stage() {
  const store = useCanvasV2Store()
  const state = useCanvasV2State()
  const stateRef = useRef(state)
  const stageRef = useRef<HTMLDivElement>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const focusableRefs = useRef(new Map<string, HTMLButtonElement>())
  const [preview, setPreview] = useState<GesturePreview>(null)
  const [marquee, setMarquee] = useState<CanvasBoundsV2 | null>(null)
  const [rovingKey, setRovingKey] = useState<string | null>(null)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  const taskViews = state.document.tasks
    .map((task) => store.selectTaskView(task.id))
    .filter((view): view is CanvasTaskViewV2 => view !== null)
  const taskViewsById = useMemo(
    () => new Map(taskViews.map((view) => [view.task.id, view])),
    [taskViews],
  )
  const topLevelNodes = state.document.nodes.filter((node) => !node.homeTaskId)
  const selectedTaskIds = new Set(state.view.selection
    .filter((target) => target.kind === 'task')
    .map((target) => target.id))
  const selectedNodeIds = new Set(state.view.selection
    .filter((target) => target.kind === 'node')
    .map((target) => target.id))

  const focusableKeys = taskViews.flatMap((view) => [
    `task:${view.task.id}`,
    ...(view.presentation === 'collapsed'
      ? []
      : view.nodes.map((node) => `node:${node.id}`)),
  ]).concat(topLevelNodes.map((node) => `node:${node.id}`))
  const selectedFocusableKey = state.view.selection
    .map(selectionKeyV2)
    .find((key) => focusableKeys.includes(key))
  const activeKey = rovingKey && focusableKeys.includes(rovingKey)
    ? rovingKey
    : selectedFocusableKey ?? focusableKeys[0] ?? null

  const registerFocusable = useCallback((key: string, element: HTMLButtonElement | null) => {
    if (element) focusableRefs.current.set(key, element)
    else focusableRefs.current.delete(key)
  }, [])

  const selectTarget = useCallback((
    target: CanvasV2SelectionTarget,
    additive: boolean,
  ) => {
    store.setSelection(updateSelectionV2(stateRef.current.view.selection, target, additive))
    setRovingKey(selectionKeyV2(target))
  }, [store])

  const selectTask = useCallback((task: CanvasTaskV2, additive: boolean) => {
    selectTarget({ kind: 'task', id: task.id }, additive)
  }, [selectTarget])

  const viewportRect = useCallback((): CanvasV2ViewportRect => {
    const rect = stageRef.current?.getBoundingClientRect()
    return {
      left: rect?.left ?? 0,
      top: rect?.top ?? 0,
      width: rect?.width ?? 0,
      height: rect?.height ?? 0,
    }
  }, [])

  const beginGesture = useCallback((gesture: Gesture, target: HTMLElement) => {
    gestureRef.current = gesture
    setPreview(null)
    try {
      target.setPointerCapture(gesture.pointerId)
    } catch {
      // jsdom and older embedded browsers may not implement pointer capture.
    }
  }, [])

  const beginTaskDrag = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    task: CanvasTaskV2,
  ) => {
    if (event.button !== 0) return
    event.stopPropagation()
    const key = `task:${task.id}`
    focusableRefs.current.get(key)?.focus({ preventScroll: true })
    selectTask(task, event.shiftKey)
    if (event.shiftKey) return
    beginGesture({
      kind: 'task',
      pointerId: event.pointerId,
      id: task.id,
      startX: event.clientX,
      startY: event.clientY,
      zoom: stateRef.current.view.camera.zoom,
    }, event.currentTarget)
  }, [beginGesture, selectTask])

  const beginNodeDrag = useCallback((
    event: ReactPointerEvent<HTMLButtonElement>,
    node: CanvasNodeV2,
  ) => {
    if (event.button !== 0) return
    event.stopPropagation()
    event.currentTarget.focus({ preventScroll: true })
    selectTarget({ kind: 'node', id: node.id }, event.shiftKey)
    if (event.shiftKey) return
    beginGesture({
      kind: 'node',
      pointerId: event.pointerId,
      id: node.id,
      startX: event.clientX,
      startY: event.clientY,
      zoom: stateRef.current.view.camera.zoom,
    }, event.currentTarget)
  }, [beginGesture, selectTarget])

  const beginNodeResize = useCallback((
    event: ReactPointerEvent<HTMLButtonElement>,
    node: CanvasNodeV2,
  ) => {
    if (event.button !== 0) return
    event.stopPropagation()
    beginGesture({
      kind: 'resize',
      pointerId: event.pointerId,
      id: node.id,
      startX: event.clientX,
      startY: event.clientY,
      zoom: stateRef.current.view.camera.zoom,
      frame: structuredClone(node.frame),
    }, event.currentTarget)
  }, [beginGesture])

  const selectable = useMemo((): CanvasV2SelectableBounds[] => {
    const values: CanvasV2SelectableBounds[] = []
    for (const view of taskViews) {
      values.push({
        target: { kind: 'task', id: view.task.id },
        bounds: taskInteractionBounds(view),
      })
      if (view.presentation === 'collapsed') continue
      for (const node of view.nodes) {
        values.push({ target: { kind: 'node', id: node.id }, bounds: node.frame })
      }
    }
    for (const node of topLevelNodes) {
      values.push({ target: { kind: 'node', id: node.id }, bounds: node.frame })
    }
    return values
  }, [taskViews, topLevelNodes])
  const selectableRef = useRef(selectable)
  useEffect(() => {
    selectableRef.current = selectable
  }, [selectable])

  useEffect(() => {
    const matchesPointer = (event: PointerEvent, gesture: Gesture) =>
      event.pointerId === undefined || event.pointerId === gesture.pointerId
    const deltaFor = (event: PointerEvent, gesture: Extract<Gesture, { kind: 'task' | 'node' }>) => ({
      dx: (event.clientX - gesture.startX) / gesture.zoom,
      dy: (event.clientY - gesture.startY) / gesture.zoom,
    })
    const resizeFrameFor = (
      event: PointerEvent,
      gesture: Extract<Gesture, { kind: 'resize' }>,
    ) => ({
      ...gesture.frame,
      w: Math.min(800, Math.max(220, gesture.frame.w
        + (event.clientX - gesture.startX) / gesture.zoom)),
      h: Math.min(640, Math.max(120, gesture.frame.h
        + (event.clientY - gesture.startY) / gesture.zoom)),
    })
    const onMove = (event: PointerEvent) => {
      const gesture = gestureRef.current
      if (!gesture || !matchesPointer(event, gesture)) return
      if (gesture.kind === 'pan') {
        store.setCamera({
          x: gesture.cameraX + event.clientX - gesture.startX,
          y: gesture.cameraY + event.clientY - gesture.startY,
          zoom: gesture.zoom,
        })
      } else if (gesture.kind === 'marquee') {
        const point = screenToWorldV2(event, gesture.camera, gesture.viewport)
        setMarquee(normalizedBoundsV2(gesture.startWorld, point))
      } else if (gesture.kind === 'resize') {
        setPreview({ kind: 'resize', id: gesture.id, frame: resizeFrameFor(event, gesture) })
      } else {
        setPreview({ kind: gesture.kind, id: gesture.id, ...deltaFor(event, gesture) })
      }
    }
    const onEnd = (event: PointerEvent, cancelled: boolean) => {
      const gesture = gestureRef.current
      if (!gesture || !matchesPointer(event, gesture)) return
      gestureRef.current = null
      if (cancelled) {
        setPreview(null)
        setMarquee(null)
        return
      }
      if (gesture.kind === 'task' || gesture.kind === 'node') {
        const delta = deltaFor(event, gesture)
        if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < 3) {
          setPreview(null)
          return
        }
        setPreview({ kind: gesture.kind, id: gesture.id, ...delta })
        const command = {
          type: 'MoveEntities' as const,
          entities: [{ kind: gesture.kind, id: gesture.id }],
          dx: delta.dx,
          dy: delta.dy,
        }
        void store.dispatchCommand(command).finally(() => setPreview((value) =>
          value?.kind === gesture.kind && value.id === gesture.id ? null : value))
        return
      }
      if (gesture.kind === 'resize') {
        const frame = resizeFrameFor(event, gesture)
        setPreview({ kind: 'resize', id: gesture.id, frame })
        void store.dispatchCommand({
          type: 'ResizeNode',
          nodeId: gesture.id,
          w: frame.w,
          h: frame.h,
        }).finally(() => setPreview((value) =>
          value?.kind === 'resize' && value.id === gesture.id ? null : value))
        return
      }
      if (gesture.kind === 'marquee') {
        const point = screenToWorldV2(event, gesture.camera, gesture.viewport)
        const bounds = normalizedBoundsV2(gesture.startWorld, point)
        setMarquee(null)
        if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < 4) return
        const hits = selectionFromMarqueeV2(selectableRef.current, bounds)
        store.setSelection(gesture.additive
          ? mergeSelectionV2(stateRef.current.view.selection, hits)
          : hits)
      }
    }
    const onUp = (event: PointerEvent) => onEnd(event, false)
    const onCancel = (event: PointerEvent) => onEnd(event, true)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [store])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const camera = stateRef.current.view.camera
      const factor = event.deltaY > 0 ? 0.92 : 1.09
      store.setCamera(zoomCameraAtV2(
        camera,
        viewportRect(),
        event,
        camera.zoom * factor,
      ))
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [store, viewportRect])

  const onStagePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('[data-v2-entity], [data-task-border], button, a, [data-no-drag]')) return
    stageRef.current?.focus({ preventScroll: true })
    const camera = stateRef.current.view.camera
    if (event.shiftKey) {
      const viewport = viewportRect()
      const startWorld = screenToWorldV2(event, camera, viewport)
      setMarquee({ x: startWorld.x, y: startWorld.y, w: 0, h: 0 })
      beginGesture({
        kind: 'marquee',
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startWorld,
        camera: { ...camera },
        viewport,
        additive: true,
      }, event.currentTarget)
      return
    }
    store.setSelection([])
    setRovingKey(null)
    beginGesture({
      kind: 'pan',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      cameraX: camera.x,
      cameraY: camera.y,
      zoom: camera.zoom,
    }, event.currentTarget)
  }

  const onEntityKeyDown = (key: string, event: KeyboardEvent<HTMLButtonElement>) => {
    const next = nextRovingKeyV2(focusableKeys, key, event.key)
    if (next !== key && next !== null) {
      event.preventDefault()
      setRovingKey(next)
      focusableRefs.current.get(next)?.focus({ preventScroll: true })
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const target = targetFromKey(next ?? key)
      if (target) selectTarget(target, event.shiftKey)
    }
  }

  const nodeFrames = new Map<string, CanvasBoundsV2>()
  if (preview?.kind === 'node') {
    const node = state.document.nodes.find((entry) => entry.id === preview.id)
    if (node) nodeFrames.set(node.id, {
      x: node.frame.x + preview.dx,
      y: node.frame.y + preview.dy,
      w: node.frame.w,
      h: node.frame.h,
    })
  } else if (preview?.kind === 'resize') {
    nodeFrames.set(preview.id, preview.frame)
  }

  const liveMessages = taskViews
    .map((view) => view.accessibility.liveMessage)
    .filter((message): message is string => Boolean(message))
  if (state.commandSync.status === 'conflict') liveMessages.push('画布同步发生冲突，需要处理')
  if (state.commandSync.status === 'error') liveMessages.push('画布同步失败')
  const liveAnnouncement = useThrottledAnnouncement(liveMessages.join('；'))
  const livePriority = taskViews.some((view) => view.accessibility.live === 'assertive')
    || state.commandSync.status === 'conflict'
    || state.commandSync.status === 'error'
    ? 'assertive'
    : 'polite'

  const zoomFromCenter = (factor: number) => {
    const camera = stateRef.current.view.camera
    const viewport = viewportRect()
    store.setCamera(zoomCameraAtV2(camera, viewport, {
      clientX: viewport.left + viewport.width / 2,
      clientY: viewport.top + viewport.height / 2,
    }, camera.zoom * factor))
  }

  return (
    <div
      ref={stageRef}
      role="application"
      aria-label="Canvas V2 画布"
      tabIndex={0}
      data-testid="canvas-v2-stage"
      className="absolute inset-0 overflow-hidden bg-gg-bg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gg-primary/25"
      style={{
        backgroundImage: 'radial-gradient(circle, #D9E2EC 1px, transparent 1px)',
        backgroundSize: `${26 * state.view.camera.zoom}px ${26 * state.view.camera.zoom}px`,
        backgroundPosition: `${state.view.camera.x}px ${state.view.camera.y}px`,
      }}
      onPointerDown={onStagePointerDown}
    >
      <div
        data-testid="canvas-v2-world"
        className="absolute left-0 top-0 origin-top-left"
        style={{
          transform: `translate(${state.view.camera.x}px, ${state.view.camera.y}px) scale(${state.view.camera.zoom})`,
        }}
      >
        <CanvasV2EdgeLayer
          document={state.document}
          taskViewsById={taskViewsById}
          preview={preview}
          nodeFrames={nodeFrames}
        />
        {taskViews.map((view) => (
          <CanvasV2TaskGroup
            key={view.task.id}
            view={view}
            projectDir={state.scope.projectDir}
            selectedTask={selectedTaskIds.has(view.task.id)}
            selectedNodeIds={selectedNodeIds}
            explicitlyCollapsed={state.view.collapsedTaskIds.includes(view.task.id)}
            activeKey={activeKey}
            offset={preview?.kind === 'task' && preview.id === view.task.id
              ? { dx: preview.dx, dy: preview.dy }
              : undefined}
            nodeFrames={nodeFrames}
            onSelectTask={selectTask}
            onToggleCollapsed={(taskId, collapsed) =>
              store.setTaskCollapsed(taskId, collapsed)}
            onTaskDragStart={beginTaskDrag}
            onNodeDragStart={beginNodeDrag}
            onNodeResizeStart={beginNodeResize}
            onEntityFocus={setRovingKey}
            onEntityKeyDown={onEntityKeyDown}
            registerFocusable={registerFocusable}
          />
        ))}
        {topLevelNodes.map((node) => (
          <CanvasV2NodeCard
            key={node.id}
            node={node}
            frame={nodeFrames.get(node.id)}
            projectDir={state.scope.projectDir}
            selected={selectedNodeIds.has(node.id)}
            tabIndex={activeKey === `node:${node.id}` ? 0 : -1}
            onFocus={() => setRovingKey(`node:${node.id}`)}
            onKeyDown={(event) => onEntityKeyDown(`node:${node.id}`, event)}
            onDragStart={beginNodeDrag}
            onResizeStart={beginNodeResize}
            registerFocusable={(element) => registerFocusable(`node:${node.id}`, element)}
          />
        ))}
        {marquee && (
          <div
            data-testid="canvas-v2-marquee"
            className="pointer-events-none absolute rounded-[4px] border border-gg-select bg-[#1769E0]/[0.06]"
            style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
          />
        )}
      </div>

      {state.document.tasks.length === 0 && state.document.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="rounded-[16px] border border-dashed border-gg-line bg-white/85 px-5 py-4 text-center">
            <ScanSearch size={20} className="mx-auto text-gg-muted" />
            <p className="mt-2 text-[12px] font-medium text-gg-ink">当前分支还没有任务</p>
          </div>
        </div>
      )}

      <div className="absolute bottom-4 right-4 flex items-center gap-1 rounded-[12px] border border-gg-line bg-gg-node p-1 shadow-sm">
        <button
          type="button"
          aria-label="缩小画布"
          onClick={() => zoomFromCenter(0.9)}
          className="flex h-8 w-8 items-center justify-center rounded-[8px] text-gg-muted hover:bg-gg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35 motion-reduce:transition-none"
        >
          <Minus size={14} />
        </button>
        <output className="min-w-12 text-center text-[10.5px] text-gg-muted" aria-label="当前缩放比例">
          {Math.round(state.view.camera.zoom * 100)}%
        </output>
        <button
          type="button"
          aria-label="放大画布"
          onClick={() => zoomFromCenter(1.1)}
          className="flex h-8 w-8 items-center justify-center rounded-[8px] text-gg-muted hover:bg-gg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35 motion-reduce:transition-none"
        >
          <Plus size={14} />
        </button>
      </div>

      <div
        aria-live={livePriority}
        aria-atomic="true"
        data-testid="canvas-v2-live-region"
        className="sr-only"
      >
        {liveAnnouncement}
      </div>
    </div>
  )
}

function taskInteractionBounds(view: CanvasTaskViewV2): CanvasBoundsV2 {
  if (view.presentation === 'collapsed') {
    return {
      x: view.task.anchor.x,
      y: view.task.anchor.y,
      w: TASK_CHROME_LAYOUT_V2.collapsedWidth,
      h: TASK_CHROME_LAYOUT_V2.collapsedHeight,
    }
  }
  if (view.containerKind === 'output-frame') return view.bounds
  if (view.containerKind === 'title-strip') {
    return {
      x: view.task.anchor.x,
      y: view.task.anchor.y,
      w: TASK_CHROME_LAYOUT_V2.titleStripWidth,
      h: TASK_CHROME_LAYOUT_V2.titleStripHeight,
    }
  }
  return {
    x: view.task.anchor.x,
    y: view.task.anchor.y,
    w: TASK_CHROME_LAYOUT_V2.cardWidth,
    h: view.presentation === 'compact'
      ? TASK_CHROME_LAYOUT_V2.compactHeight
      : TASK_CHROME_LAYOUT_V2.cardHeight,
  }
}

function targetFromKey(key: string): CanvasV2SelectionTarget | null {
  const separator = key.indexOf(':')
  if (separator < 1) return null
  const kind = key.slice(0, separator)
  const id = key.slice(separator + 1)
  if (!id || (kind !== 'task' && kind !== 'node')) return null
  return { kind, id }
}

function CanvasV2EdgeLayer({
  document,
  taskViewsById,
  preview,
  nodeFrames,
}: {
  document: CanvasDocumentV2
  taskViewsById: ReadonlyMap<string, CanvasTaskViewV2>
  preview: GesturePreview
  nodeFrames: ReadonlyMap<string, CanvasBoundsV2>
}) {
  const taskOffset = preview?.kind === 'task'
    ? { taskId: preview.id, dx: preview.dx, dy: preview.dy }
    : null
  const endpoint = (ref: CanvasEntityRef) => {
    if (ref.kind === 'task') {
      const task = document.tasks.find((entry) => entry.id === ref.id)
      if (!task) return null
      const offset = taskOffset && taskOffset.taskId === task.id
        ? taskOffset
        : { dx: 0, dy: 0 }
      return { x: task.anchor.x + 180 + offset.dx, y: task.anchor.y + 36 + offset.dy }
    }
    const node = document.nodes.find((entry) => entry.id === ref.id)
    if (!node) return null
    const taskView = node.homeTaskId ? taskViewsById.get(node.homeTaskId) : undefined
    if (taskView?.presentation === 'collapsed') {
      const offset = taskOffset && taskOffset.taskId === taskView.task.id
        ? taskOffset
        : { dx: 0, dy: 0 }
      return {
        x: taskView.task.anchor.x + TASK_CHROME_LAYOUT_V2.collapsedWidth - 36 + offset.dx,
        y: taskView.task.anchor.y + TASK_CHROME_LAYOUT_V2.collapsedHeight / 2 + offset.dy,
      }
    }
    const frame = nodeFrames.get(node.id) ?? node.frame
    const offset = taskOffset && taskOffset.taskId === node.homeTaskId
      ? taskOffset
      : { dx: 0, dy: 0 }
    return {
      x: frame.x + frame.w / 2 + offset.dx,
      y: frame.y + frame.h / 2 + offset.dy,
    }
  }
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute left-0 top-0 overflow-visible"
      width="1"
      height="1"
    >
      {document.edges.map((edge) => {
        const from = endpoint(edge.from)
        const to = endpoint(edge.to)
        if (!from || !to || Math.hypot(from.x - to.x, from.y - to.y) < 2) return null
        const curve = Math.max(48, Math.abs(to.x - from.x) * 0.35)
        const path = `M ${from.x} ${from.y} C ${from.x + curve} ${from.y}, ${to.x - curve} ${to.y}, ${to.x} ${to.y}`
        return (
          <path
            key={edge.id}
            d={path}
            fill="none"
            stroke={edge.origin.kind === 'agent' ? '#A7B8CE' : '#7DA7E8'}
            strokeWidth="1.4"
            strokeDasharray={edge.contextRole === 'none' ? '4 4' : undefined}
            vectorEffect="non-scaling-stroke"
          />
        )
      })}
    </svg>
  )
}
