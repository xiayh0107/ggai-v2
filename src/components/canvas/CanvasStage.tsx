import {
  Minus,
  Plus,
  ScanSearch,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  MAX_CANVAS_EDGE_BATCH,
  type CanvasCommand,
} from '@/canvas/commands'
import {
  canonicalizeCanvasSelection,
  deriveUserConnectionSemantics,
  mergeSelection,
  nextRovingKey,
  normalizedBounds,
  screenToWorld,
  selectionFromMarquee,
  selectionKey,
  suppressNativeTextSelectionForCanvasGesture,
  updateSelection,
  zoomCameraAt,
  type CanvasSelectableBounds,
  type CanvasViewportRect,
} from '@/canvas/interaction'
import { COLLECTION_CHROME_LAYOUT } from '@/canvas/layout'
import {
  canvasEdgeTopologyIssue,
  type CanvasCollection,
  type CanvasDocument,
  type CanvasEdge,
  type CanvasEntityRef,
  type CanvasNode,
  type CanvasPoint,
  type CanvasTask,
} from '@/canvas/model'
import type { CanvasSelectionTarget } from '@/canvas/persistence'
import {
  deriveTaskStatus,
  selectCollectionBounds,
  selectCollectionMembers,
  selectTaskView,
  type CanvasBounds,
  type CanvasTaskView,
} from '@/canvas/selectors'
import { useCanvasState, useCanvasStore } from '@/canvas/hooks'
import { useThrottledAnnouncement } from '@/canvas/useThrottledAnnouncement'
import {
  getPlugin,
  nodeTypeActions,
  nodeTypeInitialPayload,
  nodeTypeMarks,
  toggleNodeTypeMark,
} from '@/plugins/types'
import CanvasCollectionFrame from './CanvasCollectionFrame'
import CanvasContextComposer from './CanvasContextComposer'
import {
  canvasContextComposerKey,
  nodeHasVisibleContent,
} from '@/canvas/contextComposer'
import {
  CanvasArtifactViewerContext,
  type CanvasArtifactViewerRequest,
} from '@/canvas/artifactViewerContext'
import {
  CanvasRunLogViewerContext,
  type CanvasRunLogViewerRequest,
} from '@/canvas/runLogViewerContext'
import CanvasArtifactViewer from './CanvasArtifactViewer'
import CanvasRunLogViewer from './CanvasRunLogViewer'
import CanvasEdgeLayer from './CanvasEdgeLayer'
import {
  collapsedCollectionBounds,
  edgeDraftCurvePath,
  edgeSemanticKey,
  relationLabel,
  taskInteractionBounds,
  visualEntityKey,
} from './CanvasEdgeLayer.utils'
import CanvasNodeCard from './CanvasNodeCard'
import {
  CanvasSelectionToolbar,
  CanvasSelectionWorldSurface,
} from './CanvasSelectionSurface'
import type { CanvasConnectionPortSide } from './CanvasConnectionPort'
import {
  connectionEndpointKey,
  connectionEndpointLabel,
  connectionEndpointTitle,
  type CanvasConnectionEndpoint as EdgeEndpoint,
  type CanvasCreateNodeMenuState as CreateNodeMenuState,
} from './CanvasConnectionState'
import CanvasTaskGroup from './CanvasTaskGroup'
import { canvasTaskChromeState } from './CanvasTaskChrome'
import CanvasCreateNodeMenu from './CanvasCreateNodeMenu'
import { useCanvasActionHistory } from './CanvasActionHistory'
import CanvasActionFeedback from './CanvasActionFeedback'
import {
  canonicalSelectionForState,
  clientCanvasId,
  compoundSelectionNodeBounds,
  errorMessage,
  expandedCollectionSelectionBounds,
  moveTargetsForSelection,
  pointInsideBounds,
  portCreatedNodeFrame,
  sameSelection,
  selectionCoverage,
  unionBounds,
} from './CanvasStage.logic'

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
      viewport: CanvasViewportRect
      additive: boolean
    }
  | {
      kind: 'task' | 'node' | 'collection'
      pointerId: number
      id: string
      startX: number
      startY: number
      zoom: number
    }
  | {
      kind: 'selection'
      pointerId: number
      startX: number
      startY: number
      zoom: number
      entities: CanvasEntityRef[]
      collectionIds: string[]
    }
  | {
      kind: 'resize'
      pointerId: number
      id: string
      startX: number
      startY: number
      zoom: number
      frame: CanvasNode['frame']
    }

type GesturePreview =
  | { kind: 'task' | 'node' | 'collection'; id: string; dx: number; dy: number }
  | {
      kind: 'selection'
      entities: CanvasEntityRef[]
      collectionIds: string[]
      dx: number
      dy: number
    }
  | { kind: 'resize'; id: string; frame: CanvasNode['frame'] }
  | null

interface CollectionView {
  collection: CanvasCollection
  bounds: CanvasBounds
  collapsed: boolean
  memberCount: number
  artifactCount: number
}

