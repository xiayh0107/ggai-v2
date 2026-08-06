import {
  FolderPlus,
  Minus,
  Plus,
  ScanSearch,
  Undo2,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  applyCanvasCommandV2,
  MAX_CANVAS_EDGE_BATCH_V2,
  type CanvasCommandV2,
} from '@/canvas-v2/commands'
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
import { COLLECTION_CHROME_LAYOUT_V2 } from '@/canvas-v2/layout'
import {
  canvasEdgeTopologyIssueV2,
  type CanvasCollectionV2,
  type CanvasDocumentV2,
  type CanvasEdgeContextRoleV2,
  type CanvasEdgeRelationV2,
  type CanvasEntityRef,
  type CanvasNodeV2,
  type CanvasTaskV2,
} from '@/canvas-v2/model'
import type { CanvasV2SelectionTarget } from '@/canvas-v2/persistence'
import {
  selectCollectionBoundsV2,
  selectCollectionMembersV2,
  selectTaskViewV2,
  type CanvasBoundsV2,
  type CanvasTaskViewV2,
} from '@/canvas-v2/selectors'
import { useCanvasV2State, useCanvasV2Store } from '@/canvas-v2/hooks'
import { useThrottledAnnouncement } from '@/canvas-v2/useThrottledAnnouncement'
import CanvasV2CollectionFrame from './CanvasV2CollectionFrame'
import CanvasV2ContextComposer from './CanvasV2ContextComposer'
import CanvasV2EdgeLayer, {
  type CanvasV2EdgeEndpoint,
} from './CanvasV2EdgeLayer'
import {
  EDGE_RELATIONS_V2,
  collapsedCollectionBoundsV2,
  edgeSemanticKeyV2,
  relationLabelV2,
  taskInteractionBoundsV2,
  visualEntityKeyV2,
} from './CanvasV2EdgeLayer.utils'
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
      kind: 'task' | 'node' | 'collection'
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
  | { kind: 'task' | 'node' | 'collection'; id: string; dx: number; dy: number }
  | { kind: 'resize'; id: string; frame: CanvasNodeV2['frame'] }
  | null

type EdgeEndpointV2 = CanvasV2EdgeEndpoint

interface CollectionViewV2 {
  collection: CanvasCollectionV2
  bounds: CanvasBoundsV2
  collapsed: boolean
  memberCount: number
  artifactCount: number
}

interface ConfirmationV2 {
  title: string
  detail: string
  confirmLabel: string
  command: CanvasCommandV2
}

interface UndoOfferV2 {
  label: string
  undoCommands?: CanvasCommandV2[]
  pendingCommand?: CanvasCommandV2
}

