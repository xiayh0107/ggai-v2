import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type {
  Camera, CanvasNode, ConnectingState, CreateMenuState, Edge,
  InstructionState, NodeType, SmartParams,
} from '@/types/canvas'
import { uid } from '@/types/canvas'
import { getPlugin, listEnabledPlugins } from '@/plugins/types'
import {
  DaemonClient,
  DaemonClientError,
  DaemonHttpError,
  DaemonProtocolError,
  DaemonRunError,
  DaemonRunStartUncertainError,
  type DaemonCanvasDocumentV1,
  type DaemonCanvasRunRef,
  type DaemonCloseEvent,
  type DaemonRunSummary,
  decodeDaemonRunLogEntry,
} from '@/agent/daemonClient'
import { DAEMON_AGENT_ID, DAEMON_PROJECT_DIR, DAEMON_URL } from '@/agent/config'
import {
  advanceGenerationPanel,
  createGenerationPanel,
  type GenerationPanelState,
} from '@/agent/generationProgress'
import type { CanvasAgentEvent } from '@/agent/types'
import {
  applyRunOutcome,
  clearSuggestedActions,
  materializeNodeRun,
  settleUnsuccessfulRun,
  withoutAgentProgress,
} from '@/agent/settlement'
import {
  deleteCanvasJournal,
  getCanvasWriterId,
  readCanvasCamera,
  readCanvasJournals,
  reconcileCanvasJournalCandidate,
  selectCanvasJournalCandidates,
  writeCanvasCamera,
  writeCanvasJournal,
  type CanvasJournalCandidate,
  type CanvasJournalEntry,
  type CanvasJournalScope,
} from '@/persistence/canvasPersistence'

const daemonClient = new DaemonClient({ baseUrl: DAEMON_URL })

const TEXT_ARTIFACT_PATTERN = /\.(?:md|txt|log|json|csv|ts|tsx|js|jsx|py|tex)$/iu

function sourceIdsForNode(edges: Edge[], nodeId: string): string[] {
  return [...new Set(edges.filter((edge) => edge.to === nodeId).map((edge) => edge.from))]
}

function sourceIdsByNode(edges: Edge[]): Map<string, string[]> {
  const incoming = new Map<string, Set<string>>()
  for (const edge of edges) {
    const sources = incoming.get(edge.to) ?? new Set<string>()
    sources.add(edge.from)
    incoming.set(edge.to, sources)
  }
  return new Map([...incoming].map(([nodeId, sources]) => [nodeId, [...sources]]))
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

function downstreamNodeIds(edges: Edge[], roots: Iterable<string>): Set<string> {
  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    const targets = outgoing.get(edge.from) ?? []
    targets.push(edge.to)
    outgoing.set(edge.from, targets)
  }
  const downstream = new Set<string>()
  const queue = [...roots]
  const seen = new Set(queue)
  for (let index = 0; index < queue.length; index += 1) {
    const from = queue[index]
    for (const target of outgoing.get(from) ?? []) {
      if (seen.has(target)) continue
      seen.add(target)
      downstream.add(target)
      queue.push(target)
    }
  }
  return downstream
}

function invalidateSuggestions(nodes: CanvasNode[], nodeIds: Set<string>): CanvasNode[] {
  if (nodeIds.size === 0) return nodes
  return nodes.map((node) => nodeIds.has(node.id) && node.instruction.suggestedActions
    ? { ...node, instruction: clearSuggestedActions(node.instruction) }
    : node)
}

/** Keep the deprecated sources field as a compatibility mirror, never as authority. */
function syncLegacySourceMirrors(nodes: CanvasNode[], edges: Edge[]): CanvasNode[] {
  const sourcesByNode = sourceIdsByNode(edges)
  const changed = new Set(nodes
    .filter((node) => !sameStrings(node.instruction.sources, sourcesByNode.get(node.id) ?? []))
    .map((node) => node.id))
  const invalidated = new Set([...changed, ...downstreamNodeIds(edges, changed)])
  return nodes.map((node) => {
    const sources = sourcesByNode.get(node.id) ?? []
    const sourceMirrorChanged = !sameStrings(node.instruction.sources, sources)
    const suggestionsInvalid = invalidated.has(node.id) && node.instruction.suggestedActions
    if (!sourceMirrorChanged && !suggestionsInvalid) return node
    return {
      ...node,
      instruction: {
        ...(invalidated.has(node.id)
          ? clearSuggestedActions(node.instruction)
          : node.instruction),
        sources,
      },
    }
  })
}

const SEMANTIC_NODE_KEYS = new Set<keyof CanvasNode>([
  'type', 'title', 'text', 'meta', 'bold', 'italic', 'heading', 'smart', 'payload',
])

function patchChangesSemanticContent(patch: Partial<CanvasNode>): boolean {
  return (Object.keys(patch) as Array<keyof CanvasNode>)
    .some((key) => SEMANTIC_NODE_KEYS.has(key))
}

interface ActiveCanvasRun {
  epoch: number
  controller: AbortController
  previousPhase: DaemonCanvasRunRef['previousPhase']
  completion: Promise<void>
  cancelPromise?: Promise<void>
  runId: string
}

function compactErrorMessage(message: string): string {
  const compact = message.trim().replace(/\s+/g, ' ')
  return compact.length > 180 ? `${compact.slice(0, 180)}…` : compact
}

function isCancelledRun(error: unknown): boolean {
  return error instanceof DaemonRunError && error.status === 'cancelled'
}

function executionFailureMessage(error: unknown, agentMessage: string): string {
  const translated = compactErrorMessage(agentMessage)
  if (translated) return `执行失败 · ${translated}`

  if (error instanceof DaemonHttpError) {
    if (error.status === 401 || error.status === 403) return '执行失败 · Agent 未登录或没有执行权限'
    if (error.status === 404) return '执行失败 · Agent 或项目配置不存在'
    if (error.status === 409) return '执行失败 · 会话状态冲突，请重试'
    if (error.status === 413) return '执行失败 · 画布上下文过大'
    if (error.status >= 500) return '执行失败 · 本地 Agent 服务内部错误'
    return `执行失败 · 本地 Agent 服务拒绝请求（HTTP ${error.status}）`
  }
  if (error instanceof DaemonProtocolError) return '执行失败 · 本地 Agent 服务返回了不兼容的响应'
  if (error instanceof DaemonRunError) return '执行失败 · Agent 进程异常退出'
  if (error instanceof DaemonClientError) return '执行失败 · 无法连接本地 Agent 服务'
  if (error instanceof Error) {
    const message = compactErrorMessage(error.message)
    if (message) return `执行失败 · ${message}`
  }
  return '执行失败 · 未知错误'
}

export interface CanvasStore {
  nodes: CanvasNode[]
  edges: Edge[]
  camera: Camera
  selectedId: string | null
  /** 多选（框选 / Shift 点选）；selectedId 为主选中（工具条、指令面板跟随） */
  selectedIds: string[]
  connecting: ConnectingState | null
  createMenu: CreateMenuState | null
  branch: string
  hydrationState: 'loading' | 'ready' | 'error'
  hydrationError: string | null
  savedState: 'loading' | 'local-pending' | 'saving' | 'saved' | 'error' | 'conflict'
  saveError: string | null
  /** Pending snapshots owned by other tabs are never merged automatically. */
  journalConflictWriters: string[]
  retryHydration: () => void
  retrySave: () => void
  preserveConflictAsBranch: (name: string, writerId?: string) => Promise<void>
  /** Run UI is persisted separately from node payload for refresh recovery. */
  generationByNodeId: Record<string, GenerationPanelState>
  /** 创建过第一个节点后，平铺创建面板永久隐藏（规范 3.4） */
  everCreated: boolean
  // camera
  setCamera: (c: Camera) => void
  zoomTo: (zoom: number, cx?: number, cy?: number) => void
  fitView: () => void
  // selection
  select: (id: string | null) => void
  selectMany: (ids: string[]) => void
  toggleSelect: (id: string) => void
  // nodes
  addNode: (type: NodeType, x: number, y: number) => CanvasNode
  updateNode: (id: string, patch: Partial<CanvasNode>) => void
  reportSize: (id: string, w: number, h: number) => void
  removeNode: (id: string) => void
  duplicateNode: (id: string) => void
  // edges
  addEdge: (from: string, to: string) => void
  removeEdge: (id: string) => void
  cycleEdgeLabel: (id: string) => void
  // connecting
  setConnecting: (c: ConnectingState | null) => void
  // create menu
  openCreateMenu: (m: CreateMenuState) => void
  closeCreateMenu: () => void
  createFromMenu: (type: NodeType) => void
  // instruction（所有节点通用）
  updateInstruction: (id: string, patch: Partial<InstructionState>) => void
  runInstruction: (id: string) => void
  cancelInstruction: (id: string) => void
  // smart 专属生成参数
  updateSmart: (id: string, patch: Partial<SmartParams>) => void
}