export default function CanvasStage() {
  const store = useCanvasStore()
  const state = useCanvasState()
  const stateRef = useRef(state)
  const stageRef = useRef<HTMLDivElement>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const focusableRefs = useRef(new Map<string, HTMLButtonElement>())
  const focusRestoreKeyRef = useRef<string | null>(null)
  const [preview, setPreview] = useState<GesturePreview>(null)
  const [marquee, setMarquee] = useState<CanvasBounds | null>(null)
  const [rovingKey, setRovingKey] = useState<string | null>(null)
  const [edgeDraft, setEdgeDraft] = useState<EdgeEndpoint | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [createMenu, setCreateMenu] = useState<CreateNodeMenuState | null>(null)
  // 右侧抽屉面板：产物查看与详细日志共用同一个位置，打开一个即替换另一个。
  const [sidePanel, setSidePanel] = useState<
    | { kind: 'artifact'; request: CanvasArtifactViewerRequest }
    | { kind: 'run-log'; request: CanvasRunLogViewerRequest }
    | null
  >(null)
  const [connectCursor, setConnectCursor] = useState<CanvasPoint | null>(null)
  const connectDragRef = useRef<{
    endpoint: EdgeEndpoint
    pointerId: number
    startX: number
    startY: number
    dragging: boolean
  } | null>(null)
  const connectDragCleanupRef = useRef<(() => void) | null>(null)
  const suppressPortClickRef = useRef(false)
  const onPortActivateRef = useRef<(endpoint: EdgeEndpoint) => void>(() => {})
  const edgeDraftRef = useRef<EdgeEndpoint | null>(null)
  const actionHistory = useCanvasActionHistory({
    document: state.document,
    store,
    stageRef,
    setNotice,
  })
  const {
    optimisticDocument: stageDocument,
    requestConfirmation,
    showUndoOffer,
    dispatchWithUndo,
    feedbackProps: actionFeedbackProps,
  } = actionHistory

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => () => {
    connectDragCleanupRef.current?.()
    connectDragCleanupRef.current = null
    connectDragRef.current = null
  }, [])


  useEffect(() => {
    if (!createMenu) return
    const onDown = (event: PointerEvent) => {
      const menu = stageRef.current?.querySelector('[data-create-node-menu]')
      if (menu && !menu.contains(event.target as Node)) setCreateMenu(null)
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setCreateMenu(null)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [createMenu])

  useEffect(() => {
    const selection = canonicalizeCanvasSelection(
      state.document,
      state.view.selection,
      {
        collapsedTaskIds: state.view.collapsedTaskIds,
        collapsedCollectionIds: state.view.collapsedCollectionIds,
      },
    )
    if (!sameSelection(selection, state.view.selection)) store.setSelection(selection)
  }, [
    state.document,
    state.view.collapsedCollectionIds,
    state.view.collapsedTaskIds,
    state.view.selection,
    store,
  ])

  const effectiveSelection = canonicalizeCanvasSelection(
    stageDocument,
    state.view.selection,
    {
      collapsedTaskIds: state.view.collapsedTaskIds,
      collapsedCollectionIds: state.view.collapsedCollectionIds,
    },
  )
  const selectionDraftId = effectiveSelection.map(selectionKey).sort().join('|')
  const currentEdgeDraft = edgeDraft?.kind === 'selection'
    && edgeDraft.id !== selectionDraftId
    ? null
    : edgeDraft
  // 供 beginNodeDrag 等渲染期回调读取最新的连接草稿（节点头部端口已移除，
  // 连接草稿进行中轻点另一个节点卡片即完成连接）。
  useEffect(() => {
    edgeDraftRef.current = currentEdgeDraft
  }, [currentEdgeDraft])
  useEffect(() => {
    if (edgeDraft?.kind !== 'selection' || edgeDraft.id === selectionDraftId) return
    const staleDraft = edgeDraft
    queueMicrotask(() => {
      setEdgeDraft((current) => current === staleDraft ? null : current)
    })
  }, [edgeDraft, selectionDraftId])
  const taskViews = stageDocument.tasks
    .map((task) => selectTaskView(stageDocument, task.id, {
      zoom: state.view.camera.zoom,
      selected: effectiveSelection.some((target) =>
        target.kind === 'task' && target.id === task.id),
      explicitlyCollapsed: state.view.collapsedTaskIds.includes(task.id),
      runtime: state.runtimeByTaskId[task.id],
    }))
    .filter((view): view is CanvasTaskView => view !== null)
  const taskViewsById = new Map(taskViews.map((view) => [view.task.id, view]))
  const collectionViews = stageDocument.collections.map((collection): CollectionView => {
    const members = selectCollectionMembers(stageDocument, collection.id)
    const childNodes = stageDocument.nodes.filter((node) =>
      node.homeTaskId !== undefined
      && members.tasks.some((task) => task.id === node.homeTaskId))
    return {
      collection,
      bounds: selectCollectionBounds(stageDocument, collection.id) ?? {
        x: collection.anchor.x,
        y: collection.anchor.y,
        w: COLLECTION_CHROME_LAYOUT.minimumWidth,
        h: COLLECTION_CHROME_LAYOUT.minimumHeight,
      },
      collapsed: state.view.collapsedCollectionIds.includes(collection.id),
      memberCount: members.tasks.length + members.nodes.length,
      artifactCount: new Set([...members.nodes, ...childNodes]
        .flatMap((node) => node.artifactRefs.map((artifact) =>
          `${artifact.runId}\u001f${artifact.artifactId}`))).size,
    }
  })
  const collectionViewsById = new Map(collectionViews.map((view) => [view.collection.id, view]))
  const collapsedCollectionIds = new Set(collectionViews
    .filter((view) => view.collapsed)
    .map((view) => view.collection.id))
  const hiddenTaskIds = new Set(stageDocument.tasks
    .filter((task) => task.collectionId && collapsedCollectionIds.has(task.collectionId))
    .map((task) => task.id))
  const visibleTaskViews = taskViews.filter((view) => !hiddenTaskIds.has(view.task.id))
  const topLevelNodes = stageDocument.nodes.filter((node) => !node.homeTaskId)
  const visibleTopLevelNodes = topLevelNodes.filter((node) =>
    !node.collectionId || !collapsedCollectionIds.has(node.collectionId))
  const selectedTaskIds = new Set(effectiveSelection
    .filter((target) => target.kind === 'task')
    .map((target) => target.id))
  const selectedNodeIds = new Set(effectiveSelection
    .filter((target) => target.kind === 'node')
    .map((target) => target.id))
  const selectedCollectionIds = new Set(effectiveSelection
    .filter((target) => target.kind === 'collection')
    .map((target) => target.id))

  const focusableKeys = collectionViews.map((view) => `collection:${view.collection.id}`)
    .concat(visibleTaskViews.flatMap((view) => [
    `task:${view.task.id}`,
    ...(view.presentation === 'collapsed'
      ? []
      : view.nodes.map((node) => `node:${node.id}`)),
    ])).concat(visibleTopLevelNodes.map((node) => `node:${node.id}`))
  const selectedFocusableKey = effectiveSelection
    .map(selectionKey)
    .find((key) => focusableKeys.includes(key))
  const activeKey = rovingKey && focusableKeys.includes(rovingKey)
    ? rovingKey
    : selectedFocusableKey ?? focusableKeys[0] ?? null

  const registerFocusable = useCallback((key: string, element: HTMLButtonElement | null) => {
    if (element) {
      focusableRefs.current.set(key, element)
      return
    }
    const previous = focusableRefs.current.get(key)
    if (previous && document.activeElement === previous) focusRestoreKeyRef.current = key
    focusableRefs.current.delete(key)
  }, [])

  useLayoutEffect(() => {
    const key = focusRestoreKeyRef.current
    if (!key) return
    focusRestoreKeyRef.current = null
    const replacement = focusableRefs.current.get(key)
    if (replacement?.isConnected && document.activeElement !== replacement) {
      replacement.focus({ preventScroll: true })
    }
  })

  const selectTarget = useCallback((
    target: CanvasSelectionTarget,
    additive: boolean,
  ) => {
    const current = stateRef.current
    const selection = updateSelection(current.view.selection, target, additive)
    store.setSelection(canonicalizeCanvasSelection(current.document, selection, {
      collapsedTaskIds: current.view.collapsedTaskIds,
      collapsedCollectionIds: current.view.collapsedCollectionIds,
    }))
    setRovingKey(selectionKey(target))
  }, [store])

  const selectTask = useCallback((task: CanvasTask, additive: boolean) => {
    selectTarget({ kind: 'task', id: task.id }, additive)
  }, [selectTarget])

  const selectCollection = useCallback((collection: CanvasCollection, additive: boolean) => {
    selectTarget({ kind: 'collection', id: collection.id }, additive)
  }, [selectTarget])

  const viewportRect = useCallback((): CanvasViewportRect => {
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

  const beginSelectionDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return false
    const current = stateRef.current
    const selection = canonicalizeCanvasSelection(current.document, current.view.selection, {
      collapsedTaskIds: current.view.collapsedTaskIds,
      collapsedCollectionIds: current.view.collapsedCollectionIds,
    })
    const targets = moveTargetsForSelection(selection)
    if (targets.entities.length + targets.collectionIds.length < 2) return false
    event.stopPropagation()
    beginGesture({
      kind: 'selection',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      zoom: stateRef.current.view.camera.zoom,
      ...targets,
    }, event.currentTarget)
    return true
  }, [beginGesture])

  const beginTaskDrag = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    task: CanvasTask,
  ) => {
    if (event.button !== 0) return
    event.stopPropagation()
    const key = `task:${task.id}`
    focusableRefs.current.get(key)?.focus({ preventScroll: true })
    const selection = canonicalSelectionForState(stateRef.current)
    const alreadySelected = selection.some((target) =>
      target.kind === 'task' && target.id === task.id)
    const coveredBySelection = selectionCoverage(
      stateRef.current.document,
      selection,
    ).taskIds.has(task.id)
    if (event.shiftKey) {
      suppressNativeTextSelectionForCanvasGesture(event, window.getSelection())
      selectTask(task, true)
      return
    }
    if ((alreadySelected || coveredBySelection) && selection.length > 1
      && beginSelectionDrag(event)) return
    selectTask(task, false)
    beginGesture({
      kind: 'task',
      pointerId: event.pointerId,
      id: task.id,
      startX: event.clientX,
      startY: event.clientY,
      zoom: stateRef.current.view.camera.zoom,
    }, event.currentTarget)
  }, [beginGesture, beginSelectionDrag, selectTask])

  const beginNodeDrag = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    node: CanvasNode,
  ) => {
    if (event.button !== 0) return
    event.stopPropagation()
    // 连接草稿进行中：轻点另一个节点卡片即完成连接（节点头部端口已移除）
    const pendingDraft = edgeDraftRef.current
    if (pendingDraft && !(pendingDraft.kind === 'node' && pendingDraft.id === node.id)) {
      onPortActivateRef.current({ kind: 'node', id: node.id })
      return
    }
    event.currentTarget.focus({ preventScroll: true })
    const selection = canonicalSelectionForState(stateRef.current)
    const alreadySelected = selection.some((target) =>
      target.kind === 'node' && target.id === node.id)
    const coveredBySelection = selectionCoverage(
      stateRef.current.document,
      selection,
    ).nodeIds.has(node.id)
    if (event.shiftKey) {
      suppressNativeTextSelectionForCanvasGesture(event, window.getSelection())
      selectTarget({ kind: 'node', id: node.id }, true)
      return
    }
    if ((alreadySelected || coveredBySelection) && selection.length > 1
      && beginSelectionDrag(event)) return
    selectTarget({ kind: 'node', id: node.id }, false)
    beginGesture({
      kind: 'node',
      pointerId: event.pointerId,
      id: node.id,
      startX: event.clientX,
      startY: event.clientY,
      zoom: stateRef.current.view.camera.zoom,
    }, event.currentTarget)
  }, [beginGesture, beginSelectionDrag, selectTarget])

  // 单产物任务隐藏标题条时的节点拖拽：选中节点、但整体移动任务（含任务锚点），
  // 避免节点与任务的后续产物位置脱节。
  const beginSoloTaskNodeDrag = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    node: CanvasNode,
    task: CanvasTask,
  ) => {
    if (event.button !== 0) return
    event.stopPropagation()
    // 连接草稿进行中：轻点另一个节点卡片即完成连接（与 beginNodeDrag 同一规则）
    const pendingDraft = edgeDraftRef.current
    if (pendingDraft && !(pendingDraft.kind === 'node' && pendingDraft.id === node.id)) {
      onPortActivateRef.current({ kind: 'node', id: node.id })
      return
    }
    event.currentTarget.focus({ preventScroll: true })
    const selection = canonicalSelectionForState(stateRef.current)
    if (event.shiftKey) {
      suppressNativeTextSelectionForCanvasGesture(event, window.getSelection())
      selectTarget({ kind: 'node', id: node.id }, true)
      return
    }
    const coveredBySelection = selectionCoverage(
      stateRef.current.document,
      selection,
    ).nodeIds.has(node.id)
    if (coveredBySelection && selection.length > 1
      && beginSelectionDrag(event)) return
    selectTarget({ kind: 'node', id: node.id }, false)
    beginGesture({
      kind: 'task',
      pointerId: event.pointerId,
      id: task.id,
      startX: event.clientX,
      startY: event.clientY,
      zoom: stateRef.current.view.camera.zoom,
    }, event.currentTarget)
  }, [beginGesture, beginSelectionDrag, selectTarget])

  const beginCollectionDrag = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    collection: CanvasCollection,
  ) => {
    if (event.button !== 0) return
    event.stopPropagation()
    event.currentTarget.focus({ preventScroll: true })
    const selection = canonicalSelectionForState(stateRef.current)
    const alreadySelected = selection.some((target) =>
      target.kind === 'collection' && target.id === collection.id)
    if (event.shiftKey) {
      suppressNativeTextSelectionForCanvasGesture(event, window.getSelection())
      selectCollection(collection, true)
      return
    }
    if (alreadySelected && selection.length > 1
      && beginSelectionDrag(event)) return
    selectCollection(collection, false)
    beginGesture({
      kind: 'collection',
      pointerId: event.pointerId,
      id: collection.id,
      startX: event.clientX,
      startY: event.clientY,
      zoom: stateRef.current.view.camera.zoom,
    }, event.currentTarget)
  }, [beginGesture, beginSelectionDrag, selectCollection])

  const beginNodeResize = useCallback((
    event: ReactPointerEvent<HTMLButtonElement>,
    node: CanvasNode,
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

  const selectable = (() : CanvasSelectableBounds[] => {
    const values: CanvasSelectableBounds[] = collectionViews.map((view) => ({
      target: { kind: 'collection', id: view.collection.id },
      // Expanded Collection interiors contain independently selectable members;
      // only its header chrome participates in marquee hit-testing.
      bounds: view.collapsed
        ? collapsedCollectionBounds(view.collection)
        : expandedCollectionSelectionBounds(view.bounds),
    }))
    for (const view of visibleTaskViews) {
      values.push({
        target: { kind: 'task', id: view.task.id },
        bounds: taskInteractionBounds(view),
      })
      if (view.presentation === 'collapsed') continue
      for (const node of view.nodes) {
        values.push({ target: { kind: 'node', id: node.id }, bounds: node.frame })
      }
    }
    for (const node of visibleTopLevelNodes) {
      values.push({ target: { kind: 'node', id: node.id }, bounds: node.frame })
    }
    return values
  })()
  const selectableRef = useRef(selectable)
  useEffect(() => {
    selectableRef.current = selectable
  }, [selectable])

  useEffect(() => {
    const matchesPointer = (event: PointerEvent, gesture: Gesture) =>
      event.pointerId === undefined || event.pointerId === gesture.pointerId
    const deltaFor = (
      event: PointerEvent,
      gesture: Extract<Gesture, { kind: 'task' | 'node' | 'collection' | 'selection' }>,
    ) => ({
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
        const point = screenToWorld(event, gesture.camera, gesture.viewport)
        setMarquee(normalizedBounds(gesture.startWorld, point))
      } else if (gesture.kind === 'resize') {
        setPreview({ kind: 'resize', id: gesture.id, frame: resizeFrameFor(event, gesture) })
      } else if (gesture.kind === 'selection') {
        setPreview({
          kind: 'selection',
          entities: gesture.entities,
          collectionIds: gesture.collectionIds,
          ...deltaFor(event, gesture),
        })
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
      if (gesture.kind === 'selection') {
        const delta = deltaFor(event, gesture)
        if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < 3) {
          setPreview(null)
          return
        }
        setPreview({
          kind: 'selection',
          entities: gesture.entities,
          collectionIds: gesture.collectionIds,
          ...delta,
        })
        void store.dispatchCommand({
          type: 'MoveEntities',
          entities: gesture.entities,
          ...(gesture.collectionIds.length > 0
            ? { collectionIds: gesture.collectionIds }
            : {}),
          dx: delta.dx,
          dy: delta.dy,
        }).finally(() => setPreview((value) => value?.kind === 'selection' ? null : value))
        return
      }
      if (gesture.kind === 'task' || gesture.kind === 'node' || gesture.kind === 'collection') {
        const delta = deltaFor(event, gesture)
        if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < 3) {
          setPreview(null)
          return
        }
        setPreview({ kind: gesture.kind, id: gesture.id, ...delta })
        const command = {
          type: 'MoveEntities' as const,
          entities: gesture.kind === 'collection'
            ? []
            : [{ kind: gesture.kind, id: gesture.id }],
          ...(gesture.kind === 'collection' ? { collectionIds: [gesture.id] } : {}),
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
        const point = screenToWorld(event, gesture.camera, gesture.viewport)
        const bounds = normalizedBounds(gesture.startWorld, point)
        setMarquee(null)
        if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < 4) return
        const hits = selectionFromMarquee(selectableRef.current, bounds)
        const current = stateRef.current
        const selection = gesture.additive
          ? mergeSelection(current.view.selection, hits)
          : hits
        store.setSelection(canonicalizeCanvasSelection(current.document, selection, {
          collapsedTaskIds: current.view.collapsedTaskIds,
          collapsedCollectionIds: current.view.collapsedCollectionIds,
        }))
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
      // 光标在右侧面板（产物查看 / 详细日志）内时，滚轮留给面板自身滚动，不缩放画布
      if (event.target instanceof Element
        && event.target.closest('[data-canvas-side-panel]')) return
      event.preventDefault()
      const camera = stateRef.current.view.camera
      const factor = event.deltaY > 0 ? 0.92 : 1.09
      store.setCamera(zoomCameraAt(
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
    if (target.closest('[data-canvas-entity], [data-task-border], button, a, [data-no-drag]')) return
    const camera = stateRef.current.view.camera
    if (compoundSelection && selectionSurfaceBounds) {
      const point = screenToWorld(event, camera, viewportRect())
      if (pointInsideBounds(point, selectionSurfaceBounds)
        && beginSelectionDrag(event)) return
    }
    stageRef.current?.focus({ preventScroll: true })
    if (event.shiftKey) {
      suppressNativeTextSelectionForCanvasGesture(event, window.getSelection())
      const viewport = viewportRect()
      const startWorld = screenToWorld(event, camera, viewport)
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
    const next = nextRovingKey(focusableKeys, key, event.key)
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

  const onStageKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || (!currentEdgeDraft && !connectDragRef.current)) return
    event.preventDefault()
    connectDragCleanupRef.current?.()
    connectDragCleanupRef.current = null
    connectDragRef.current = null
    suppressPortClickRef.current = false
    setConnectCursor(null)
    setEdgeDraft(null)
    setNotice('已取消连接')
  }

  const nodeFrames = new Map<string, CanvasBounds>()
  if (preview?.kind === 'node') {
    const node = stageDocument.nodes.find((entry) => entry.id === preview.id)
    if (node) nodeFrames.set(node.id, {
      x: node.frame.x + preview.dx,
      y: node.frame.y + preview.dy,
      w: node.frame.w,
      h: node.frame.h,
    })
  } else if (preview?.kind === 'resize') {
    nodeFrames.set(preview.id, preview.frame)
  } else if (preview?.kind === 'collection') {
    for (const node of stageDocument.nodes) {
      // Child nodes move through their parent TaskGroup transform.
      if (node.homeTaskId || node.collectionId !== preview.id) continue
      nodeFrames.set(node.id, {
        x: node.frame.x + preview.dx,
        y: node.frame.y + preview.dy,
        w: node.frame.w,
        h: node.frame.h,
      })
    }
  } else if (preview?.kind === 'selection') {
    const movingCollectionIds = new Set(preview.collectionIds)
    const movingTaskIds = new Set(preview.entities
      .filter((entity) => entity.kind === 'task')
      .map((entity) => entity.id))
    for (const task of stageDocument.tasks) {
      if (task.collectionId && movingCollectionIds.has(task.collectionId)) {
        movingTaskIds.add(task.id)
      }
    }
    const movingNodeIds = new Set(preview.entities
      .filter((entity) => entity.kind === 'node')
      .map((entity) => entity.id))
    for (const node of stageDocument.nodes) {
      if (node.homeTaskId && movingTaskIds.has(node.homeTaskId)) continue
      if (!movingNodeIds.has(node.id)
        && (!node.collectionId || !movingCollectionIds.has(node.collectionId))) continue
      nodeFrames.set(node.id, {
        x: node.frame.x + preview.dx,
        y: node.frame.y + preview.dy,
        w: node.frame.w,
        h: node.frame.h,
      })
    }
  }

  const contextSelectionBounds = (() => {
    const bounds = effectiveSelection.flatMap((target): CanvasBounds[] => {
      if (target.kind === 'node') {
        const node = stageDocument.nodes.find((entry) => entry.id === target.id)
        if (!node) return []
        const previewFrame = nodeFrames.get(node.id)
        const frame = previewFrame ?? node.frame
        const offset = previewFrame
          ? null
          : nodeParentPreviewOffset(node, stageDocument.tasks, preview)
        return [{
          ...frame,
          x: frame.x + (offset?.dx ?? 0),
          y: frame.y + (offset?.dy ?? 0),
        }]
      }
      if (target.kind === 'task') {
        const view = taskViewsById.get(target.id)
        if (!view) return []
        const frame = effectiveSelection.length > 1
          ? view.bounds
          : taskInteractionBounds(view)
        const offset = taskPreviewOffset(view.task, preview)
        return [{
          ...frame,
          x: frame.x + (offset?.dx ?? 0),
          y: frame.y + (offset?.dy ?? 0),
        }]
      }
      const view = collectionViewsById.get(target.id)
      if (!view) return []
      const frame = view.collapsed
        ? collapsedCollectionBounds(view.collection)
        : view.bounds
      const offset = collectionPreviewOffset(target.id, preview)
      return [{
        ...frame,
        x: frame.x + (offset?.dx ?? 0),
        y: frame.y + (offset?.dy ?? 0),
      }]
    })
    return bounds.length > 0 ? unionBounds(bounds) : null
  })()
  const compoundSelection = effectiveSelection.length > 1 && contextSelectionBounds !== null
  const compoundCoverage = selectionCoverage(stageDocument, effectiveSelection)
  const compoundSelectedTaskIds = new Set([
    ...selectedTaskIds,
    ...compoundCoverage.taskIds,
  ])
  const compoundSelectedNodeIds = new Set([
    ...selectedNodeIds,
    ...compoundCoverage.nodeIds,
  ])
  // Edge routing must use the exact same chrome decision as CanvasTaskGroup.
  // Otherwise restoring a selected single-output Task can briefly route its
  // external wires to the hidden title strip above the visible Node.
  const taskIdsWithoutTopChrome = new Set(visibleTaskViews
    .filter((view) => view.nodes.length > 0 && canvasTaskChromeState(view, {
      selectedTask: selectedTaskIds.has(view.task.id),
      compoundSelectedTask: compoundSelection && compoundSelectedTaskIds.has(view.task.id),
    }).noTopChrome)
    .map((view) => view.task.id))
  const selectionSurfaceBounds = contextSelectionBounds
    ? compoundSelection
      ? compoundSelectionNodeBounds(contextSelectionBounds)
      : contextSelectionBounds
    : null

  const collectionMembers = (collectionId: string): CanvasEntityRef[] => {
    const members = selectCollectionMembers(stateRef.current.document, collectionId)
    return [
      ...members.tasks.map((task) => ({ kind: 'task' as const, id: task.id })),
      ...members.nodes.map((node) => ({ kind: 'node' as const, id: node.id })),
    ]
  }
  const collectableSelection = effectiveSelection.flatMap((target): CanvasEntityRef[] => {
    if (target.kind === 'collection') return []
    if (target.kind === 'task') {
      const task = stageDocument.tasks.find((entry) => entry.id === target.id)
      return task && !task.collectionId ? [{ kind: 'task', id: task.id }] : []
    }
    const node = stageDocument.nodes.find((entry) => entry.id === target.id)
    return node && !node.homeTaskId && !node.collectionId
      ? [{ kind: 'node', id: node.id }]
      : []
  })
  const saveSelectionAsCollection = () => {
    if (collectableSelection.length < 2) return
    const id = clientCanvasId('collection')
    const memberBounds = collectableSelection.map((ref) => entityBounds(
      stageDocument,
      taskViewsById,
      ref,
    )).filter((bounds): bounds is CanvasBounds => bounds !== null)
    const bounds = unionBounds(memberBounds)
    const command: CanvasCommand = {
      type: 'CreateCollectionFromSelection',
      collection: {
        id,
        title: `集合 ${stageDocument.collections.length + 1}`,
        anchor: { x: bounds.x - 24, y: bounds.y - 56 },
      },
      members: collectableSelection,
    }
    void store.dispatchCommand(command).then(() => {
      focusRestoreKeyRef.current = `collection:${id}`
      store.setSelection([{ kind: 'collection', id }])
      setRovingKey(`collection:${id}`)
      showUndoOffer({
        label: '已保存为集合',
        undoCommands: [{ type: 'DissolveCollection', collectionId: id }],
      })
    }).catch((error: unknown) => setNotice(errorMessage(error)))
  }
  const requestTaskDeletion = (
    task: CanvasTask,
    withViews: boolean,
  ) => {
    const runtime = state.runtimeByTaskId[task.id]
    if (runtime && ['queued', 'running', 'awaiting-permission'].includes(runtime.phase)) {
      setNotice(`任务“${task.title}”仍在运行，需要先取消并等待 daemon 确认`)
      return
    }
    requestConfirmation({
      title: withViews ? '从画布移除任务和输出节点？' : '解除任务关系？',
      detail: withViews
        ? '任务卡、所有输出节点和关联连线将从画布移除。生成内容会保留在资源库的“生成内容”中，历史运行记录也不会删除。'
        : '任务卡和关联连线将从画布移除，输出节点会保留在画布并成为独立节点。生成内容和历史运行记录不会删除。',
      confirmLabel: withViews ? '从画布移除任务和输出' : '解除任务关系',
      successLabel: withViews
        ? '已从画布移除任务和输出节点，生成内容已保留在资源库'
        : '已解除任务关系，输出节点仍保留在画布',
      command: withViews
        ? { type: 'DeleteTaskAndViews', taskId: task.id }
        : { type: 'DeleteTask', taskId: task.id },
    })
  }
  const onTaskMenuAction = (task: CanvasTask, action: string) => {
    if (action === 'duplicate') {
      const newTaskId = clientCanvasId('task')
      dispatchWithUndo({
        type: 'DuplicateTaskAsDraft',
        sourceTaskId: task.id,
        newTaskId,
        offset: { x: 64, y: 64 },
      }, '已复制草稿任务', [{ type: 'DeleteTask', taskId: newTaskId }])
    } else if (action === 'remove-collection' && task.collectionId) {
      dispatchWithUndo({
        type: 'RemoveFromCollection',
        collectionId: task.collectionId,
        members: [{ kind: 'task', id: task.id }],
      }, '任务已移出集合', [{
        type: 'AssignToCollection',
        collectionId: task.collectionId,
        members: [{ kind: 'task', id: task.id }],
      }])
    } else if (action === 'delete') requestTaskDeletion(task, false)
    else if (action === 'delete-views') requestTaskDeletion(task, true)
  }
  const onNodeMenuAction = (node: CanvasNode, action: string) => {
    if (action === 'duplicate') {
      const newNodeId = clientCanvasId('node')
      dispatchWithUndo({
        type: 'DuplicateNode',
        sourceNodeId: node.id,
        newNodeId,
        offset: { x: 48, y: 48 },
      }, '已复制节点', [{ type: 'DeleteNode', nodeId: newNodeId }])
    } else if (action === 'detach-task' && node.homeTaskId) {
      dispatchWithUndo({
        type: 'DetachNodeFromTask',
        nodeId: node.id,
      }, '节点已移出任务', [{
        type: 'AssignNodeToTask',
        nodeId: node.id,
        taskId: node.homeTaskId,
      }])
    } else if (action === 'remove-collection' && node.collectionId) {
      dispatchWithUndo({
        type: 'RemoveFromCollection',
        collectionId: node.collectionId,
        members: [{ kind: 'node', id: node.id }],
      }, '节点已移出集合', [{
        type: 'AssignToCollection',
        collectionId: node.collectionId,
        members: [{ kind: 'node', id: node.id }],
      }])
    } else if (action === 'delete') {
      const removesEmptyOwnerTask = Boolean(
        node.homeTaskId
        && stageDocument.tasks.some((task) => task.id === node.homeTaskId)
        && stageDocument.nodes.filter((entry) => entry.homeTaskId === node.homeTaskId).length === 1,
      )
      const keepsArtifacts = node.artifactRefs.length > 0
      requestConfirmation({
        title: '从画布移除节点？',
        detail: [
          '节点和关联连线将从画布移除。',
          removesEmptyOwnerTask ? '它是任务的最后一个节点，空任务外壳也会一并移除。' : '',
          keepsArtifacts ? '生成内容会保留在资源库的“生成内容”中，可继续查看和下载。' : '历史运行记录仍会保留。',
        ].filter(Boolean).join(''),
        confirmLabel: '从画布移除',
        successLabel: keepsArtifacts
          ? '已从画布移除，生成内容已保留在资源库'
          : '已从画布移除节点',
        command: { type: 'DeleteNode', nodeId: node.id },
        commitImmediately: true,
      })
    }
  }
  const onCollectionMenuAction = (collection: CanvasCollection, action: string) => {
    const members = collectionMembers(collection.id)
    if (action === 'add-selection' && collectableSelection.length > 0) {
      const selectedMembers = structuredClone(collectableSelection)
      dispatchWithUndo({
        type: 'AssignToCollection',
        collectionId: collection.id,
        members: selectedMembers,
      }, '已加入集合', [{
        type: 'RemoveFromCollection',
        collectionId: collection.id,
        members: selectedMembers,
      }])
    } else if (action === 'duplicate') {
      const newCollectionId = clientCanvasId('collection')
      dispatchWithUndo({
        type: 'DuplicateCollection',
        sourceCollectionId: collection.id,
        newCollectionId,
        offset: { x: 72, y: 72 },
      }, '已复制集合', [{
        type: 'DeleteCollectionAndContents',
        collectionId: newCollectionId,
      }])
    } else if (action === 'dissolve') {
      dispatchWithUndo({
        type: 'DissolveCollection',
        collectionId: collection.id,
      }, '集合已解散', [{
        type: 'CreateCollectionFromSelection',
        collection: structuredClone(collection),
        members,
      }])
    } else if (action === 'delete-contents') {
      requestConfirmation({
        title: '删除集合及内容？',
        detail: `将删除集合“${collection.title}”及 ${members.length} 个顶层成员。此动作会先提供撤销窗口。`,
        confirmLabel: '删除集合及内容',
        command: { type: 'DeleteCollectionAndContents', collectionId: collection.id },
      })
    }
  }
  const expandEndpoint = (endpoint: EdgeEndpoint): CanvasEntityRef[] => {
    if (endpoint.kind === 'collection') return collectionMembers(endpoint.id)
    if (endpoint.kind === 'selection') return endpoint.members
    return [{ kind: endpoint.kind, id: endpoint.id }]
  }
  const onPortActivate = (endpoint: EdgeEndpoint) => {
    if (!currentEdgeDraft) {
      setEdgeDraft(endpoint)
      setNotice(`已选择${connectionEndpointLabel(stageDocument, endpoint)}作为连接起点`)
      return
    }
    if (connectionEndpointKey(currentEdgeDraft) === connectionEndpointKey(endpoint)) {
      setEdgeDraft(null)
      setNotice('已取消连接')
      return
    }
    const fromEndpoints = expandEndpoint(currentEdgeDraft)
    const toEndpoints = expandEndpoint(endpoint)
    if (fromEndpoints.length * toEndpoints.length > MAX_CANVAS_EDGE_BATCH) {
      setNotice(
        `这次操作会生成超过 ${MAX_CANVAS_EDGE_BATCH} 条连接；请缩小选择范围或分批连接`,
      )
      return
    }
    const pairs = fromEndpoints.flatMap((from) =>
      toEndpoints.map((to) => ({ from, to })))
    const existing = new Set(stageDocument.edges.map((edge) => edgeSemanticKey(edge)))
    const edges = pairs.flatMap(({ from, to }) => {
      const semantics = deriveUserConnectionSemantics(from, to)
      const candidate = {
        from,
        to,
        ...semantics,
      }
      if (canvasEdgeTopologyIssue(candidate)) return []
      const key = edgeSemanticKey(candidate)
      if (existing.has(key)) return []
      existing.add(key)
      return [{
        id: clientCanvasId('edge'),
        ...candidate,
        origin: { kind: 'user' as const },
      }]
    })
    if (edges.length === 0) {
      setNotice('这两个对象暂时无法连接，或连接已经存在')
      return
    }
    void store.dispatchCommand({ type: 'CreateEdges', edges }).then(() => {
      setEdgeDraft(null)
      showUndoOffer({
        label: edges.length === 1
          ? `已创建${relationLabel(edges[0]!.relation)}连接`
          : `已创建 ${edges.length} 条连接`,
        undoCommands: [{ type: 'DeleteEdges', edgeIds: edges.map((edge) => edge.id) }],
      })
    }).catch((error: unknown) => setNotice(errorMessage(error)))
  }
  // 拖拽连线在 window pointerup 里完成，需要绕开渲染闭包拿到最新的 onPortActivate。
  useEffect(() => {
    onPortActivateRef.current = onPortActivate
  })

  const temporarySelectionMembers = (() => {
    if (!compoundSelection) return []
    const members = effectiveSelection.flatMap((target): CanvasEntityRef[] => {
      if (target.kind === 'collection') {
        const entries = selectCollectionMembers(stageDocument, target.id)
        return [
          ...entries.tasks.map((task) => ({ kind: 'task' as const, id: task.id })),
          ...entries.nodes.map((node) => ({ kind: 'node' as const, id: node.id })),
        ]
      }
      return [{ kind: target.kind, id: target.id }]
    })
    return [...new Map(members.map((member) => [
      `${member.kind}:${member.id}`,
      member,
    ])).values()]
  })()
  const temporarySelectionEndpoint: EdgeEndpoint | null = compoundSelection
    && temporarySelectionMembers.length > 0
    ? {
        kind: 'selection',
        id: effectiveSelection.map(selectionKey).sort().join('|'),
        members: temporarySelectionMembers,
      }
    : null

  const liveMessages = taskViews
    .map((view) => view.accessibility.liveMessage)
    .filter((message): message is string => Boolean(message))
  if (state.commandSync.status === 'conflict') liveMessages.push('画布同步发生冲突，需要处理')
  if (state.commandSync.status === 'error') liveMessages.push('画布同步失败')
  if (notice) liveMessages.push(notice)
  const liveAnnouncement = useThrottledAnnouncement(liveMessages.join('；'))
  const livePriority = taskViews.some((view) => view.accessibility.live === 'assertive')
    || state.commandSync.status === 'conflict'
    || state.commandSync.status === 'error'
    ? 'assertive'
    : 'polite'

  const zoomFromCenter = (factor: number) => {
    const camera = stateRef.current.view.camera
    const viewport = viewportRect()
    store.setCamera(zoomCameraAt(camera, viewport, {
      clientX: viewport.left + viewport.width / 2,
      clientY: viewport.top + viewport.height / 2,
    }, camera.zoom * factor))
  }
  const contextComposerAnchor = () => {
    const camera = stateRef.current.view.camera
    const viewport = viewportRect()
    return screenToWorld({
      clientX: viewport.left + viewport.width / 2,
      clientY: viewport.top + viewport.height / 2,
    }, camera, viewport)
  }
  const selectedNodeForSurface = effectiveSelection.length === 1
    && effectiveSelection[0]?.kind === 'node'
    ? stageDocument.nodes.find((node) => node.id === effectiveSelection[0]?.id) ?? null
    : null
  const controlOwnerTaskForNode = (node: CanvasNode | null) => {
    if (!node?.homeTaskId) return null
    const task = stageDocument.tasks.find((entry) => entry.id === node.homeTaskId) ?? null
    if (!task) return null
    const runtime = state.runtimeByTaskId[task.id]
    const active = runtime?.phase === 'queued'
      || runtime?.phase === 'running'
      || runtime?.phase === 'awaiting-permission'
    return active || !nodeHasVisibleContent(node) ? task : null
  }
  // A Task keeps prompt/run control when its selected output Node is still
  // being produced, awaiting permission, or remains an empty owned slot after
  // any terminal state. This preserves the Node's visual selection without
  // exposing a second composer that would create an unrelated derived Task.
  const selectedNodeControlTask = controlOwnerTaskForNode(selectedNodeForSurface)
  const selectionControlOwnerTaskIds = new Set(
    effectiveSelection.flatMap((target) => {
      if (target.kind !== 'node') return []
      const node = stageDocument.nodes.find((entry) => entry.id === target.id) ?? null
      const task = controlOwnerTaskForNode(node)
      return task ? [task.id] : []
    }),
  )
  const selectionControlOwnerTaskId = selectionControlOwnerTaskIds.values().next().value
    ?? null
  // 单选节点的类型专属标记按钮（文本节点的粗体 / 斜体 / 标题），直接改写节点 payload。
  // 空输出槽（等待内容 / 生成中，无产物、无正文、无 payload）没有可作用的内容，
  // 类型专属工具条无意义——隐藏，生成结束、内容出现后再显示，也避免与提示指令控件重叠。
  const selectedNodeMarks = (() => {
    if (!selectedNodeForSurface || selectedNodeControlTask
      || !nodeHasVisibleContent(selectedNodeForSurface)) return []
    return nodeTypeMarks(getPlugin(selectedNodeForSurface.type), selectedNodeForSurface)
  })()
  const applyNodeMarkToggle = (node: CanvasNode, markId: string) => {
    const payload = toggleNodeTypeMark(getPlugin(node.type), node, markId)
    if (!payload) return
    const previousPayload = node.payload ? structuredClone(node.payload) : null
    void store.dispatchCommand({
      type: 'UpdateNodeContent',
      nodeId: node.id,
      patch: { payload },
    }).then(() => {
      showUndoOffer({
        label: '已更新文本标记',
        undoCommands: [{
          type: 'UpdateNodeContent',
          nodeId: node.id,
          patch: { payload: previousPayload },
        }],
      })
    }).catch((error: unknown) => setNotice(errorMessage(error)))
  }
  const toggleSelectedNodeMark = (markId: string) => {
    if (selectedNodeForSurface) applyNodeMarkToggle(selectedNodeForSurface, markId)
  }
  // 单选节点的类型专属快捷指令（图像节点的生成变体等），显示在选择工具条上；
  // 有标记按钮的类型（文本）不再重复显示指令 chips——它们留在输入区。
  const selectedNodeActions = (() => {
    if (!selectedNodeForSurface || selectedNodeControlTask
      || !nodeHasVisibleContent(selectedNodeForSurface)
      || selectedNodeMarks.length > 0) return []
    const plugin = getPlugin(selectedNodeForSurface.type)
    return nodeTypeActions(plugin).slice(0, 5)
  })()
  // 产物查看面板（右侧抽屉）的来源节点：为它提供同样的类型专属工具条。
  const sidePanelNode = sidePanel?.kind === 'artifact'
    ? (sidePanel.request.nodeId
        ? stageDocument.nodes.find((node) => node.id === sidePanel.request.nodeId) ?? null
        : stageDocument.nodes.find((node) => node.artifactRefs.some((ref) =>
          ref.runId === sidePanel.request.artifact.runId
          && ref.artifactId === sidePanel.request.artifact.artifactId,
        )) ?? null)
    : null
  const sidePanelNodeControlTask = controlOwnerTaskForNode(sidePanelNode)
  const sidePanelNodeActions = (() => {
    if (!sidePanelNode || sidePanelNodeControlTask) return []
    const plugin = getPlugin(sidePanelNode.type)
    if (nodeTypeMarks(plugin, sidePanelNode).length > 0) return []
    return nodeTypeActions(plugin).slice(0, 5)
  })()
  const fillComposerWithAction = (prompt: string) => {
    store.setComposerDraft(canvasContextComposerKey(effectiveSelection), prompt)
    focusContextComposer()
  }
  // 查看面板的快捷指令：先选中来源节点，再把指令填进它的输入区。
  const fillComposerForSidePanelNode = (node: CanvasNode, prompt: string) => {
    const target = [{ kind: 'node' as const, id: node.id }]
    setSidePanel(null)
    store.setSelection(target)
    store.setComposerDraft(canvasContextComposerKey(target), prompt)
    // 等选择生效、对应输入区渲染后再聚焦
    requestAnimationFrame(() => focusContextComposer())
  }
  const focusComposerForSidePanelNode = (node: CanvasNode) => {
    setSidePanel(null)
    store.setSelection([{ kind: 'node', id: node.id }])
    requestAnimationFrame(() => focusContextComposer())
  }
  const focusContextComposer = () => {
    stageRef.current?.querySelector<HTMLTextAreaElement>(
      '[data-testid="canvas-context-composer"] textarea',
    )?.focus({ preventScroll: true })
  }

  const clampMenuPosition = (sx: number, sy: number) => {
    const viewport = viewportRect()
    return {
      sx: Math.max(8, Math.min(sx, viewport.width - 216)),
      sy: Math.max(8, Math.min(sy, viewport.height - 420)),
    }
  }
  const onStageDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('[data-canvas-entity], [data-task-border], [data-collection-border], button, a, [data-no-drag]')) return
    // 双击空白只表示“创建节点”。阻止浏览器的默认选词行为，并清掉第二次
    // pointerdown 可能已经建立的临时 Selection，避免菜单出现后整列文字被高亮。
    event.preventDefault()
    window.getSelection()?.removeAllRanges()
    const stageRect = stageRef.current?.getBoundingClientRect()
    if (!stageRect) return
    const world = screenToWorld(event, stateRef.current.view.camera, viewportRect())
    const { sx, sy } = clampMenuPosition(
      event.clientX - stageRect.left,
      event.clientY - stageRect.top,
    )
    setCreateMenu({ sx, sy, world, cascade: false })
  }
  /** 点击选中节点的「+」端口：在该侧打开类型菜单，创建后自动接一条来源边。 */
  const openPortCreateMenu = (endpoint: EdgeEndpoint, side: CanvasConnectionPortSide) => {
    const frame = endpointRectForWire(endpoint)
    if (!frame) return
    const world: CanvasPoint = side === 'top'
      ? { x: frame.x + frame.w / 2, y: frame.y }
      : side === 'bottom'
        ? { x: frame.x + frame.w / 2, y: frame.y + frame.h }
        : side === 'left'
          ? { x: frame.x, y: frame.y + frame.h / 2 }
          : { x: frame.x + frame.w, y: frame.y + frame.h / 2 }
    const camera = stateRef.current.view.camera
    const { sx, sy } = clampMenuPosition(
      camera.x + world.x * camera.zoom + 10,
      camera.y + world.y * camera.zoom - 20,
    )
    setCreateMenu({ sx, sy, world, cascade: false, source: { endpoint, side } })
  }
  /** 命中的画布实体（节点卡片 / 任务 / 集合），用于拖线落点判定。 */
  const entityEndpointFromPoint = (hit: Element | null): EdgeEndpoint | null => {
    const element = hit?.closest('[data-canvas-entity], [data-task-id]')
    if (!element) return null
    const entityKind = element.getAttribute('data-canvas-entity')
    if (entityKind === 'node') {
      const id = element.getAttribute('data-node-id')
      return id ? { kind: 'node', id } : null
    }
    if (entityKind === 'collection') {
      const id = element.getAttribute('data-collection-id')
      return id ? { kind: 'collection', id } : null
    }
    const taskId = element.getAttribute('data-task-id')
    return taskId ? { kind: 'task', id: taskId } : null
  }
  /** 拖线起点实体的世界坐标包围盒（供临时虚线计算）。 */
  const endpointRectForWire = (endpoint: EdgeEndpoint): CanvasBounds | null => {
    if (endpoint.kind === 'node') {
      return nodeFrames.get(endpoint.id)
        ?? stageDocument.nodes.find((node) => node.id === endpoint.id)?.frame
        ?? null
    }
    if (endpoint.kind === 'task') {
      const view = taskViewsById.get(endpoint.id)
      return view ? taskInteractionBounds(view) : null
    }
    if (endpoint.kind === 'collection') {
      const view = collectionViewsById.get(endpoint.id)
      if (!view) return null
      return view.collapsed ? collapsedCollectionBounds(view.collection) : view.bounds
    }
    return contextSelectionBounds
  }
  /** 拖线松手后紧跟的 stray click 不应再触发端口点击逻辑。 */
  const consumeSuppressedPortClick = () => {
    if (!suppressPortClickRef.current) return false
    suppressPortClickRef.current = false
    return true
  }
  /**
   * 按住端口拖出一根线：拖到另一实体上松手完成连接；
   * 拖到空白松手在落点弹出新建节点菜单，菜单期间虚线保持，创建后变成真实连线。
   * 原位点击（位移 < 6px）不拦截，继续走端口的点击逻辑。
   */
  const beginConnectDrag = (
    endpoint: EdgeEndpoint,
    pointerEvent: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (connectDragRef.current) return
    connectDragRef.current = {
      endpoint,
      pointerId: pointerEvent.pointerId,
      startX: pointerEvent.clientX,
      startY: pointerEvent.clientY,
      dragging: false,
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('blur', onBlur)
      if (connectDragCleanupRef.current === cleanup) connectDragCleanupRef.current = null
    }
    const isActivePointer = (event: PointerEvent) => {
      const drag = connectDragRef.current
      return Boolean(drag && event.pointerId === drag.pointerId)
    }
    const onMove = (event: PointerEvent) => {
      if (!isActivePointer(event)) return
      const drag = connectDragRef.current
      if (!drag) return
      if (!drag.dragging) {
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return
        drag.dragging = true
        suppressPortClickRef.current = true
        setEdgeDraft(drag.endpoint)
      }
      setConnectCursor(screenToWorld(event, stateRef.current.view.camera, viewportRect()))
    }
    const onUp = (event: PointerEvent) => {
      if (!isActivePointer(event)) return
      cleanup()
      const drag = connectDragRef.current
      connectDragRef.current = null
      setConnectCursor(null)
      if (!drag?.dragging) return
      // stray click 在 pointerup 之后同步派发，随后恢复正常的端口点击。
      setTimeout(() => {
        suppressPortClickRef.current = false
      }, 0)
      const source = drag.endpoint
      const hit = typeof document.elementFromPoint === 'function'
        ? document.elementFromPoint(event.clientX, event.clientY)
        : null
      const target = entityEndpointFromPoint(hit)
      const sameAsSource = target !== null
        && source.kind !== 'selection'
        && target.kind === source.kind
        && target.id === source.id
      if (target && !sameAsSource) {
        onPortActivateRef.current(target)
        return
      }
      setEdgeDraft(null)
      if (!target) {
        const camera = stateRef.current.view.camera
        const tipWorld = screenToWorld(event, camera, viewportRect())
        const { sx, sy } = clampMenuPosition(
          camera.x + tipWorld.x * camera.zoom + 8,
          camera.y + tipWorld.y * camera.zoom - 20,
        )
        setCreateMenu({
          sx,
          sy,
          world: tipWorld,
          cascade: false,
          source: { endpoint: source, side: source.portSide ?? 'right' },
          tipWorld,
        })
        return
      }
      setNotice('已取消连接')
    }
    const cancel = (announce: boolean) => {
      cleanup()
      connectDragRef.current = null
      suppressPortClickRef.current = false
      setConnectCursor(null)
      setEdgeDraft(null)
      if (announce) setNotice('已取消连接')
    }
    const onCancel = (event: PointerEvent) => {
      if (isActivePointer(event)) cancel(true)
    }
    const onBlur = () => cancel(false)
    connectDragCleanupRef.current = cleanup
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', onBlur)
  }
  const createNodeOfType = (pluginId: string) => {
    const menu = createMenu
    setCreateMenu(null)
    const plugin = getPlugin(pluginId)
    const world = menu?.world ?? contextComposerAnchor()
    const cascade = menu?.cascade ? (stageDocument.nodes.length % 8) * 24 : 0
    const maxZ = stageDocument.nodes.reduce((z, node) => Math.max(z, node.frame.z), 0)
    const id = clientCanvasId('node')
    const sourceEndpoint = menu?.source?.endpoint
    const sourceFrame = sourceEndpoint ? endpointRectForWire(sourceEndpoint) : undefined
    const frame = sourceFrame && menu?.source
      ? menu.tipWorld
        ? {
            x: Math.round(menu.tipWorld.x - plugin.defaultWidth / 2),
            y: Math.round(menu.tipWorld.y - 40),
            w: plugin.defaultWidth,
            h: 256,
            z: maxZ + 1,
          }
        : portCreatedNodeFrame(sourceFrame, menu.source.side, plugin.defaultWidth)
      : {
          x: Math.round(world.x - plugin.defaultWidth / 2) + cascade,
          y: Math.round(world.y - 40) + cascade,
          w: plugin.defaultWidth,
          h: 256,
          z: maxZ + 1,
        }
    frame.z = maxZ + 1
    const node: CanvasNode = {
      id,
      type: plugin.id,
      frame,
      title: plugin.label,
      payload: nodeTypeInitialPayload(plugin),
      artifactRefs: [],
      origin: { kind: 'user' },
    }
    const sourceEntities = sourceEndpoint ? expandEndpoint(sourceEndpoint) : []
    const edges: CanvasEdge[] = sourceEntities.flatMap((from) => {
      const candidate = {
        from,
        to: { kind: 'node' as const, id },
        relation: 'source' as const,
        contextRole: 'full' as const,
      }
      return canvasEdgeTopologyIssue(candidate) ? [] : [{
        id: clientCanvasId('edge'),
        ...candidate,
        origin: { kind: 'user' },
      }]
    })
    const sourceTitle = sourceEndpoint
      ? connectionEndpointTitle(stageDocument, sourceEndpoint)
      : null
    void store.dispatchCommand({ type: 'CreateNode', node }).then(async () => {
      if (edges.length > 0) await store.dispatchCommand({ type: 'CreateEdges', edges })
      store.setSelection([{ kind: 'node', id }])
      setRovingKey(`node:${id}`)
      showUndoOffer({
        label: sourceTitle
          ? `已从“${sourceTitle}”创建${plugin.label}节点`
          : `已创建${plugin.label}节点`,
        undoCommands: [
          ...(edges.length > 0
            ? [{ type: 'DeleteEdges', edgeIds: edges.map((edge) => edge.id) } as CanvasCommand]
            : []),
          { type: 'DeleteNode', nodeId: id } as CanvasCommand,
        ],
      })
    }).catch((error: unknown) => setNotice(errorMessage(error)))
  }

  // 拖拽连线 / 菜单待建期间的临时虚线（世界坐标，与正式边同一套曲线）
  const connectWirePath = (() => {
    if (connectCursor && currentEdgeDraft) {
      const rect = endpointRectForWire(currentEdgeDraft)
      if (!rect) return null
      return edgeDraftCurvePath(
        rect,
        { x: connectCursor.x, y: connectCursor.y, w: 1, h: 1 },
        currentEdgeDraft.portSide,
      ).path
    }
    if (createMenu?.source && createMenu.tipWorld) {
      const rect = endpointRectForWire(createMenu.source.endpoint)
      if (!rect) return null
      return edgeDraftCurvePath(rect, {
        x: createMenu.tipWorld.x,
        y: createMenu.tipWorld.y,
        w: 1,
        h: 1,
      }, createMenu.source.side).path
    }
    return null
  })()

  return (
    <div
      ref={stageRef}
      role="region"
      aria-label="Canvas 画布"
      tabIndex={0}
      data-testid="canvas-stage"
      className="absolute inset-0 overflow-hidden bg-gg-bg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gg-primary/25"
      style={{
        backgroundImage: 'radial-gradient(circle, #D9E2EC 1px, transparent 1px)',
        backgroundSize: `${26 * state.view.camera.zoom}px ${26 * state.view.camera.zoom}px`,
        backgroundPosition: `${state.view.camera.x}px ${state.view.camera.y}px`,
      }}
      onPointerDown={onStagePointerDown}
      onDoubleClick={onStageDoubleClick}
      onKeyDown={onStageKeyDown}
    >
      <CanvasArtifactViewerContext.Provider value={(request) =>
        setSidePanel({ kind: 'artifact', request })}>
      <CanvasRunLogViewerContext.Provider value={(request) =>
        setSidePanel({ kind: 'run-log', request })}>
      <div
        data-testid="canvas-world"
        className="absolute left-0 top-0 origin-top-left"
        style={{
          transform: `translate(${state.view.camera.x}px, ${state.view.camera.y}px) scale(${state.view.camera.zoom})`,
        }}
      >
        {collectionViews.map((view) => (
          <CanvasCollectionFrame
            key={view.collection.id}
            collection={view.collection}
            bounds={view.bounds}
            collapsed={view.collapsed}
            selected={selectedCollectionIds.has(view.collection.id)}
            compoundSelected={compoundSelection
              && selectedCollectionIds.has(view.collection.id)}
            memberCount={view.memberCount}
            artifactCount={view.artifactCount}
            offset={collectionPreviewOffset(view.collection.id, preview) ?? undefined}
            tabIndex={activeKey === `collection:${view.collection.id}` ? 0 : -1}
            connectionActive={currentEdgeDraft?.kind === 'collection'
              && currentEdgeDraft.id === view.collection.id}
            canAddSelection={collectableSelection.length > 0}
            onFocus={() => setRovingKey(`collection:${view.collection.id}`)}
            onKeyDown={(event) => onEntityKeyDown(`collection:${view.collection.id}`, event)}
            onDragStart={beginCollectionDrag}
            onToggle={() => store.setCollectionCollapsed(view.collection.id, !view.collapsed)}
            onPortActivate={() => {
              if (consumeSuppressedPortClick()) return
              onPortActivate({
                kind: 'collection',
                id: view.collection.id,
              })
            }}
            onPortDragStart={(event) => beginConnectDrag(
              { kind: 'collection', id: view.collection.id },
              event,
            )}
            onMenuAction={(action) => onCollectionMenuAction(view.collection, action)}
            registerFocusable={(element) => registerFocusable(
              `collection:${view.collection.id}`,
              element,
            )}
          />
        ))}
        <CanvasEdgeLayer
          document={stageDocument}
          taskViewsById={taskViewsById}
          collectionViewsById={collectionViewsById}
          collapsedCollectionIds={collapsedCollectionIds}
          taskIdsWithoutTopChrome={taskIdsWithoutTopChrome}
          preview={preview}
          nodeFrames={nodeFrames}
          onDeleteEdges={(edgeIds) => {
            const deletable = edgeIds.flatMap((id) => {
              const edge = stageDocument.edges.find((candidate) => candidate.id === id)
              return edge?.origin.kind === 'user' ? [structuredClone(edge)] : []
            })
            if (deletable.length === 0) {
              setNotice('Agent 创建的连接不能由浏览器删除')
              return
            }
            dispatchWithUndo(
              { type: 'DeleteEdges', edgeIds: deletable.map((edge) => edge.id) },
              `已删除 ${deletable.length} 条连接`,
              [{ type: 'CreateEdges', edges: deletable }],
            )
          }}
        />
        {connectWirePath && (
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 overflow-visible"
            width="1"
            height="1"
          >
            <path
              d={connectWirePath}
              fill="none"
              stroke="#7DA7E8"
              strokeWidth="1.4"
              strokeDasharray="5 4"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}
        {selectionSurfaceBounds
          && (compoundSelection || effectiveSelection[0]?.kind === 'node') && (
          <CanvasSelectionWorldSurface
            bounds={selectionSurfaceBounds}
            compound={compoundSelection}
            showPorts={selectionControlOwnerTaskIds.size === 0}
            count={effectiveSelection.length}
            activePortSide={compoundSelection
              ? currentEdgeDraft?.kind === 'selection'
                && currentEdgeDraft.id === temporarySelectionEndpoint?.id
                ? currentEdgeDraft.portSide ?? null
                : null
              : currentEdgeDraft?.kind === 'node'
                && currentEdgeDraft.id === effectiveSelection[0]?.id
                ? currentEdgeDraft.portSide ?? null
                : null}
            onPortActivate={(side: CanvasConnectionPortSide) => {
              if (consumeSuppressedPortClick()) return
              if (compoundSelection && temporarySelectionEndpoint) {
                onPortActivate({ ...temporarySelectionEndpoint, portSide: side })
                return
              }
              const target = effectiveSelection[0]
              if (target?.kind !== 'node') return
              // 连接草稿进行中：点击端口完成连接；否则打开「从节点新建节点」菜单
              if (currentEdgeDraft) {
                onPortActivate({ ...target, portSide: side })
                return
              }
              openPortCreateMenu({ ...target, portSide: side }, side)
            }}
            onPortDragStart={(side: CanvasConnectionPortSide, event) => {
              if (compoundSelection && temporarySelectionEndpoint) {
                beginConnectDrag(
                  { ...temporarySelectionEndpoint, portSide: side },
                  event,
                )
                return
              }
              const target = effectiveSelection[0]
              if (target?.kind !== 'node') return
              beginConnectDrag({ ...target, portSide: side }, event)
            }}
          />
        )}
        {visibleTaskViews.map((view) => (
          <CanvasTaskGroup
            key={view.task.id}
            view={view}
            projectDir={state.scope.projectDir}
            selectedTask={selectedTaskIds.has(view.task.id)}
            taskRunId={state.runtimeByTaskId[view.task.id]?.runId}
            compoundSelectedTask={compoundSelection
              && compoundSelectedTaskIds.has(view.task.id)}
            compoundSelection={compoundSelection}
            zoom={state.view.camera.zoom}
            showRunPanel={(effectiveSelection.length === 1
              && selectedTaskIds.has(view.task.id))
              || selectionControlOwnerTaskIds.has(view.task.id)
              || view.status.kind === 'queued'
              || view.status.kind === 'generating'
              || view.status.kind === 'needs-attention'}
            selectedNodeIds={selectedNodeIds}
            compoundSelectedNodeIds={compoundSelectedNodeIds}
            explicitlyCollapsed={state.view.collapsedTaskIds.includes(view.task.id)}
            activeKey={activeKey}
            offset={taskPreviewOffset(view.task, preview)}
            nodeFrames={nodeFrames}
            onSelectTask={selectTask}
            onToggleCollapsed={(taskId, collapsed) =>
              store.setTaskCollapsed(taskId, collapsed)}
            onTaskDragStart={beginTaskDrag}
            onNodeDragStart={beginNodeDrag}
            onSoloTaskNodeDragStart={(event, node) =>
              beginSoloTaskNodeDrag(event, node, view.task)}
            onNodeResizeStart={beginNodeResize}
            onTaskPortActivate={(task) => {
              if (consumeSuppressedPortClick()) return
              onPortActivate({ kind: 'task', id: task.id })
            }}
            onTaskPortDragStart={(event, task) => beginConnectDrag(
              { kind: 'task', id: task.id },
              event,
            )}
            activeConnectionKey={currentEdgeDraft && currentEdgeDraft.kind !== 'selection'
              ? visualEntityKey(currentEdgeDraft)
              : null}
            onTaskMenuAction={onTaskMenuAction}
            onNodeMenuAction={onNodeMenuAction}
            onEntityFocus={setRovingKey}
            onEntityKeyDown={onEntityKeyDown}
            registerFocusable={registerFocusable}
          />
        ))}
        {visibleTopLevelNodes.map((node) => (
          <CanvasNodeCard
            key={node.id}
            node={node}
            frame={nodeFrames.get(node.id)}
            projectDir={state.scope.projectDir}
            selected={selectedNodeIds.has(node.id)}
            compoundSelected={compoundSelection && compoundSelectedNodeIds.has(node.id)}
            taskStatus={node.origin.kind === 'agent-output'
              ? deriveTaskStatus(state.runtimeByTaskId[node.origin.taskId])
              : undefined}
            taskRunId={node.origin.kind === 'agent-output'
              ? state.runtimeByTaskId[node.origin.taskId]?.runId
              : undefined}
            tabIndex={activeKey === `node:${node.id}` ? 0 : -1}
            onFocus={() => setRovingKey(`node:${node.id}`)}
            onKeyDown={(event) => onEntityKeyDown(`node:${node.id}`, event)}
            onDragStart={beginNodeDrag}
            onResizeStart={beginNodeResize}
            onMenuAction={onNodeMenuAction}
            registerFocusable={(element) => registerFocusable(`node:${node.id}`, element)}
          />
        ))}
        {marquee && (
          <div
            data-testid="canvas-marquee"
            className="pointer-events-none absolute rounded-[4px] border border-gg-select bg-[#1769E0]/[0.06]"
            style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
          />
        )}
      </div>

      {stageDocument.tasks.length === 0 && stageDocument.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="rounded-[16px] border border-dashed border-gg-line bg-white/85 px-5 py-4 text-center">
            <ScanSearch size={20} className="mx-auto text-gg-muted" />
            <p className="mt-2 text-[12px] font-medium text-gg-ink">当前分支还没有内容</p>
            <p className="mt-1 text-[10.5px] text-gg-muted">双击空白创建节点，或在下方描述一个任务</p>
          </div>
        </div>
      )}

      {createMenu && (
        <CanvasCreateNodeMenu
          x={createMenu.sx}
          y={createMenu.sy}
          sourceTitle={createMenu.source
            ? connectionEndpointTitle(stageDocument, createMenu.source.endpoint)
            : undefined}
          onSelect={createNodeOfType}
        />
      )}

      {selectionSurfaceBounds && selectionControlOwnerTaskIds.size === 0
        && (compoundSelection || selectedNodeForSurface) && (
        <CanvasSelectionToolbar
          bounds={selectionSurfaceBounds}
          camera={state.view.camera}
          compound={compoundSelection}
          canSaveCollection={collectableSelection.length >= 2}
          nodeActions={selectedNodeActions}
          nodeMarks={selectedNodeMarks}
          onFocusComposer={focusContextComposer}
          onNodeAction={fillComposerWithAction}
          onToggleNodeMark={toggleSelectedNodeMark}
          onDuplicate={selectedNodeForSurface
            ? () => onNodeMenuAction(selectedNodeForSurface, 'duplicate')
            : undefined}
          onDelete={selectedNodeForSurface
            ? () => onNodeMenuAction(selectedNodeForSurface, 'delete')
            : undefined}
          onSaveCollection={compoundSelection ? saveSelectionAsCollection : undefined}
          onClear={() => {
            store.setSelection([])
            setRovingKey(null)
            stageRef.current?.focus({ preventScroll: true })
          }}
        />
      )}

      <CanvasContextComposer
        getAnchor={contextComposerAnchor}
        selectionOverride={effectiveSelection}
        controlOwnerTaskId={selectionControlOwnerTaskId}
        selectionBounds={selectionSurfaceBounds}
        getViewport={viewportRect}
      />

      {currentEdgeDraft && (
        <div className="absolute left-4 top-4">
          <button
            type="button"
            aria-label="取消创建连接"
            onClick={() => {
              setEdgeDraft(null)
              setNotice('已取消连接')
            }}
            className="flex h-9 items-center gap-2 rounded-[10px] border border-gg-line bg-white px-3 text-[11px] font-medium text-gg-muted shadow-sm outline-none hover:bg-gg-subtle hover:text-gg-ink focus-visible:ring-2 focus-visible:ring-gg-primary/35"
          >
            <X size={13} aria-hidden="true" />
            取消连接
          </button>
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

      <CanvasActionFeedback {...actionFeedbackProps} />

      <div
        aria-live={livePriority}
        aria-atomic="true"
        data-testid="canvas-live-region"
        className="sr-only"
      >
        {liveAnnouncement}
      </div>
      </CanvasRunLogViewerContext.Provider>
      </CanvasArtifactViewerContext.Provider>
      {sidePanel?.kind === 'artifact' && (
        <CanvasArtifactViewer
          key={`${sidePanel.request.artifact.runId}:${sidePanel.request.artifact.artifactId}`}
          request={sidePanel.request}
          node={sidePanelNode ?? undefined}
          controlsLocked={Boolean(sidePanelNodeControlTask)}
          nodeActions={sidePanelNodeActions}
          onToggleNodeMark={sidePanelNode && !sidePanelNodeControlTask
            ? (markId) => applyNodeMarkToggle(sidePanelNode, markId)
            : undefined}
          onNodeAction={sidePanelNode && !sidePanelNodeControlTask
            ? (prompt) => fillComposerForSidePanelNode(sidePanelNode, prompt)
            : undefined}
          onFocusComposer={sidePanelNode && !sidePanelNodeControlTask
            ? () => focusComposerForSidePanelNode(sidePanelNode)
            : undefined}
          onDuplicate={sidePanelNode && !sidePanelNodeControlTask
            ? () => {
                setSidePanel(null)
                onNodeMenuAction(sidePanelNode, 'duplicate')
              }
            : undefined}
          onDelete={sidePanelNode && !sidePanelNodeControlTask
            ? () => {
                setSidePanel(null)
                onNodeMenuAction(sidePanelNode, 'delete')
              }
            : undefined}
          onClose={() => setSidePanel(null)}
        />
      )}
      {sidePanel?.kind === 'run-log' && (
        <CanvasRunLogViewer
          key={sidePanel.request.runId}
          request={sidePanel.request}
          onClose={() => setSidePanel(null)}
        />
      )}
    </div>
  )
}

function targetFromKey(key: string): CanvasSelectionTarget | null {
  const separator = key.indexOf(':')
  if (separator < 1) return null
  const kind = key.slice(0, separator)
  const id = key.slice(separator + 1)
  if (!id || (kind !== 'task' && kind !== 'node' && kind !== 'collection')) return null
  return { kind, id }
}

function taskPreviewOffset(
  task: CanvasTask,
  preview: GesturePreview,
): { dx: number; dy: number } | undefined {
  if (preview?.kind === 'task' && preview.id === task.id) return preview
  if (preview?.kind === 'collection' && preview.id === task.collectionId) return preview
  if (preview?.kind === 'selection') {
    if (preview.entities.some((entity) => entity.kind === 'task' && entity.id === task.id)
      || (task.collectionId && preview.collectionIds.includes(task.collectionId))) {
      return preview
    }
  }
  return undefined
}

function collectionPreviewOffset(
  collectionId: string,
  preview: GesturePreview,
): { dx: number; dy: number } | null {
  if (preview?.kind === 'collection' && preview.id === collectionId) return preview
  if (preview?.kind === 'selection' && preview.collectionIds.includes(collectionId)) return preview
  return null
}

function nodeParentPreviewOffset(
  node: CanvasNode,
  tasks: readonly CanvasTask[],
  preview: GesturePreview,
): { dx: number; dy: number } | null {
  const homeTask = node.homeTaskId
    ? tasks.find((task) => task.id === node.homeTaskId)
    : undefined
  if (preview?.kind === 'task' && preview.id === node.homeTaskId) return preview
  if (preview?.kind === 'collection') {
    const collectionId = node.collectionId ?? homeTask?.collectionId
    return collectionId === preview.id ? preview : null
  }
  if (preview?.kind === 'selection') {
    if (node.homeTaskId && preview.entities.some((entity) =>
      entity.kind === 'task' && entity.id === node.homeTaskId)) return preview
    const collectionId = node.collectionId ?? homeTask?.collectionId
    if (collectionId && preview.collectionIds.includes(collectionId)) return preview
  }
  return null
}

function entityBounds(
  document: CanvasDocument,
  taskViewsById: ReadonlyMap<string, CanvasTaskView>,
  ref: CanvasEntityRef,
): CanvasBounds | null {
  if (ref.kind === 'node') return document.nodes.find((node) => node.id === ref.id)?.frame ?? null
  const view = taskViewsById.get(ref.id)
  return view ? taskInteractionBounds(view) : null
}