export default function CanvasV2Stage() {
  const store = useCanvasV2Store()
  const state = useCanvasV2State()
  const stateRef = useRef(state)
  const stageRef = useRef<HTMLDivElement>(null)
  const confirmationDialogRef = useRef<HTMLDivElement>(null)
  const confirmationCancelRef = useRef<HTMLButtonElement>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const focusableRefs = useRef(new Map<string, HTMLButtonElement>())
  const [preview, setPreview] = useState<GesturePreview>(null)
  const [marquee, setMarquee] = useState<CanvasBoundsV2 | null>(null)
  const [rovingKey, setRovingKey] = useState<string | null>(null)
  const [edgeDraft, setEdgeDraft] = useState<EdgeEndpointV2 | null>(null)
  const [edgeRelation, setEdgeRelation] = useState<CanvasEdgeRelationV2>('references')
  const [edgeContextRole, setEdgeContextRole] = useState<CanvasEdgeContextRoleV2>('full')
  const [confirmation, setConfirmation] = useState<ConfirmationV2 | null>(null)
  const [undoOffer, setUndoOffer] = useState<UndoOfferV2 | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [hoveredVisualKey, setHoveredVisualKey] = useState<string | null>(null)
  const [assignmentCollectionId, setAssignmentCollectionId] = useState('')
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    const taskIds = new Set(state.document.tasks.map((task) => task.id))
    const nodeIds = new Set(state.document.nodes.map((node) => node.id))
    const collectionIds = new Set(state.document.collections.map((collection) => collection.id))
    const selection = state.view.selection.filter((target) => target.kind === 'task'
      ? taskIds.has(target.id)
      : target.kind === 'node'
        ? nodeIds.has(target.id)
        : collectionIds.has(target.id))
    if (selection.length !== state.view.selection.length) store.setSelection(selection)
  }, [state.document, state.view.selection, store])

  useEffect(() => () => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
  }, [])

  useEffect(() => {
    if (!confirmation) return
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const stage = stageRef.current
    confirmationCancelRef.current?.focus()
    return () => {
      if (returnFocus?.isConnected) returnFocus.focus()
      else stage?.focus()
    }
  }, [confirmation])

  let stageDocument = state.document
  if (undoOffer?.pendingCommand) {
    try {
      stageDocument = applyCanvasCommandV2(state.document, undoOffer.pendingCommand)
    } catch {
      // A concurrent optimistic change can invalidate the pending deletion.
      // The timer will surface the dispatch error and restore the full document.
    }
  }
  const taskViews = stageDocument.tasks
    .map((task) => selectTaskViewV2(stageDocument, task.id, {
      zoom: state.view.camera.zoom,
      selected: state.view.selection.some((target) =>
        target.kind === 'task' && target.id === task.id),
      explicitlyCollapsed: state.view.collapsedTaskIds.includes(task.id),
      runtime: state.runtimeByTaskId[task.id],
    }))
    .filter((view): view is CanvasTaskViewV2 => view !== null)
  const taskViewsById = new Map(taskViews.map((view) => [view.task.id, view]))
  const collectionViews = stageDocument.collections.map((collection): CollectionViewV2 => {
    const members = selectCollectionMembersV2(stageDocument, collection.id)
    const childNodes = stageDocument.nodes.filter((node) =>
      node.homeTaskId !== undefined
      && members.tasks.some((task) => task.id === node.homeTaskId))
    return {
      collection,
      bounds: selectCollectionBoundsV2(stageDocument, collection.id) ?? {
        x: collection.anchor.x,
        y: collection.anchor.y,
        w: COLLECTION_CHROME_LAYOUT_V2.minimumWidth,
        h: COLLECTION_CHROME_LAYOUT_V2.minimumHeight,
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
  const taskCollectionId = new Map(stageDocument.tasks
    .filter((task) => task.collectionId)
    .map((task) => [task.id, task.collectionId!]))
  const hiddenTaskIds = new Set(stageDocument.tasks
    .filter((task) => task.collectionId && collapsedCollectionIds.has(task.collectionId))
    .map((task) => task.id))
  const visibleTaskViews = taskViews.filter((view) => !hiddenTaskIds.has(view.task.id))
  const topLevelNodes = stageDocument.nodes.filter((node) => !node.homeTaskId)
  const visibleTopLevelNodes = topLevelNodes.filter((node) =>
    !node.collectionId || !collapsedCollectionIds.has(node.collectionId))
  const selectedTaskIds = new Set(state.view.selection
    .filter((target) => target.kind === 'task')
    .map((target) => target.id))
  const selectedNodeIds = new Set(state.view.selection
    .filter((target) => target.kind === 'node')
    .map((target) => target.id))
  const selectedCollectionIds = new Set(state.view.selection
    .filter((target) => target.kind === 'collection')
    .map((target) => target.id))

  const focusableKeys = collectionViews.map((view) => `collection:${view.collection.id}`)
    .concat(visibleTaskViews.flatMap((view) => [
    `task:${view.task.id}`,
    ...(view.presentation === 'collapsed'
      ? []
      : view.nodes.map((node) => `node:${node.id}`)),
    ])).concat(visibleTopLevelNodes.map((node) => `node:${node.id}`))
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

  const selectCollection = useCallback((collection: CanvasCollectionV2, additive: boolean) => {
    selectTarget({ kind: 'collection', id: collection.id }, additive)
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

  const beginCollectionDrag = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    collection: CanvasCollectionV2,
  ) => {
    if (event.button !== 0) return
    event.stopPropagation()
    event.currentTarget.focus({ preventScroll: true })
    selectCollection(collection, event.shiftKey)
    if (event.shiftKey) return
    beginGesture({
      kind: 'collection',
      pointerId: event.pointerId,
      id: collection.id,
      startX: event.clientX,
      startY: event.clientY,
      zoom: stateRef.current.view.camera.zoom,
    }, event.currentTarget)
  }, [beginGesture, selectCollection])

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

  const selectable = (() : CanvasV2SelectableBounds[] => {
    const values: CanvasV2SelectableBounds[] = collectionViews.map((view) => ({
      target: { kind: 'collection', id: view.collection.id },
      bounds: view.collapsed ? collapsedCollectionBoundsV2(view.collection) : view.bounds,
    }))
    for (const view of visibleTaskViews) {
      values.push({
        target: { kind: 'task', id: view.task.id },
        bounds: taskInteractionBoundsV2(view),
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
      gesture: Extract<Gesture, { kind: 'task' | 'node' | 'collection' }>,
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
      const collectionId = node.collectionId
        ?? (node.homeTaskId ? taskCollectionId.get(node.homeTaskId) : undefined)
      if (collectionId !== preview.id) continue
      nodeFrames.set(node.id, {
        x: node.frame.x + preview.dx,
        y: node.frame.y + preview.dy,
        w: node.frame.w,
        h: node.frame.h,
      })
    }
  }

  const clearUndoOffer = () => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    undoTimerRef.current = null
    setUndoOffer(null)
  }
  const showUndoOffer = (offer: UndoOfferV2, delayMs = 6_000) => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    setUndoOffer(offer)
    undoTimerRef.current = setTimeout(() => {
      undoTimerRef.current = null
      if (!offer.pendingCommand) {
        setUndoOffer((current) => current === offer ? null : current)
        return
      }
      void store.dispatchCommand(offer.pendingCommand).then(() => {
        setUndoOffer((current) => current === offer ? null : current)
      }).catch((error: unknown) => {
        setUndoOffer((current) => current === offer ? null : current)
        setNotice(`删除未保存，已恢复画布：${errorMessageV2(error)}`)
      })
    }, delayMs)
  }
  const dispatchWithUndo = (
    command: CanvasCommandV2,
    label: string,
    undoCommands: CanvasCommandV2[],
  ) => {
    void store.dispatchCommand(command)
      .then(() => showUndoOffer({ label, undoCommands }))
      .catch((error: unknown) => setNotice(errorMessageV2(error)))
  }
  const queueDestructive = (action: ConfirmationV2) => {
    setConfirmation(null)
    showUndoOffer({
      label: `已从画布移除：${action.confirmLabel}`,
      pendingCommand: action.command,
    }, 5_000)
  }
  const undoLastAction = () => {
    const offer = undoOffer
    clearUndoOffer()
    if (!offer?.undoCommands) return
    void dispatchCommandsV2(store, offer.undoCommands)
      .catch((error: unknown) => setNotice(errorMessageV2(error)))
  }
  const collectionMembers = (collectionId: string): CanvasEntityRef[] => {
    const members = selectCollectionMembersV2(stateRef.current.document, collectionId)
    return [
      ...members.tasks.map((task) => ({ kind: 'task' as const, id: task.id })),
      ...members.nodes.map((node) => ({ kind: 'node' as const, id: node.id })),
    ]
  }
  const collectableSelection = state.view.selection.flatMap((target): CanvasEntityRef[] => {
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
  const assignmentTargetId = collectionViews.some((view) =>
    view.collection.id === assignmentCollectionId)
    ? assignmentCollectionId
    : collectionViews[0]?.collection.id ?? ''
  const assignSelectionToCollection = () => {
    if (!assignmentTargetId || collectableSelection.length === 0) return
    dispatchWithUndo({
      type: 'AssignToCollection',
      collectionId: assignmentTargetId,
      members: collectableSelection,
    }, '已加入集合', [{
      type: 'RemoveFromCollection',
      collectionId: assignmentTargetId,
      members: collectableSelection,
    }])
  }
  const saveSelectionAsCollection = () => {
    if (collectableSelection.length < 2) return
    const id = clientCanvasIdV2('collection')
    const memberBounds = collectableSelection.map((ref) => entityBoundsV2(
      stageDocument,
      taskViewsById,
      ref,
    )).filter((bounds): bounds is CanvasBoundsV2 => bounds !== null)
    const bounds = unionBoundsV2(memberBounds)
    const command: CanvasCommandV2 = {
      type: 'CreateCollectionFromSelection',
      collection: {
        id,
        title: `集合 ${stageDocument.collections.length + 1}`,
        anchor: { x: bounds.x - 24, y: bounds.y - 56 },
      },
      members: collectableSelection,
    }
    void store.dispatchCommand(command).then(() => {
      store.setSelection([{ kind: 'collection', id }])
      setRovingKey(`collection:${id}`)
      showUndoOffer({
        label: '已保存为集合',
        undoCommands: [{ type: 'DissolveCollection', collectionId: id }],
      })
    }).catch((error: unknown) => setNotice(errorMessageV2(error)))
  }
  const requestTaskDeletion = (
    task: CanvasTaskV2,
    withViews: boolean,
  ) => {
    const runtime = state.runtimeByTaskId[task.id]
    if (runtime && ['queued', 'running', 'awaiting-permission'].includes(runtime.phase)) {
      setNotice(`任务“${task.title}”仍在运行，需要先取消并等待 daemon 确认`)
      return
    }
    setConfirmation({
      title: withViews ? '删除任务及全部视图？' : '删除任务？',
      detail: withViews
        ? '任务与所有输出节点将从画布删除；artifact 和 receipt 仍会保留。'
        : '任务会被删除，输出节点将释放为顶层节点。',
      confirmLabel: withViews ? '删除任务及视图' : '删除任务',
      command: withViews
        ? { type: 'DeleteTaskAndViews', taskId: task.id }
        : { type: 'DeleteTask', taskId: task.id },
    })
  }
  const onTaskMenuAction = (task: CanvasTaskV2, action: string) => {
    if (action === 'duplicate') {
      const newTaskId = clientCanvasIdV2('task')
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
  const onNodeMenuAction = (node: CanvasNodeV2, action: string) => {
    if (action === 'duplicate') {
      const newNodeId = clientCanvasIdV2('node')
      dispatchWithUndo({
        type: 'DuplicateNode',
        sourceNodeId: node.id,
        newNodeId,
        offset: { x: 48, y: 48 },
      }, '已复制节点', [{ type: 'DeleteNode', nodeId: newNodeId }])
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
      setConfirmation({
        title: '删除节点？',
        detail: '节点和关联边将从画布删除；运行 receipt 与 artifact 不会删除。',
        confirmLabel: '删除节点',
        command: { type: 'DeleteNode', nodeId: node.id },
      })
    }
  }
  const onCollectionMenuAction = (collection: CanvasCollectionV2, action: string) => {
    const members = collectionMembers(collection.id)
    if (action === 'duplicate') {
      const newCollectionId = clientCanvasIdV2('collection')
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
      setConfirmation({
        title: '删除集合及内容？',
        detail: `将删除集合“${collection.title}”及 ${members.length} 个顶层成员。此动作会先提供撤销窗口。`,
        confirmLabel: '删除集合及内容',
        command: { type: 'DeleteCollectionAndContents', collectionId: collection.id },
      })
    }
  }
  const expandEndpoint = (endpoint: EdgeEndpointV2): CanvasEntityRef[] => endpoint.kind === 'collection'
    ? collectionMembers(endpoint.id)
    : [endpoint]
  const onPortActivate = (endpoint: EdgeEndpointV2) => {
    if (!edgeDraft) {
      setEdgeDraft(endpoint)
      setNotice(`已选择${endpointLabelV2(stageDocument, endpoint)}作为连接起点`)
      return
    }
    if (visualEntityKeyV2(edgeDraft) === visualEntityKeyV2(endpoint)) {
      setEdgeDraft(null)
      setNotice('已取消连接')
      return
    }
    const fromEndpoints = expandEndpoint(edgeDraft)
    const toEndpoints = expandEndpoint(endpoint)
    if (fromEndpoints.length * toEndpoints.length > MAX_CANVAS_EDGE_BATCH_V2) {
      setNotice(
        `集合连接会生成超过 ${MAX_CANVAS_EDGE_BATCH_V2} 条边；请缩小集合或分批连接`,
      )
      return
    }
    const pairs = fromEndpoints.flatMap((from) =>
      toEndpoints.map((to) => ({ from, to })))
    const existing = new Set(stageDocument.edges.map((edge) => edgeSemanticKeyV2(edge)))
    const edges = pairs.flatMap(({ from, to }) => {
      const candidate = {
        from,
        to,
        relation: edgeRelation,
        contextRole: edgeContextRole,
      }
      if (canvasEdgeTopologyIssueV2(candidate)) return []
      const key = edgeSemanticKeyV2(candidate)
      if (existing.has(key)) return []
      existing.add(key)
      return [{
        id: clientCanvasIdV2('edge'),
        ...candidate,
        origin: { kind: 'user' as const },
      }]
    })
    if (edges.length === 0) {
      setNotice('当前 relation 与端点类型不兼容，或连接已经存在')
      return
    }
    void store.dispatchCommand({ type: 'CreateEdges', edges }).then(() => {
      setEdgeDraft(null)
      showUndoOffer({
        label: `已创建 ${edges.length} 条 ${relationLabelV2(edgeRelation)} 连接`,
        undoCommands: [{ type: 'DeleteEdges', edgeIds: edges.map((edge) => edge.id) }],
      })
    }).catch((error: unknown) => setNotice(errorMessageV2(error)))
  }

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
    store.setCamera(zoomCameraAtV2(camera, viewport, {
      clientX: viewport.left + viewport.width / 2,
      clientY: viewport.top + viewport.height / 2,
    }, camera.zoom * factor))
  }
  const contextComposerAnchor = () => {
    const camera = stateRef.current.view.camera
    const viewport = viewportRect()
    return screenToWorldV2({
      clientX: viewport.left + viewport.width / 2,
      clientY: viewport.top + viewport.height / 2,
    }, camera, viewport)
  }

  return (
    <div
      ref={stageRef}
      role="region"
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
        {collectionViews.map((view) => (
          <CanvasV2CollectionFrame
            key={view.collection.id}
            collection={view.collection}
            bounds={view.bounds}
            collapsed={view.collapsed}
            selected={selectedCollectionIds.has(view.collection.id)}
            memberCount={view.memberCount}
            artifactCount={view.artifactCount}
            offset={preview?.kind === 'collection' && preview.id === view.collection.id
              ? { dx: preview.dx, dy: preview.dy }
              : undefined}
            tabIndex={activeKey === `collection:${view.collection.id}` ? 0 : -1}
            connectionActive={edgeDraft?.kind === 'collection'
              && edgeDraft.id === view.collection.id}
            onFocus={() => setRovingKey(`collection:${view.collection.id}`)}
            onKeyDown={(event) => onEntityKeyDown(`collection:${view.collection.id}`, event)}
            onDragStart={beginCollectionDrag}
            onToggle={() => store.setCollectionCollapsed(view.collection.id, !view.collapsed)}
            onPortActivate={() => onPortActivate({
              kind: 'collection',
              id: view.collection.id,
            })}
            onMenuAction={(action) => onCollectionMenuAction(view.collection, action)}
            onHoverChange={(hovered) => setHoveredVisualKey(hovered
              ? `collection:${view.collection.id}`
              : null)}
            registerFocusable={(element) => registerFocusable(
              `collection:${view.collection.id}`,
              element,
            )}
          />
        ))}
        <CanvasV2EdgeLayer
          document={stageDocument}
          taskViewsById={taskViewsById}
          collectionViewsById={collectionViewsById}
          collapsedCollectionIds={collapsedCollectionIds}
          hoveredVisualKey={hoveredVisualKey}
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
        {visibleTaskViews.map((view) => (
          <CanvasV2TaskGroup
            key={view.task.id}
            view={view}
            projectDir={state.scope.projectDir}
            selectedTask={selectedTaskIds.has(view.task.id)}
            selectedNodeIds={selectedNodeIds}
            explicitlyCollapsed={state.view.collapsedTaskIds.includes(view.task.id)}
            activeKey={activeKey}
            offset={taskPreviewOffsetV2(view.task, preview)}
            nodeFrames={nodeFrames}
            onSelectTask={selectTask}
            onToggleCollapsed={(taskId, collapsed) =>
              store.setTaskCollapsed(taskId, collapsed)}
            onTaskDragStart={beginTaskDrag}
            onNodeDragStart={beginNodeDrag}
            onNodeResizeStart={beginNodeResize}
            onTaskPortActivate={(task) => onPortActivate({ kind: 'task', id: task.id })}
            onNodePortActivate={(node) => onPortActivate({ kind: 'node', id: node.id })}
            activeConnectionKey={edgeDraft ? visualEntityKeyV2(edgeDraft) : null}
            onTaskMenuAction={onTaskMenuAction}
            onNodeMenuAction={onNodeMenuAction}
            onHoverChange={(hovered) => setHoveredVisualKey(hovered
              ? `task:${view.task.id}`
              : null)}
            onEntityFocus={setRovingKey}
            onEntityKeyDown={onEntityKeyDown}
            registerFocusable={registerFocusable}
          />
        ))}
        {visibleTopLevelNodes.map((node) => (
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
            onPortActivate={(entry) => onPortActivate({ kind: 'node', id: entry.id })}
            connectionActive={edgeDraft?.kind === 'node' && edgeDraft.id === node.id}
            onMenuAction={onNodeMenuAction}
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

      {stageDocument.tasks.length === 0 && stageDocument.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="rounded-[16px] border border-dashed border-gg-line bg-white/85 px-5 py-4 text-center">
            <ScanSearch size={20} className="mx-auto text-gg-muted" />
            <p className="mt-2 text-[12px] font-medium text-gg-ink">当前分支还没有任务</p>
          </div>
        </div>
      )}

      <CanvasV2ContextComposer getAnchor={contextComposerAnchor} />

      <div className="absolute left-4 top-4 flex max-w-[calc(100%-2rem)] flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="save-selection-collection"
          disabled={collectableSelection.length < 2}
          onClick={saveSelectionAsCollection}
          className="flex h-9 items-center gap-2 rounded-[10px] border border-gg-line bg-white px-3 text-[11px] font-medium text-gg-ink shadow-sm outline-none hover:bg-gg-subtle focus-visible:ring-2 focus-visible:ring-gg-primary/35 disabled:cursor-not-allowed disabled:opacity-45"
        >
          <FolderPlus size={14} aria-hidden="true" />
          保存为集合
        </button>
        {collectionViews.length > 0 && (
          <div className="flex items-center rounded-[10px] border border-gg-line bg-white p-1 shadow-sm">
            <select
              aria-label="选择目标集合"
              value={assignmentTargetId}
              onChange={(event) => setAssignmentCollectionId(event.target.value)}
              className="h-7 max-w-32 rounded-[7px] bg-white px-1.5 text-[10px] text-gg-ink outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35"
            >
              {collectionViews.map((view) => (
                <option key={view.collection.id} value={view.collection.id}>
                  {view.collection.title}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={collectableSelection.length === 0}
              onClick={assignSelectionToCollection}
              className="h-7 rounded-[7px] px-2 text-[10px] font-medium text-gg-primary outline-none hover:bg-[#EAF1FD] focus-visible:ring-2 focus-visible:ring-gg-primary/35 disabled:cursor-not-allowed disabled:opacity-45"
            >
              加入集合
            </button>
          </div>
        )}
        <div
          role="group"
          aria-label="连接语义设置"
          className="flex items-center gap-2 rounded-[10px] border border-gg-line bg-white px-2 py-1 shadow-sm"
        >
          <label className="flex items-center gap-1 text-[10px] text-gg-muted">
            Relation
            <select
              aria-label="连接 relation"
              value={edgeRelation}
              onChange={(event) => setEdgeRelation(event.target.value as CanvasEdgeRelationV2)}
              className="h-7 rounded-[7px] border border-gg-line bg-white px-1.5 text-[10px] text-gg-ink outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35"
            >
              {EDGE_RELATIONS_V2.map((relation) => (
                <option key={relation} value={relation}>{relationLabelV2(relation)}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1 text-[10px] text-gg-muted">
            Context
            <select
              aria-label="连接 contextRole"
              value={edgeContextRole}
              onChange={(event) => setEdgeContextRole(
                event.target.value as CanvasEdgeContextRoleV2,
              )}
              className="h-7 rounded-[7px] border border-gg-line bg-white px-1.5 text-[10px] text-gg-ink outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35"
            >
              <option value="full">完整</option>
              <option value="summary">摘要</option>
              <option value="none">不进上下文</option>
            </select>
          </label>
          {edgeDraft && (
            <button
              type="button"
              aria-label="取消创建连接"
              onClick={() => setEdgeDraft(null)}
              className="flex h-7 w-7 items-center justify-center rounded-[7px] text-gg-muted outline-none hover:bg-gg-subtle focus-visible:ring-2 focus-visible:ring-gg-primary/35"
            >
              <X size={13} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

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

      {undoOffer && (
        <div
          role="status"
          data-testid="canvas-v2-undo"
          className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-[12px] bg-[#1D2939] px-3 py-2 text-[11px] text-white shadow-float"
        >
          <span>{undoOffer.label}</span>
          <button
            type="button"
            onClick={undoLastAction}
            className="flex items-center gap-1 rounded-[7px] px-2 py-1 font-semibold text-[#9DC1FF] outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <Undo2 size={12} aria-hidden="true" /> 撤销
          </button>
        </div>
      )}

      {confirmation && (
        <div className="absolute inset-0 z-[100] flex items-center justify-center bg-[#101828]/20 p-6">
          <div
            ref={confirmationDialogRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="canvas-v2-confirm-title"
            aria-describedby="canvas-v2-confirm-detail"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                setConfirmation(null)
              } else if (event.key === 'Tab') {
                trapDialogFocusV2(event, confirmationDialogRef.current)
              }
            }}
            className="w-full max-w-sm rounded-[16px] border border-gg-line bg-white p-5 shadow-float"
          >
            <h2 id="canvas-v2-confirm-title" className="text-[14px] font-semibold text-gg-ink">
              {confirmation.title}
            </h2>
            <p id="canvas-v2-confirm-detail" className="mt-2 text-[11px] leading-5 text-gg-muted">
              {confirmation.detail}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                ref={confirmationCancelRef}
                type="button"
                onClick={() => setConfirmation(null)}
                className="rounded-[9px] border border-gg-line px-3 py-2 text-[11px] text-gg-ink outline-none hover:bg-gg-subtle focus-visible:ring-2 focus-visible:ring-gg-primary/35"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => queueDestructive(confirmation)}
                className="rounded-[9px] bg-[#B42318] px-3 py-2 text-[11px] font-semibold text-white outline-none hover:bg-[#912018] focus-visible:ring-2 focus-visible:ring-[#F97066]"
              >
                {confirmation.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}

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

function targetFromKey(key: string): CanvasV2SelectionTarget | null {
  const separator = key.indexOf(':')
  if (separator < 1) return null
  const kind = key.slice(0, separator)
  const id = key.slice(separator + 1)
  if (!id || (kind !== 'task' && kind !== 'node' && kind !== 'collection')) return null
  return { kind, id }
}

function trapDialogFocusV2(
  event: KeyboardEvent<HTMLDivElement>,
  dialog: HTMLDivElement | null,
): void {
  if (!dialog) return
  const focusable = [...dialog.querySelectorAll<HTMLElement>(
    'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
  )]
  if (focusable.length === 0) {
    event.preventDefault()
    dialog.focus()
    return
  }
  const first = focusable[0]!
  const last = focusable.at(-1)!
  const active = document.activeElement
  if (event.shiftKey && (active === first || !dialog.contains(active))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
    event.preventDefault()
    first.focus()
  }
}

function taskPreviewOffsetV2(
  task: CanvasTaskV2,
  preview: GesturePreview,
): { dx: number; dy: number } | undefined {
  if (preview?.kind === 'task' && preview.id === task.id) return preview
  if (preview?.kind === 'collection' && preview.id === task.collectionId) return preview
  return undefined
}

function entityBoundsV2(
  document: CanvasDocumentV2,
  taskViewsById: ReadonlyMap<string, CanvasTaskViewV2>,
  ref: CanvasEntityRef,
): CanvasBoundsV2 | null {
  if (ref.kind === 'node') return document.nodes.find((node) => node.id === ref.id)?.frame ?? null
  const view = taskViewsById.get(ref.id)
  return view ? taskInteractionBoundsV2(view) : null
}

function unionBoundsV2(bounds: readonly CanvasBoundsV2[]): CanvasBoundsV2 {
  if (bounds.length === 0) return { x: 0, y: 0, w: 0, h: 0 }
  const x = Math.min(...bounds.map((entry) => entry.x))
  const y = Math.min(...bounds.map((entry) => entry.y))
  const right = Math.max(...bounds.map((entry) => entry.x + entry.w))
  const bottom = Math.max(...bounds.map((entry) => entry.y + entry.h))
  return { x, y, w: right - x, h: bottom - y }
}

function clientCanvasIdV2(kind: 'node' | 'task' | 'collection' | 'edge'): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `${kind}-${random}`
}

async function dispatchCommandsV2(
  store: { dispatchCommand: (command: CanvasCommandV2) => Promise<unknown> },
  commands: CanvasCommandV2[],
): Promise<void> {
  for (const command of commands) await store.dispatchCommand(command)
}

function endpointLabelV2(document: CanvasDocumentV2, endpoint: EdgeEndpointV2): string {
  if (endpoint.kind === 'collection') {
    return `集合“${document.collections.find((entry) => entry.id === endpoint.id)?.title ?? endpoint.id}”`
  }
  if (endpoint.kind === 'task') {
    return `任务“${document.tasks.find((entry) => entry.id === endpoint.id)?.title ?? endpoint.id}”`
  }
  return `节点“${document.nodes.find((entry) => entry.id === endpoint.id)?.title ?? endpoint.id}”`
}

function errorMessageV2(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