export interface CanvasStoreOptions {
  client?: DaemonClient
  projectDir?: string
  branch?: string
  /** Stable per-tab id; injectable for multi-tab persistence tests. */
  writerId?: string
  navigateToBranch?: (branch: string) => void
}

const CanvasCtx = createContext<CanvasStore | null>(null)
export const useCanvas = () => {
  const s = useContext(CanvasCtx)
  if (!s) throw new Error('useCanvas must be used within CanvasProvider')
  return s
}

const freshInstruction = (): InstructionState => ({
  phase: 'idle', prompt: '', attachments: [], sources: [], open: true,
})

/** 由节点插件创建空白节点：外观 / 载荷全部由插件自身定义 */
function makeNode(type: NodeType, x: number, y: number): CanvasNode {
  const plugin = getPlugin(type)
  const payload = plugin.initialPayload()
  const node: CanvasNode = {
    id: uid(), type, x, y,
    w: plugin.defaultWidth, h: 120,
    title: plugin.label,
    instruction: freshInstruction(),
    payload,
  }
  // 智能节点的生成参数（保持 CanvasNode 上的既有字段，供工具条 / 指令面板使用）
  if (payload.smart) node.smart = payload.smart as CanvasNode['smart']
  return node
}

function branchFromLocation(): string {
  if (typeof window === 'undefined') return 'main'
  const candidate = new URLSearchParams(window.location.search).get('branch')?.trim()
  return candidate || 'main'
}

function normalizeHydratedDocument(document: DaemonCanvasDocumentV1): DaemonCanvasDocumentV1 {
  const runRefsByNodeId = document.runRefsByNodeId ?? {}
  const normalizedNodes = document.nodes.map((node) => node.instruction.phase === 'generating'
    && !runRefsByNodeId[node.id]
    ? {
        ...node,
        instruction: { ...node.instruction, phase: 'idle' as const, open: true },
      }
    : node)
  return {
    ...document,
    runRefsByNodeId,
    nodes: syncLegacySourceMirrors(normalizedNodes, document.edges),
  }
}

function documentFingerprint(document: DaemonCanvasDocumentV1): string {
  return JSON.stringify(document)
}

function persistenceMessage(error: unknown): string {
  if (error instanceof DaemonHttpError) {
    if (error.status === 409) return '画布已被其他页面修改，本地改动已安全保留'
    return `本地服务返回 HTTP ${error.status}`
  }
  if (error instanceof DaemonProtocolError) return '本地服务返回了不兼容的画布数据'
  if (error instanceof DaemonClientError) return '无法连接本地服务'
  if (error instanceof Error && error.message.trim()) return compactErrorMessage(error.message)
  return '画布持久化失败'
}

export function useCanvasStore(options: CanvasStoreOptions = {}): CanvasStore {
  const clientRef = useRef(options.client ?? daemonClient)
  const projectDirRef = useRef(options.projectDir ?? DAEMON_PROJECT_DIR)
  const branchRef = useRef(options.branch?.trim() || branchFromLocation())
  const writerIdRef = useRef(options.writerId?.trim() || getCanvasWriterId())
  const navigateToBranchRef = useRef(options.navigateToBranch ?? ((nextBranch: string) => {
    const nextUrl = new URL(window.location.href)
    nextUrl.searchParams.set('branch', nextBranch)
    window.location.assign(nextUrl)
  }))
  const persistenceScopeRef = useRef<CanvasJournalScope>({
    daemonBaseUrl: clientRef.current.baseUrl,
    projectDir: projectDirRef.current,
    branch: branchRef.current,
  })
  const client = clientRef.current
  const projectDir = projectDirRef.current
  const branch = branchRef.current
  const writerId = writerIdRef.current
  const persistenceScope = persistenceScopeRef.current
  const [nodes, setNodes] = useState<CanvasNode[]>([])
  const nodesRef = useRef<CanvasNode[]>([])
  nodesRef.current = nodes
  const [edges, setEdges] = useState<Edge[]>([])
  const edgesRef = useRef<Edge[]>([])
  edgesRef.current = edges
  const [camera, setCameraState] = useState<Camera>({ x: 80, y: 60, zoom: 1 })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [connecting, setConnecting] = useState<ConnectingState | null>(null)
  const [createMenu, setCreateMenu] = useState<CreateMenuState | null>(null)
  const createMenuRef = useRef<CreateMenuState | null>(null)
  const [hydrationState, setHydrationState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [hydrationError, setHydrationError] = useState<string | null>(null)
  const [savedState, setSavedState] = useState<CanvasStore['savedState']>('loading')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [journalConflictWriters, setJournalConflictWriters] = useState<string[]>([])
  const [hydrationAttempt, setHydrationAttempt] = useState(0)
  const [everCreated, setEverCreated] = useState(false)
  const [generationByNodeId, setGenerationByNodeId] = useState<Record<string, GenerationPanelState>>({})
  const [runRefsByNodeId, setRunRefsByNodeId] = useState<Record<string, DaemonCanvasRunRef>>({})
  const [discoveredRuns, setDiscoveredRuns] = useState<DaemonRunSummary[] | null>(null)
  const runRefsByNodeIdRef = useRef<Record<string, DaemonCanvasRunRef>>({})
  const debounceSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const maxWaitSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cameraSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hydrated = useRef(false)
  const hydrationPromise = useRef<{
    attempt: number
    value: Promise<Awaited<ReturnType<DaemonClient['getCanvas']>>>
  } | null>(null)
  const revision = useRef(0)
  const lastMutationId = useRef<string | null>(null)
  const latestRunByNodeId = useRef<Record<string, string>>({})
  const lastSavedFingerprint = useRef('')
  const lastEnqueuedFingerprint = useRef('')
  const saveQueue = useRef<CanvasJournalEntry[]>([])
  const journalCandidates = useRef(new Map<string, CanvasJournalCandidate>())
  const saveInFlight = useRef(false)
  const saveBlockedByConflict = useRef(false)
  const journalWriteChain = useRef<Promise<void>>(Promise.resolve())
  const flushSaveRef = useRef<() => void>(() => undefined)
  const activeRuns = useRef<Map<string, ActiveCanvasRun>>(new Map())
  const restoredRunIds = useRef(new Set<string>())
  const artifactHydrations = useRef<Map<string, AbortController>>(new Map())
  const latestRunEpoch = useRef<Map<string, number>>(new Map())
  const pendingSmartPatches = useRef<Map<string, Partial<SmartParams>>>(new Map())
  const pendingRunEpochs = useRef<Map<string, number>>(new Map())
  const nextRunEpoch = useRef(0)
  const mounted = useRef(true)

  const updateRunRefs = useCallback((
    update: (current: Record<string, DaemonCanvasRunRef>) => Record<string, DaemonCanvasRunRef>,
  ) => {
    setRunRefsByNodeId((current) => {
      const next = update(current)
      runRefsByNodeIdRef.current = next
      return next
    })
  }, [])

  const clearRunRef = useCallback((nodeId: string, runId?: string) => {
    updateRunRefs((current) => {
      const ref = current[nodeId]
      if (!ref || (runId !== undefined && ref.runId !== runId)) return current
      const next = { ...current }
      delete next[nodeId]
      return next
    })
  }, [updateRunRefs])

  useEffect(() => {
    const runs = activeRuns.current
    const hydrations = artifactHydrations.current
    const runEpochs = latestRunEpoch.current
    const smartPatches = pendingSmartPatches.current
    const pendingRuns = pendingRunEpochs.current
    mounted.current = true
    return () => {
      mounted.current = false
      if (debounceSaveTimer.current) clearTimeout(debounceSaveTimer.current)
      if (maxWaitSaveTimer.current) clearTimeout(maxWaitSaveTimer.current)
      if (cameraSaveTimer.current) clearTimeout(cameraSaveTimer.current)
      debounceSaveTimer.current = null
      maxWaitSaveTimer.current = null
      cameraSaveTimer.current = null
      for (const run of runs.values()) run.controller.abort()
      for (const controller of hydrations.values()) controller.abort()
      runs.clear()
      hydrations.clear()
      runEpochs.clear()
      smartPatches.clear()
      pendingRuns.clear()
    }
  }, [])

  // Mutations are detected from the canonical state snapshot below. Keeping
  // this marker lets mutation handlers stay focused on domain updates.
  const touch = useCallback(() => undefined, [])

  const clearSaveTimers = useCallback(() => {
    if (debounceSaveTimer.current) clearTimeout(debounceSaveTimer.current)
    if (maxWaitSaveTimer.current) clearTimeout(maxWaitSaveTimer.current)
    debounceSaveTimer.current = null
    maxWaitSaveTimer.current = null
  }, [])

  const persistJournalQueue = useCallback((): Promise<void> => {
    const snapshot = [...saveQueue.current]
    const next = journalWriteChain.current
      .catch(() => undefined)
      .then(() => writeCanvasJournal(persistenceScope, writerId, snapshot))
      .catch((error: unknown) => {
        // IndexedDB is a safety layer. The daemon save remains authoritative
        // even when private browsing or browser policy disables local storage.
        console.warn('[ggai] Unable to update canvas safety journal', error)
      })
    journalWriteChain.current = next
    return next
  }, [persistenceScope, writerId])

  const scheduleSave = useCallback((immediate = false) => {
    if (!hydrated.current || saveBlockedByConflict.current || saveQueue.current.length === 0) return
    if (immediate) {
      clearSaveTimers()
      void flushSaveRef.current()
      return
    }
    if (debounceSaveTimer.current) clearTimeout(debounceSaveTimer.current)
    debounceSaveTimer.current = setTimeout(() => {
      debounceSaveTimer.current = null
      void flushSaveRef.current()
    }, 500)
    if (!maxWaitSaveTimer.current) {
      maxWaitSaveTimer.current = setTimeout(() => {
        maxWaitSaveTimer.current = null
        void flushSaveRef.current()
      }, 2_000)
    }
  }, [clearSaveTimers])

  const flushSave = useCallback(async () => {
    if (!hydrated.current
      || saveBlockedByConflict.current
      || saveInFlight.current
      || saveQueue.current.length === 0) return

    clearSaveTimers()
    saveInFlight.current = true
    const queued = saveQueue.current[0]
    const head: CanvasJournalEntry = {
      ...queued,
      baseRevision: revision.current,
      attempted: true,
    }
    saveQueue.current[0] = head
    await persistJournalQueue()
    if (mounted.current) {
      setSavedState('saving')
      setSaveError(null)
    }

    let continueWithNext = false
    try {
      const envelope = await client.putCanvas({
        baseRevision: head.baseRevision,
        mutationId: head.mutationId,
        changeKind: head.changeKind,
        document: head.document,
      }, { projectDir, branch })
      if (envelope.branch !== branch) {
        throw new DaemonProtocolError(
          `PUT /canvas returned branch ${envelope.branch} while saving ${branch}`,
        )
      }

      revision.current = envelope.revision
      lastMutationId.current = envelope.lastMutationId
      latestRunByNodeId.current = envelope.document.latestRunByNodeId
      lastSavedFingerprint.current = head.fingerprint
      if (saveQueue.current[0]?.mutationId === head.mutationId) {
        saveQueue.current = saveQueue.current.slice(1).map((entry) => ({
          ...entry,
          baseRevision: envelope.revision,
          attempted: false,
        }))
      }
      if (saveQueue.current[0]) {
        continueWithNext = true
      } else {
        lastEnqueuedFingerprint.current = head.fingerprint
      }
      if (saveQueue.current.length > 0) {
        journalCandidates.current.set(writerId, {
          writerId,
          entries: [...saveQueue.current],
          updatedAt: Date.now(),
          discardedEntries: 0,
        })
      } else {
        journalCandidates.current.delete(writerId)
      }
      await persistJournalQueue()
      if (mounted.current) {
        setSavedState(continueWithNext ? 'local-pending' : 'saved')
        setSaveError(null)
      }
    } catch (error) {
      const conflict = error instanceof DaemonHttpError && error.status === 409
      saveBlockedByConflict.current = conflict
      if (mounted.current) {
        setSavedState(conflict ? 'conflict' : 'error')
        setSaveError(persistenceMessage(error))
      }
    } finally {
      saveInFlight.current = false
      if (continueWithNext && !saveBlockedByConflict.current) {
        void flushSaveRef.current()
      }
    }
  }, [branch, clearSaveTimers, client, persistJournalQueue, projectDir, writerId])
  flushSaveRef.current = () => { void flushSave() }

  const enqueueDocument = useCallback((document: DaemonCanvasDocumentV1) => {
    const fingerprint = documentFingerprint(document)
    if (fingerprint === lastEnqueuedFingerprint.current) return

    if (fingerprint === lastSavedFingerprint.current
      && !saveInFlight.current
      && !saveQueue.current[0]?.attempted) {
      saveQueue.current = []
      journalCandidates.current.delete(writerId)
      lastEnqueuedFingerprint.current = fingerprint
      clearSaveTimers()
      void persistJournalQueue()
      if (!saveBlockedByConflict.current) {
        setSavedState('saved')
        setSaveError(null)
      }
      return
    }

    const entry: CanvasJournalEntry = {
      mutationId: globalThis.crypto?.randomUUID?.() ?? uid('mutation'),
      baseRevision: revision.current,
      changeKind: 'autosave',
      createdAt: Date.now(),
      attempted: false,
      fingerprint,
      document,
    }
    const queue = saveQueue.current
    if (queue.length === 0) queue.push(entry)
    else if (saveInFlight.current || queue[0].attempted) {
      if (queue.length === 1) queue.push(entry)
      else queue[queue.length - 1] = entry
    } else {
      queue[0] = entry
    }
    lastEnqueuedFingerprint.current = fingerprint
    journalCandidates.current.set(writerId, {
      writerId,
      entries: [...queue],
      updatedAt: Date.now(),
      discardedEntries: 0,
    })
    void persistJournalQueue()
    if (!saveBlockedByConflict.current) {
      setSavedState(saveInFlight.current ? 'saving' : 'local-pending')
      setSaveError(null)
      scheduleSave()
    }
  }, [clearSaveTimers, persistJournalQueue, scheduleSave, writerId])

  const retryHydration = useCallback(() => {
    hydrated.current = false
    hydrationPromise.current = null
    saveBlockedByConflict.current = false
    clearSaveTimers()
    setHydrationState('loading')
    setHydrationError(null)
    setSavedState('loading')
    setSaveError(null)
    setDiscoveredRuns(null)
    setHydrationAttempt((attempt) => attempt + 1)
  }, [clearSaveTimers])

  const retrySave = useCallback(() => {
    if (saveBlockedByConflict.current || saveQueue.current.length === 0) return
    setSavedState('local-pending')
    setSaveError(null)
    scheduleSave(true)
  }, [scheduleSave])

  const preserveConflictAsBranch = useCallback(async (rawName: string, candidateWriterId?: string) => {
    const name = rawName.trim()
    const selectedCandidate = candidateWriterId
      ? journalCandidates.current.get(candidateWriterId)
      : journalCandidates.current.get(writerId)
        ?? [...journalCandidates.current.values()].sort(
          (left, right) => right.updatedAt - left.updatedAt,
        )[0]
    const pending = selectedCandidate?.entries.at(-1) ?? saveQueue.current.at(-1)
    if (!saveBlockedByConflict.current || !pending) {
      throw new DaemonClientError('There is no conflicted canvas snapshot to preserve')
    }
    if (!name || name === branch) {
      throw new DaemonClientError('Choose a new branch name for the conflicted snapshot')
    }
    setSavedState('saving')
    setSaveError(null)
    try {
      const created = await client.createCanvasBranch({
        projectDir,
        name,
        fromBranch: branch,
      })
      if (!created.ok) throw new DaemonClientError(created.error.message)
      await client.putCanvas({
        baseRevision: created.value.canvas.revision,
        mutationId: globalThis.crypto.randomUUID(),
        changeKind: 'conflict-preserved',
        document: pending.document,
      }, { projectDir, branch: name })

      const sourceWriterId = selectedCandidate?.writerId ?? writerId
      journalCandidates.current.delete(sourceWriterId)
      if (sourceWriterId === writerId) {
        saveQueue.current = []
        await persistJournalQueue()
      } else {
        await deleteCanvasJournal(persistenceScope, sourceWriterId)
      }
      setJournalConflictWriters([...journalCandidates.current.keys()])
      saveBlockedByConflict.current = false
      if (!mounted.current) return
      setSavedState('saved')
      setSaveError(null)
      navigateToBranchRef.current(name)
    } catch (error) {
      saveBlockedByConflict.current = true
      if (mounted.current) {
        setSavedState('conflict')
        setSaveError(persistenceMessage(error))
      }
      throw error
    }
  }, [branch, client, persistJournalQueue, persistenceScope, projectDir, writerId])

  useEffect(() => {
    let cancelled = false
    if (!hydrationPromise.current || hydrationPromise.current.attempt !== hydrationAttempt) {
      hydrationPromise.current = {
        attempt: hydrationAttempt,
        value: client.getCanvas({ projectDir, branch }),
      }
    }

    void Promise.all([
      hydrationPromise.current.value,
      readCanvasJournals(persistenceScope).catch((error: unknown) => {
        console.warn('[ggai] Unable to read canvas safety journals', error)
        return []
      }),
      readCanvasCamera(persistenceScope).catch((error: unknown) => {
        console.warn('[ggai] Unable to restore canvas camera', error)
        return null
      }),
    ]).then(([envelope, storedCandidates, storedCamera]) => {
      if (cancelled) return
      if (envelope.branch !== branch) {
        throw new DaemonProtocolError(
          `GET /canvas returned branch ${envelope.branch} while loading ${branch}`,
        )
      }

      revision.current = envelope.revision
      lastMutationId.current = envelope.lastMutationId
      latestRunByNodeId.current = envelope.document.latestRunByNodeId
      const serverFingerprint = documentFingerprint(envelope.document)
      lastSavedFingerprint.current = serverFingerprint

      const candidates: CanvasJournalCandidate[] = []
      const journalRepairs: Promise<void>[] = []
      for (const storedCandidate of storedCandidates) {
        const normalized: CanvasJournalCandidate = {
          ...storedCandidate,
          entries: storedCandidate.entries.map((entry) => {
            const document = normalizeHydratedDocument(entry.document)
            return { ...entry, document, fingerprint: documentFingerprint(document) }
          }),
        }
        const reconciled = reconcileCanvasJournalCandidate(normalized, {
          revision: envelope.revision,
          lastMutationId: envelope.lastMutationId,
        })
        if (!reconciled.candidate) {
          journalRepairs.push(deleteCanvasJournal(persistenceScope, normalized.writerId))
          continue
        }
        candidates.push(reconciled.candidate)
        if (reconciled.acknowledged) {
          journalRepairs.push(writeCanvasJournal(
            persistenceScope,
            reconciled.candidate.writerId,
            reconciled.candidate.entries,
          ))
        }
      }
      if (journalRepairs.length > 0) {
        void Promise.allSettled(journalRepairs).then((results) => {
          if (results.some((result) => result.status === 'rejected')) {
            console.warn('[ggai] Unable to finish canvas journal recovery cleanup')
          }
        })
      }

      journalCandidates.current = new Map(candidates.map((candidate) => [
        candidate.writerId,
        candidate,
      ]))
      const selection = selectCanvasJournalCandidates(candidates, writerId, envelope.revision)
      const { ownCandidate, foreignCandidates, conflict } = selection
      // Separate writer partitions are never merged or selected implicitly.
      const entries = ownCandidate?.entries ?? []
      saveQueue.current = entries
      saveBlockedByConflict.current = conflict
      setJournalConflictWriters(conflict ? candidates.map((candidate) => candidate.writerId) : [])

      const loadedDocument = entries.at(-1)?.document
        ?? normalizeHydratedDocument(envelope.document)
      latestRunByNodeId.current = loadedDocument.latestRunByNodeId
      lastEnqueuedFingerprint.current = entries.at(-1)?.fingerprint ?? serverFingerprint
      setNodes(loadedDocument.nodes)
      setEdges(loadedDocument.edges)
      setEverCreated(loadedDocument.everCreated)
      setGenerationByNodeId(loadedDocument.generationByNodeId)
      runRefsByNodeIdRef.current = loadedDocument.runRefsByNodeId
      setRunRefsByNodeId(loadedDocument.runRefsByNodeId)
      if (storedCamera) setCameraState(storedCamera)
      hydrated.current = true
      setHydrationState('ready')
      setHydrationError(null)
      setSavedState(conflict ? 'conflict' : entries.length > 0 ? 'local-pending' : 'saved')
      setSaveError(conflict
        ? foreignCandidates.length > 0
          ? `检测到 ${foreignCandidates.length} 个其他页面的未保存候选；它们已隔离保留，不会自动合并`
          : '画布已被其他页面修改，本地改动已安全保留'
        : null)
      if (entries.length > 0 && !conflict) scheduleSave(true)
    }).catch((error: unknown) => {
      if (cancelled) return
      hydrated.current = false
      const message = persistenceMessage(error)
      setHydrationState('error')
      setHydrationError(message)
      setSavedState('error')
      setSaveError(message)
    })

    return () => { cancelled = true }
  }, [branch, client, hydrationAttempt, persistenceScope, projectDir, scheduleSave, writerId])

  useEffect(() => {
    if (hydrationState !== 'ready') return
    const controller = new AbortController()
    void client.listRuns({ projectDir, branch, limit: 2_000 }, controller.signal)
      .then((summaries) => {
        if (controller.signal.aborted || !mounted.current) return
        // The daemon applies the branch filter, but the browser validates it
        // again before attaching a stream or associating a run with a node.
        setDiscoveredRuns(summaries.filter((summary) => summary.canvasBranch === branch))
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || !mounted.current) return
        console.warn('[ggai] Unable to discover active daemon runs', error)
        setDiscoveredRuns([])
      })
    return () => controller.abort()
  }, [branch, client, hydrationState, projectDir])

  useEffect(() => {
    if (hydrationState !== 'ready' || discoveredRuns === null) return
    const initiated: string[] = []
    const controllers: AbortController[] = []
    const restored = restoredRunIds.current
    const restorationNodes = nodesRef.current

    const refsToRestore = { ...runRefsByNodeIdRef.current }
    const activeSummaries = discoveredRuns
      .filter((summary) => summary.status === 'preparing'
        || summary.status === 'running'
        || summary.status === 'awaiting-permission')
      .sort((left, right) => right.startedAt - left.startedAt)
    let discoveredReference = false
    for (const summary of activeSummaries) {
      if (summary.canvasBranch !== branch || refsToRestore[summary.nodeId]) continue
      const target = restorationNodes.find((node) => node.id === summary.nodeId)
      if (!target) continue
      refsToRestore[summary.nodeId] = {
        runId: summary.runId,
        lastEventId: 0,
        previousPhase: target.instruction.phase === 'done' ? 'done' : 'idle',
      }
      latestRunByNodeId.current[summary.nodeId] = summary.runId
      discoveredReference = true
    }
    if (discoveredReference) updateRunRefs(() => refsToRestore)

    for (const [nodeId, persistedRef] of Object.entries(refsToRestore)) {
      if (restored.has(persistedRef.runId)) continue
      const target = restorationNodes.find((node) => node.id === nodeId)
      if (!target) continue
      restored.add(persistedRef.runId)
      latestRunByNodeId.current[nodeId] = persistedRef.runId
      initiated.push(persistedRef.runId)
      const controller = new AbortController()
      controllers.push(controller)

      void (async () => {
        const summary = await client.getRun(persistedRef.runId, projectDir, controller.signal)
        if (summary.nodeId !== nodeId) {
          throw new DaemonProtocolError(`Run ${summary.runId} belongs to a different node`)
        }
        if (summary.canvasBranch !== branch) {
          throw new DaemonProtocolError(`Run ${summary.runId} belongs to a different canvas branch`)
        }

        let panel = createGenerationPanel(
          generationByNodeId[nodeId]?.epoch ?? ++nextRunEpoch.current,
        )
        latestRunEpoch.current.set(nodeId, panel.epoch)
        let responseText = ''
        let lastEventId = 0
        let closeEvent: DaemonCloseEvent | null = null
        const artifactPaths = new Set<string>()
        let cursor = 0
        while (true) {
          const page = await client.getRunLog(summary.runId, {
            projectDir,
            afterEventId: cursor,
            limit: 2_000,
          }, controller.signal)
          for (const rawEntry of page.entries) {
            const entry = decodeDaemonRunLogEntry(rawEntry, summary.runId)
            lastEventId = Math.max(lastEventId, entry.id)
            if (entry.event === 'agent-event') {
              if (entry.data.type === 'text-delta') responseText += entry.data.text
              if (entry.data.type === 'file-write'
                && (!entry.data.nodeId || entry.data.nodeId === nodeId)) {
                artifactPaths.add(entry.data.path)
              }
              panel = advanceGenerationPanel(panel, entry.data, target.type)
            } else if (entry.event === 'close') {
              closeEvent = entry.data
            }
          }
          if (page.nextEventId === null) break
          cursor = page.nextEventId
        }
        if (controller.signal.aborted || !mounted.current) return
        setGenerationByNodeId((current) => ({ ...current, [nodeId]: panel }))
        updateRunRefs((current) => {
          const ref = current[nodeId]
          if (!ref || ref.runId !== summary.runId) return current
          return { ...current, [nodeId]: { ...ref, lastEventId } }
        })

        const settle = (
          status: 'done' | 'error' | 'cancelled' | 'interrupted',
          close: DaemonCloseEvent | null,
          error?: string,
        ) => {
          if (!mounted.current
            || controller.signal.aborted
            || latestRunEpoch.current.get(nodeId) !== panel.epoch
            || latestRunByNodeId.current[nodeId] !== summary.runId) return
          setNodes((current) => {
            const settled = current.map((node) => {
              if (node.id !== nodeId
                || latestRunEpoch.current.get(nodeId) !== panel.epoch
                || latestRunByNodeId.current[nodeId] !== summary.runId) return node
              const artifacts = close?.artifactsComplete
                ? close.artifacts
                : [...new Set([
                    ...(Array.isArray(node.payload?.artifactFiles)
                      ? node.payload.artifactFiles.filter((entry): entry is string => typeof entry === 'string')
                      : []),
                    ...artifactPaths,
                  ])]
              if (status === 'done') {
                return applyRunOutcome(node, {
                  runId: summary.runId,
                  responseText,
                  artifactFiles: artifacts,
                  ...(close?.outcome ? { outcome: close.outcome } : {}),
                })
              }
              const message = status === 'interrupted'
                ? `执行中断 · ${compactErrorMessage(error || '本地服务重启，任务未能继续')}`
                : status === 'error'
                  ? `执行失败 · ${compactErrorMessage(error || 'Agent 进程异常退出')}`
                  : null
              return settleUnsuccessfulRun(node, {
                previousPhase: persistedRef.previousPhase,
                ...(close?.artifactsComplete ? { artifactFiles: close.artifacts } : {}),
                message,
              })
            })
            return invalidateSuggestions(
              settled,
              downstreamNodeIds(edgesRef.current, [nodeId]),
            )
          })
        }

        if (summary.status === 'done'
          || summary.status === 'error'
          || summary.status === 'cancelled'
          || summary.status === 'interrupted') {
          settle(summary.status, closeEvent, summary.error)
          clearRunRef(nodeId, summary.runId)
          return
        }

        const run: ActiveCanvasRun = {
          epoch: panel.epoch,
          controller,
          previousPhase: persistedRef.previousPhase,
          completion: Promise.resolve(),
          runId: summary.runId,
        }
        activeRuns.current.set(nodeId, run)
        latestRunEpoch.current.set(nodeId, panel.epoch)
        setNodes((current) => invalidateSuggestions(current.map((node) => node.id === nodeId
          ? {
              ...node,
              instruction: {
                ...clearSuggestedActions(node.instruction),
                phase: 'generating',
                open: false,
              },
            }
          : node), new Set([
          nodeId,
          ...downstreamNodeIds(edgesRef.current, [nodeId]),
        ])))
        const onEvent = (event: CanvasAgentEvent) => {
          if (controller.signal.aborted || activeRuns.current.get(nodeId) !== run) return
          if (event.type === 'text-delta') responseText += event.text
          if (event.type === 'file-write' && (!event.nodeId || event.nodeId === nodeId)) {
            artifactPaths.add(event.path)
          }
          setGenerationByNodeId((current) => {
            const currentPanel = current[nodeId]
            if (!currentPanel || currentPanel.epoch !== run.epoch) return current
            const nextPanel = advanceGenerationPanel(currentPanel, event, target.type)
            return nextPanel === currentPanel ? current : { ...current, [nodeId]: nextPanel }
          })
        }
        run.completion = client.attachRun(summary.runId, {
          signal: controller.signal,
          projectDir,
          sessionId: summary.sessionId,
          afterEventId: lastEventId,
          onEvent,
          onEventId: (eventId) => updateRunRefs((current) => {
            const ref = current[nodeId]
            if (!ref || ref.runId !== summary.runId || ref.lastEventId >= eventId) return current
            return { ...current, [nodeId]: { ...ref, lastEventId: eventId } }
          }),
        }).then((result) => {
          const status = result.close.status === 'done'
            ? 'done'
            : result.close.status === 'error' ? 'error' : 'cancelled'
          settle(status, result.close)
          clearRunRef(nodeId, summary.runId)
        }).catch((error: unknown) => {
          if (!controller.signal.aborted) console.warn('[ggai] Run subscription disconnected', error)
        }).finally(() => {
          if (activeRuns.current.get(nodeId) === run) activeRuns.current.delete(nodeId)
        })
      })().catch((error: unknown) => {
        if (controller.signal.aborted || !mounted.current) return
        console.warn('[ggai] Unable to restore persisted run', error)
        setNodes((current) => invalidateSuggestions(current.map((node) => node.id === nodeId
          ? settleUnsuccessfulRun(node, {
              previousPhase: persistedRef.previousPhase,
              message: '执行中断 · 无法恢复本地运行记录',
            })
          : node), new Set([
          nodeId,
          ...downstreamNodeIds(edgesRef.current, [nodeId]),
        ])))
        clearRunRef(nodeId, persistedRef.runId)
      })
    }

    return () => {
      for (const controller of controllers) controller.abort()
      for (const runId of initiated) restored.delete(runId)
    }
    // Run references are captured from the hydration snapshot. Cursor updates
    // must not tear down and recreate the live SSE attachment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch, clearRunRef, client, discoveredRuns, hydrationState, projectDir, updateRunRefs])

  useEffect(() => {
    if (!hydrated.current) return
    enqueueDocument({
      schemaVersion: 1,
      nodes,
      edges,
      everCreated,
      generationByNodeId,
      latestRunByNodeId: latestRunByNodeId.current,
      runRefsByNodeId,
    })
  }, [edges, enqueueDocument, everCreated, generationByNodeId, nodes, runRefsByNodeId])

  useEffect(() => {
    if (!hydrated.current) return
    if (cameraSaveTimer.current) clearTimeout(cameraSaveTimer.current)
    cameraSaveTimer.current = setTimeout(() => {
      cameraSaveTimer.current = null
      void writeCanvasCamera(persistenceScope, camera).catch((error: unknown) => {
        console.warn('[ggai] Unable to persist canvas camera', error)
      })
    }, 250)
    return () => {
      if (cameraSaveTimer.current) clearTimeout(cameraSaveTimer.current)
      cameraSaveTimer.current = null
    }
  }, [camera, hydrationState, persistenceScope])

  const clearGeneration = useCallback((id: string, epoch?: number) => {
    setGenerationByNodeId((current) => {
      const panel = current[id]
      if (!panel || (epoch !== undefined && panel.epoch !== epoch)) return current
      const next = { ...current }
      delete next[id]
      return next
    })
  }, [])

  const setCamera = useCallback((c: Camera) => setCameraState(c), [])

  const zoomTo = useCallback((zoom: number, cx?: number, cy?: number) => {
    setCameraState((cam) => {
      const z = Math.min(2, Math.max(0.25, zoom))
      const px = cx ?? window.innerWidth / 2
      const py = cy ?? window.innerHeight / 2
      const wx = (px - cam.x) / cam.zoom
      const wy = (py - cam.y) / cam.zoom
      return { zoom: z, x: px - wx * z, y: py - wy * z }
    })
  }, [])

  const fitView = useCallback(() => {
    setCameraState(() => {
      if (nodes.length === 0) return { x: 80, y: 60, zoom: 1 }
      const minX = Math.min(...nodes.map((n) => n.x)) - 80
      const minY = Math.min(...nodes.map((n) => n.y)) - 80
      const maxX = Math.max(...nodes.map((n) => n.x + n.w)) + 80
      const maxY = Math.max(...nodes.map((n) => n.y + n.h)) + 160
      const vw = window.innerWidth - 64
      const vh = window.innerHeight - 120
      const z = Math.min(1.2, Math.max(0.25, Math.min(vw / (maxX - minX), vh / (maxY - minY))))
      return { zoom: z, x: (vw - (maxX - minX) * z) / 2 + 56 - minX * z, y: (vh - (maxY - minY) * z) / 2 + 56 - minY * z }
    })
  }, [nodes])

  const select = useCallback((id: string | null) => {
    setSelectedId(id)
    setSelectedIds(id ? [id] : [])
  }, [])

  const selectMany = useCallback((ids: string[]) => {
    setSelectedIds(ids)
    setSelectedId(ids[0] ?? null)
  }, [])

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((ids) => {
      const next = ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id]
      setSelectedId(next[next.length - 1] ?? null)
      return next
    })
  }, [])

  const addNode = useCallback((type: NodeType, x: number, y: number) => {
    const n = makeNode(type, x, y)
    setNodes((ns) => [...ns, n])
    setSelectedId(n.id)
    setSelectedIds([n.id])
    setEverCreated(true)
    touch()
    return n
  }, [touch])

  const updateNode = useCallback((id: string, patch: Partial<CanvasNode>) => {
    const semanticChange = patchChangesSemanticContent(patch)
    const invalidatedIds = semanticChange
      ? new Set([id, ...downstreamNodeIds(edgesRef.current, [id])])
      : new Set<string>()
    setNodes((ns) => invalidateSuggestions(ns.map((n) => {
      if (n.id !== id) return n
      return { ...n, ...patch }
    }), invalidatedIds))
    touch()
  }, [touch])

  const reportSize = useCallback((id: string, w: number, h: number) => {
    setNodes((ns) => ns.map((n) =>
      n.id === id && (Math.abs(n.h - h) > 1 || Math.abs(n.w - w) > 1) ? { ...n, h, w } : n))
  }, [])

  const removeNode = useCallback((id: string) => {
    const run = activeRuns.current.get(id)
    if (run) {
      run.controller.abort()
      if (run.runId) void client.cancelRun(run.runId).catch(() => undefined)
      activeRuns.current.delete(id)
    }
    artifactHydrations.current.get(id)?.abort()
    artifactHydrations.current.delete(id)
    latestRunEpoch.current.delete(id)
    pendingSmartPatches.current.delete(id)
    clearGeneration(id)
    updateRunRefs((current) => {
      if (!(id in current)) return current
      const next = { ...current }
      delete next[id]
      return next
    })
    delete latestRunByNodeId.current[id]
    const nextEdges = edgesRef.current.filter((edge) => edge.from !== id && edge.to !== id)
    edgesRef.current = nextEdges
    setEdges(nextEdges)
    setNodes((ns) => syncLegacySourceMirrors(ns.filter((n) => n.id !== id), nextEdges))
    setSelectedId((s) => (s === id ? null : s))
    setSelectedIds((ids) => ids.filter((i) => i !== id))
    touch()
  }, [clearGeneration, client, touch, updateRunRefs])

  const duplicateNode = useCallback((id: string) => {
    setNodes((ns) => {
      const src = ns.find((n) => n.id === id)
      if (!src) return ns
      const copy: CanvasNode = {
        ...src,
        id: uid(),
        x: src.x + 40,
        y: src.y + 40,
        meta: src.meta ? [...src.meta] : undefined,
        instruction: {
          ...clearSuggestedActions(src.instruction),
          sources: [],
          attachments: [...src.instruction.attachments],
        },
        smart: src.smart ? { ...src.smart } : undefined,
      }
      setSelectedId(copy.id)
      setSelectedIds([copy.id])
      return [...ns, copy]
    })
    touch()
  }, [touch])

  const addEdge = useCallback((from: string, to: string) => {
    if (from === to) return
    if (edgesRef.current.some((edge) => edge.from === from && edge.to === to)) return
    const nextEdges: Edge[] = [...edgesRef.current, { id: uid('e'), from, to, label: '来源于' }]
    edgesRef.current = nextEdges
    setEdges(nextEdges)
    // sources 只是由 Edge 派生的兼容镜像；来源变化后旧建议失效。
    const invalidated = new Set([to, ...downstreamNodeIds(nextEdges, [to])])
    setNodes((ns) => invalidateSuggestions(ns.map((n) => {
      if (n.id !== to) return n
      return {
        ...n,
        instruction: {
          ...n.instruction,
          sources: sourceIdsForNode(nextEdges, to),
        },
      }
    }), invalidated))
    touch()
  }, [touch])

  const removeEdge = useCallback((id: string) => {
    const removed = edgesRef.current.find((edge) => edge.id === id)
    if (!removed) return
    const nextEdges = edgesRef.current.filter((edge) => edge.id !== id)
    edgesRef.current = nextEdges
    setEdges(nextEdges)
    const invalidated = new Set([removed.to, ...downstreamNodeIds(nextEdges, [removed.to])])
    setNodes((nodes) => invalidateSuggestions(nodes.map((node) => node.id === removed.to
      ? {
          ...node,
          instruction: {
            ...node.instruction,
            sources: sourceIdsForNode(nextEdges, node.id),
          },
        }
      : node), invalidated))
    touch()
  }, [touch])

  const cycleEdgeLabel = useCallback((id: string) => {
    const LABELS = ['来源于', '提取自', '引用了', '生成自', '修改自', '对照', '替换']
    const changed = edgesRef.current.find((edge) => edge.id === id)
    if (!changed) return
    const nextEdges = edgesRef.current.map((e) => {
      if (e.id !== id) return e
      const i = LABELS.indexOf(e.label)
      return { ...e, label: LABELS[(i + 1) % LABELS.length] }
    })
    edgesRef.current = nextEdges
    setEdges(nextEdges)
    setNodes((nodes) => invalidateSuggestions(
      nodes,
      new Set([changed.to, ...downstreamNodeIds(nextEdges, [changed.to])]),
    ))
    touch()
  }, [touch])

  const openCreateMenu = useCallback((menu: CreateMenuState) => {
    createMenuRef.current = menu
    setCreateMenu(menu)
  }, [])
  const closeCreateMenu = useCallback(() => {
    createMenuRef.current = null
    setCreateMenu(null)
  }, [])

  const createFromMenu = useCallback((type: NodeType) => {
    // Consume the menu exactly once before doing any work. React StrictMode may
    // call state updater functions twice, so node creation must never live in a
    // `setCreateMenu(current => ...)` updater.
    const menu = createMenuRef.current
    if (!menu) return
    createMenuRef.current = null
    setCreateMenu(null)

    const node = makeNode(type, menu.wx, menu.wy)
    const sourceIds = [...new Set(menu.sourceIds ?? [])].filter((sourceId) => sourceId !== node.id)
    if (sourceIds.length > 0) {
      // Compatibility mirror only; the edges below are the authoritative relation.
      node.instruction = { ...node.instruction, sources: sourceIds }
      const candidateEdges: Edge[] = sourceIds.map((sourceId) => ({
        id: uid('e'),
        from: sourceId,
        to: node.id,
        label: '来源于',
      }))
      const nextEdges = [
        ...edgesRef.current,
        ...candidateEdges.filter((candidate) => !edgesRef.current.some((edge) =>
          edge.from === candidate.from && edge.to === candidate.to)),
      ]
      edgesRef.current = nextEdges
      setEdges(nextEdges)
    }
    setNodes((existing) => [...existing, node])
    setSelectedId(node.id)
    setSelectedIds([node.id])
    setEverCreated(true)
    touch()
  }, [touch])

  /* ---------- 指令区：所有节点通用 ---------- */

  const updateInstruction = useCallback((id: string, patch: Partial<InstructionState>) => {
    const authoritativePatch = { ...patch }
    delete authoritativePatch.sources
    setNodes((ns) => ns.map((n) =>
      n.id === id ? { ...n, instruction: { ...n.instruction, ...authoritativePatch } } : n))
    touch()
  }, [touch])

  const requestRunCancellation = useCallback((id: string, run: ActiveCanvasRun) => {
    if (run.cancelPromise) return run.cancelPromise
    const cancellation = client.cancelRun(run.runId).then(() => {
      clearRunRef(id, run.runId)
      run.controller.abort()
    }).catch((error: unknown) => {
      run.cancelPromise = undefined
      if (mounted.current) {
        setNodes((current) => current.map((node) => node.id === id
          ? {
              ...node,
              meta: [
                ...(node.meta ?? []).filter((entry) => !entry.startsWith('取消失败 ·')),
                `取消失败 · ${compactErrorMessage(
                  error instanceof Error ? error.message : '本地服务未确认取消',
                )}`,
              ],
            }
          : node))
      }
      throw error
    })
    run.cancelPromise = cancellation
    return cancellation
  }, [clearRunRef, client])

  const runInstruction = useCallback((id: string) => {
    // React may not have committed updateSmart yet when a toolbar handler updates
    // a seed and immediately runs. Fold the pending patch into this wire snapshot.
    const smartPatch = pendingSmartPatches.current.get(id)
    const runNodes = smartPatch
      ? nodes.map((node) => node.id === id && node.smart
        ? { ...node, smart: { ...node.smart, ...smartPatch } }
        : node)
      : nodes
    const target = runNodes.find((node) => node.id === id)
    if (!target) return
    pendingSmartPatches.current.delete(id)
    artifactHydrations.current.get(id)?.abort()
    artifactHydrations.current.delete(id)
    const previous = activeRuns.current.get(id)
    const controller = new AbortController()
    const requestedRunId = globalThis.crypto.randomUUID()
    const run: ActiveCanvasRun = {
      epoch: ++nextRunEpoch.current,
      controller,
      previousPhase: previous?.previousPhase
        ?? (target.instruction.phase === 'generating' ? 'idle' : target.instruction.phase),
      completion: Promise.resolve(),
      runId: requestedRunId,
    }
    pendingRunEpochs.current.set(id, run.epoch)

    const isCurrentRun = () => {
      const active = activeRuns.current.get(id)
      return mounted.current
        && active?.epoch === run.epoch
        && !controller.signal.aborted
    }

    let responseText = ''
    let agentError = ''
    const artifactPaths = new Set<string>()
    const onEvent = (event: CanvasAgentEvent) => {
      if (!isCurrentRun()) return
      if (event.type === 'text-delta') {
        responseText += event.text
      }
      else if (event.type === 'error') agentError = event.message
      else if (event.type === 'file-write' && (!event.nodeId || event.nodeId === id)) {
        artifactPaths.add(event.path)
        setNodes((current) => current.map((node) => {
          if (node.id !== id) return node
          const existing = Array.isArray(node.payload?.artifactFiles)
            ? node.payload.artifactFiles.filter((entry): entry is string => typeof entry === 'string')
            : []
          const nextArtifacts = [...new Set([...existing, event.path])]
          return {
            ...node,
            payload: { ...node.payload, artifactFiles: nextArtifacts },
          }
        }))
      }
      setGenerationByNodeId((current) => {
        const panel = current[id]
        if (!panel || panel.epoch !== run.epoch) return current
        const nextPanel = advanceGenerationPanel(panel, event, target.type)
        return nextPanel === panel ? current : { ...current, [id]: nextPanel }
      })
    }

    const plugins = listEnabledPlugins().map((plugin) => ({
      id: plugin.id,
      label: plugin.label,
      description: plugin.desc,
      instruction: {
        placeholder: plugin.instr.placeholder,
        actions: plugin.instr.actions,
      },
      initialPayload: plugin.initialPayload(),
    }))

    let runAccepted = false
    let activated = false
    const execute = async () => {
      // A replacement must wait for daemon-confirmed cancellation. Until then
      // the old run/ref remain authoritative and continue receiving events.
      if (previous) await requestRunCancellation(id, previous)
      if (!mounted.current
        || controller.signal.aborted
        || pendingRunEpochs.current.get(id) !== run.epoch) return null

      pendingRunEpochs.current.delete(id)
      activeRuns.current.set(id, run)
      latestRunEpoch.current.set(id, run.epoch)
      activated = true
      // Persist the known client-generated id before POST. The active-run
      // discovery fallback covers the narrow daemon-accepted/save-not-flushed window.
      setNodes((current) => invalidateSuggestions(current.map((node) => node.id === id
        ? {
            ...node,
            payload: withoutAgentProgress(node.payload),
            instruction: {
              ...clearSuggestedActions(node.instruction),
              phase: 'generating',
              open: false,
            },
          }
        : node), new Set([
        id,
        ...downstreamNodeIds(edgesRef.current, [id]),
      ])))
      setGenerationByNodeId((current) => ({
        ...current,
        [id]: createGenerationPanel(run.epoch),
      }))
      latestRunByNodeId.current[id] = requestedRunId
      updateRunRefs((current) => ({
        ...current,
        [id]: {
          runId: requestedRunId,
          lastEventId: 0,
          previousPhase: run.previousPhase,
        },
      }))
      touch()

      const created = await client.startRun({
        runId: requestedRunId,
        nodeId: id,
        agentId: DAEMON_AGENT_ID,
        sessionId: null,
        prompt: target.instruction.prompt,
        canvasSnapshot: { nodes: runNodes, edges, plugins },
        plugins,
        projectDir,
        canvasBranch: branch,
        onEvent,
        signal: controller.signal,
      })
      runAccepted = true
      if (!isCurrentRun()) {
        // The component detached while POST /runs was in flight. The daemon run
        // remains alive and can be recovered from its durable id on remount.
        return null
      }
      return client.attachRun(created.runId, {
        onEvent,
        signal: controller.signal,
        projectDir,
        sessionId: created.sessionId ?? null,
        onEventId: (lastEventId) => {
          if (!isCurrentRun()) return
          updateRunRefs((current) => {
            const ref = current[id]
            if (!ref || ref.runId !== created.runId || ref.lastEventId >= lastEventId) return current
            return { ...current, [id]: { ...ref, lastEventId } }
          })
        },
      })
    }

    run.completion = execute().then((result) => {
      if (!result || !isCurrentRun()) return
      if (result.close.status === 'cancelled' || result.stopReason === 'cancelled') {
        throw new DaemonRunError(
          result.close.runId,
          `Run ${result.close.runId} was cancelled`,
          'cancelled',
          result.close.artifacts,
          result.close.artifactsComplete,
        )
      }
      if (result.close.status === 'error' || result.stopReason === 'error') {
        throw new DaemonRunError(
          result.close.runId,
          `Run ${result.close.runId} failed`,
          'error',
          result.close.artifacts,
          result.close.artifactsComplete,
        )
      }
      const textArtifact = result.close.artifacts.find((artifact) => TEXT_ARTIFACT_PATTERN.test(artifact))
      const pluginMaterializer = getPlugin(target.type).materializeRunResult
      const artifactFilesForHydration = result.close.artifactsComplete
        ? result.close.artifacts
        : [...new Set([
            ...(Array.isArray(target.payload?.artifactFiles)
              ? target.payload.artifactFiles.filter((entry): entry is string => typeof entry === 'string')
              : []),
            ...artifactPaths,
          ])]
      const expectedMaterialized = materializeNodeRun(target, {
        responseText,
        artifactFiles: artifactFilesForHydration,
        ...(result.close.outcome ? { outcome: result.close.outcome } : {}),
      })
      setNodes((current) => {
        const settled = current.map((node) => {
          if (node.id !== id
            || node.instruction.phase !== 'generating'
            || latestRunEpoch.current.get(id) !== run.epoch
            || latestRunByNodeId.current[id] !== result.close.runId) return node
          const existingArtifacts = Array.isArray(node.payload?.artifactFiles)
            ? node.payload.artifactFiles.filter((entry): entry is string => typeof entry === 'string')
            : []
          const streamedPaths = [...new Set([...existingArtifacts, ...artifactPaths])]
          const paths = result.close.artifactsComplete ? result.close.artifacts : streamedPaths
          return applyRunOutcome(node, {
            runId: result.close.runId,
            responseText,
            artifactFiles: paths,
            ...(result.close.outcome ? { outcome: result.close.outcome } : {}),
          })
        })
        return invalidateSuggestions(
          settled,
          downstreamNodeIds(edgesRef.current, [id]),
        )
      })
      touch()

      if (textArtifact && pluginMaterializer) {
        const hydrationController = new AbortController()
        artifactHydrations.current.set(id, hydrationController)
        void client.artifactText(
          textArtifact,
          projectDir,
          hydrationController.signal,
        ).then((artifactText) => {
          if (!mounted.current
            || hydrationController.signal.aborted
            || latestRunEpoch.current.get(id) !== run.epoch
            || latestRunByNodeId.current[id] !== result.close.runId) return
          setNodes((current) => current.map((node) => {
            if (node.id !== id || node.instruction.phase !== 'done') return node
            const expectedFields: Array<keyof Pick<CanvasNode, 'title' | 'text' | 'meta' | 'payload'>> = [
              'title', 'text', 'meta', 'payload',
            ]
            const contentUnchanged = expectedFields.every((field) => {
              if (JSON.stringify(expectedMaterialized[field]) === JSON.stringify(target[field])) return true
              return JSON.stringify(node[field]) === JSON.stringify(expectedMaterialized[field])
            })
            if (!contentUnchanged) return node
            return materializeNodeRun(node, {
              responseText: artifactText,
              artifactFiles: artifactFilesForHydration,
              ...(result.close.outcome ? { outcome: result.close.outcome } : {}),
            })
          }))
          touch()
        }).catch(() => {
          // The run is already complete; streamed text remains as a safe fallback.
        }).finally(() => {
          if (artifactHydrations.current.get(id) === hydrationController) {
            artifactHydrations.current.delete(id)
          }
        })
      }
      clearRunRef(id, result.close.runId)
    }).catch((error: unknown) => {
      if (!mounted.current
        || activeRuns.current.get(id)?.epoch !== run.epoch
        || controller.signal.aborted) return
      if ((runAccepted || error instanceof DaemonRunStartUncertainError)
        && !(error instanceof DaemonRunError)) {
        console.warn('[ggai] Run subscription disconnected; refresh will reconnect', error)
        setNodes((current) => current.map((node) => node.id === id
          ? {
              ...node,
              meta: [
                ...(node.meta ?? []).filter((entry) => !entry.startsWith('连接中断 ·')),
                '连接中断 · 刷新页面将自动恢复运行进度',
              ],
            }
          : node))
        return
      }
      console.error('[ggai] Agent run failed', agentError || error)
      const cancelled = isCancelledRun(error)
      if (error instanceof DaemonRunError) clearRunRef(id, error.runId)
      else clearRunRef(id, run.runId)
      const failureMessage = cancelled ? null : executionFailureMessage(error, agentError)
      const artifactSnapshot = error instanceof DaemonRunError && error.artifactsComplete
        ? error.artifacts
        : null
      setNodes((current) => invalidateSuggestions(current.map((node) => {
        if (node.id !== id
          || latestRunEpoch.current.get(id) !== run.epoch
          || latestRunByNodeId.current[id] !== run.runId) return node
        return settleUnsuccessfulRun(node, {
          previousPhase: run.previousPhase,
          ...(artifactSnapshot ? { artifactFiles: artifactSnapshot } : {}),
          message: failureMessage,
        })
      }), downstreamNodeIds(edgesRef.current, [id])))
      touch()
    }).finally(() => {
      // Keep the final generation panel: the completed footer lets the user
      // reopen the run's process/log after the run ends. The next run
      // replaces it via createGenerationPanel; remove/cancel clear it.
      if (activeRuns.current.get(id)?.epoch === run.epoch) activeRuns.current.delete(id)
      if (pendingRunEpochs.current.get(id) === run.epoch) pendingRunEpochs.current.delete(id)
      if (!activated) controller.abort()
    })
  }, [branch, clearRunRef, client, edges, nodes, projectDir, requestRunCancellation, touch, updateRunRefs])

  const cancelInstruction = useCallback((id: string) => {
    const run = activeRuns.current.get(id)
    const runId = run?.runId ?? runRefsByNodeId[id]?.runId
    if (!runId) return
    const cancellation = run
      ? requestRunCancellation(id, run)
      : client.cancelRun(runId).then(() => clearRunRef(id, runId))
    void cancellation.then(() => {
      if (!mounted.current) return
      artifactHydrations.current.get(id)?.abort()
      artifactHydrations.current.delete(id)
      clearGeneration(id)
      setNodes((current) => invalidateSuggestions(current.map((node) => node.id === id
        ? {
            ...settleUnsuccessfulRun(node, {
              previousPhase: run?.previousPhase ?? 'idle',
            }),
            meta: (node.meta ?? []).filter((entry) => !entry.startsWith('取消失败 ·')),
          }
        : node), new Set([
        id,
        ...downstreamNodeIds(edgesRef.current, [id]),
      ])))
      touch()
    }).catch((error: unknown) => {
      // requestRunCancellation already annotates active runs. A recovered ref
      // without a live subscription needs the same visible failure state.
      if (run || !mounted.current) return
      setNodes((current) => current.map((node) => node.id === id
        ? {
            ...node,
            meta: [
              ...(node.meta ?? []).filter((entry) => !entry.startsWith('取消失败 ·')),
              `取消失败 · ${compactErrorMessage(
                error instanceof Error ? error.message : '本地服务未确认取消',
              )}`,
            ],
          }
        : node))
    })
  }, [clearGeneration, clearRunRef, client, requestRunCancellation, runRefsByNodeId, touch])

  const updateSmart = useCallback((id: string, patch: Partial<SmartParams>) => {
    pendingSmartPatches.current.set(id, {
      ...pendingSmartPatches.current.get(id),
      ...patch,
    })
    const invalidated = new Set([id, ...downstreamNodeIds(edgesRef.current, [id])])
    setNodes((ns) => invalidateSuggestions(ns.map((n) =>
      n.id === id && n.smart ? { ...n, smart: { ...n.smart, ...patch } } : n), invalidated))
    touch()
  }, [touch])

  return {
    nodes, edges, camera, selectedId, selectedIds, connecting, createMenu,
    branch, hydrationState, hydrationError, savedState, saveError, journalConflictWriters,
    generationByNodeId, everCreated,
    retryHydration, retrySave, preserveConflictAsBranch,
    setCamera, zoomTo, fitView, select, selectMany, toggleSelect,
    addNode, updateNode, reportSize, removeNode, duplicateNode,
    addEdge, removeEdge, cycleEdgeLabel,
    setConnecting, openCreateMenu, closeCreateMenu, createFromMenu,
    updateInstruction, runInstruction, cancelInstruction, updateSmart,
  }
}

export { CanvasCtx }
