import {
  ArrowUp,
  History,
  Loader2,
  Mic,
} from 'lucide-react'
import {
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { DAEMON_AGENT_ID } from '@/agent/config'
import {
  buildContextTaskPlanV2,
  canvasV2ContextComposerKey,
  isEmptyUserOutputSlotV2,
  selectionIsSingleTaskV2,
} from '@/canvas-v2/contextComposer'
import { useCanvasV2State, useCanvasV2Store } from '@/canvas-v2/hooks'
import type { CanvasNodeV2, CanvasPointV2 } from '@/canvas-v2/model'
import type { CanvasV2ViewportRect } from '@/canvas-v2/interaction'
import type { CanvasV2SelectionTarget } from '@/canvas-v2/persistence'
import { CanvasV2TaskRunContext } from '@/canvas-v2/runHooks'
import type { CanvasV2TaskRunSummary } from '@/canvas-v2/runController'
import type { CanvasBoundsV2 } from '@/canvas-v2/selectors'
import { taskComposerDraftKeyV2 } from '@/canvas-v2/taskRunUi'
import { getPlugin } from '@/plugins/types'

export interface CanvasV2ContextComposerProps {
  getAnchor: () => CanvasPointV2
  /** Canonical visible selection supplied by the Stage hierarchy. */
  selectionOverride?: readonly CanvasV2SelectionTarget[]
  /** World-space bounds for the current selection. The panel remains screen-sized. */
  selectionBounds?: CanvasBoundsV2 | null
  getViewport?: () => CanvasV2ViewportRect
}

interface NodeRunProvenanceV2 {
  sourceNodeId: string
  summary: CanvasV2TaskRunSummary | null
  loading: boolean
  failed: boolean
}

const runSummaryCache = new Map<string, Promise<CanvasV2TaskRunSummary>>()

/** Context-aware Task creation. It never overwrites a selected content Node. */
export default function CanvasV2ContextComposer({
  getAnchor,
  selectionOverride,
  selectionBounds = null,
  getViewport,
}: CanvasV2ContextComposerProps) {
  const lifecycle = useContext(CanvasV2TaskRunContext)
  const store = useCanvasV2Store()
  const state = useCanvasV2State()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selection = selectionOverride ?? state.view.selection
  const draftKey = canvasV2ContextComposerKey(selection)
  const hasDraft = Object.prototype.hasOwnProperty.call(state.view.composerDrafts, draftKey)
  const draft = state.view.composerDrafts[draftKey] ?? ''
  const selectedNode = selection.length === 1 && selection[0]?.kind === 'node'
    ? state.document.nodes.find((entry) => entry.id === selection[0]?.id) ?? null
    : null
  const provenanceOrigin = useMemo(
    () => selectedNode ? resolveRunOriginV2(state.document.nodes, selectedNode) : null,
    [selectedNode, state.document.nodes],
  )
  const [provenance, setProvenance] = useState<NodeRunProvenanceV2 | null>(null)

  useEffect(() => {
    if (!lifecycle || !selectedNode || !provenanceOrigin) {
      setProvenance(null)
      return
    }
    let current = true
    setProvenance({
      sourceNodeId: provenanceOrigin.sourceNodeId,
      summary: null,
      loading: true,
      failed: false,
    })
    const cacheKey = `${state.scope.projectDir}\u0000${provenanceOrigin.runId}`
    let request = runSummaryCache.get(cacheKey)
    if (!request) {
      request = lifecycle.readTaskRunSummary(provenanceOrigin.runId)
      runSummaryCache.set(cacheKey, request)
      void request.catch(() => runSummaryCache.delete(cacheKey))
    }
    void request.then(
      (summary) => {
        if (!current) return
        const trusted = summary.runId === provenanceOrigin.runId
          && summary.taskId === provenanceOrigin.taskId
        setProvenance({
          sourceNodeId: provenanceOrigin.sourceNodeId,
          summary: trusted ? summary : null,
          loading: false,
          failed: !trusted,
        })
      },
      () => {
        if (!current) return
        setProvenance({
          sourceNodeId: provenanceOrigin.sourceNodeId,
          summary: null,
          loading: false,
          failed: true,
        })
      },
    )
    return () => {
      current = false
    }
  }, [lifecycle, provenanceOrigin, selectedNode, state.scope.projectDir])

  const originTask = provenanceOrigin
    ? state.document.tasks.find((task) => task.id === provenanceOrigin.taskId) ?? null
    : null
  const provenancePrompt = provenance?.summary?.prompt
    ?? (provenance?.failed ? originTask?.goal : undefined)

  useEffect(() => {
    if (!selectedNode || !provenancePrompt || hasDraft) return
    store.setComposerDraft(draftKey, provenancePrompt)
  }, [draftKey, hasDraft, provenancePrompt, selectedNode, store])

  // A selected Task owns its continuation composer and stable session.
  if (!lifecycle || selectionIsSingleTaskV2(selection)) return null

  const context = describeContext()
  const plugin = selectedNode ? getPlugin(selectedNode.type) : null
  const PluginIcon = plugin?.icon
  const sourceNodes = selectedNode ? selectSourceNodesV2(state.document.nodes, state.document.edges, selectedNode) : []
  const suggestedActions = selectedNode
    ? (provenanceOrigin ? lifecycle.getSuggestedActions(provenanceOrigin.taskId) : [])
    : []
  const actionPrompts = suggestedActions.length > 0
    ? suggestedActions.map((action) => ({ id: action.id, label: action.label, prompt: action.prompt }))
    : (plugin?.instr.actions ?? []).map((prompt, index) => ({
        id: `plugin-${index}-${prompt}`,
        label: prompt,
        prompt,
      }))
  const attached = selection.length > 0 && selectionBounds !== null
  const panelStyle = attached
    ? attachedComposerStyleV2({
        bounds: selectionBounds,
        camera: state.view.camera,
        viewport: getViewport?.(),
        compound: selection.length > 1,
        provenance: Boolean(provenanceOrigin),
      })
    : undefined

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    const prompt = draft.trim()
    if (!prompt || submitting) return
    setSubmitting(true)
    setError(null)
    const taskId = createClientTaskIdV2()
    try {
      const plan = buildContextTaskPlanV2({
        document: state.document,
        selection,
        prompt,
        anchor: getAnchor(),
        taskId,
      })
      // dispatchCommand first records the Task command in the durable outbox;
      // runTask then flushes that outbox before constructing RunIntent V2.
      await store.dispatchCommand(plan.command)
      store.setComposerDraft(taskComposerDraftKeyV2(taskId), prompt)
      store.setSelection([{ kind: 'task', id: taskId }])
      await lifecycle.startTask({ taskId, agentId: DAEMON_AGENT_ID, prompt })
      store.setComposerDraft(draftKey, '')
      store.setComposerDraft(taskComposerDraftKeyV2(taskId), '')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return
    event.preventDefault()
    void submit()
  }

  return (
    <form
      data-testid="canvas-v2-context-composer"
      data-attached={attached ? 'true' : 'false'}
      data-no-drag
      aria-label={context.label}
      onSubmit={(event) => void submit(event)}
      onPointerDown={(event) => event.stopPropagation()}
      className={attached
        ? 'absolute z-40 rounded-[16px] border border-gg-line bg-white p-2.5 shadow-float'
        : 'absolute bottom-5 left-1/2 z-30 w-[min(680px,calc(100%-2rem))] -translate-x-1/2 rounded-[18px] border border-gg-line bg-white p-3 shadow-float'}
      style={panelStyle}
    >
      <div className="mb-2 flex items-center justify-between gap-3 px-1">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-semibold text-gg-ink">{context.title}</p>
          <p className="truncate text-[10px] text-gg-muted">{context.detail}</p>
        </div>
        <span className="shrink-0 text-[9px] text-gg-muted">⌘/Ctrl + Enter</span>
      </div>

      {provenanceOrigin && (
        <div
          data-testid="canvas-v2-node-provenance"
          className="mb-2 flex items-start gap-2 rounded-[10px] bg-[#F5F8FD] px-2.5 py-2"
        >
          {provenance?.loading
            ? <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-gg-primary motion-reduce:animate-none" />
            : <History size={13} className="mt-0.5 shrink-0 text-gg-primary" aria-hidden="true" />}
          <div className="min-w-0 flex-1">
            <p className="truncate text-[10.5px] font-medium text-gg-ink">
              {provenance?.loading
                ? '正在读取生成它的提示词…'
                : provenance?.failed
                  ? `来自“${originTask?.title ?? '历史任务'}”（原始 Run 信息不可用）`
                  : `由“${originTask?.title ?? '任务'}”的提示词生成`}
            </p>
            <p className="mt-0.5 truncate text-[9.5px] text-gg-muted">
              Run {provenanceOrigin.runId}
              {provenance?.summary?.baseRevision === undefined
                ? ''
                : ` · Canvas r${provenance.summary.baseRevision}`}
              {provenance?.sourceNodeId === selectedNode?.id ? '' : ' · 复制链来源'}
            </p>
            {provenancePrompt && (
              <div className="mt-1.5 flex items-start gap-2">
                <p
                  data-testid="canvas-v2-node-provenance-prompt"
                  className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap break-words text-[10.5px] leading-4 text-[#475467]"
                >
                  {provenancePrompt}
                </p>
                {draft !== provenancePrompt && (
                  <button
                    type="button"
                    onClick={() => store.setComposerDraft(draftKey, provenancePrompt)}
                    className="shrink-0 rounded-[7px] border border-[#D6E2F5] bg-white px-2 py-1 text-[9.5px] font-medium text-gg-primary outline-none hover:bg-[#EAF1FD] focus-visible:ring-2 focus-visible:ring-gg-primary/30"
                  >
                    复用
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {actionPrompts.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1 px-1" aria-label="节点专属快捷指令">
          {actionPrompts.slice(0, 5).map((action) => (
            <button
              key={action.id}
              type="button"
              title="填入提示词，不会自动运行"
              onClick={() => store.setComposerDraft(draftKey, action.prompt)}
              className={`rounded-full px-2 py-[3px] text-[10.5px] outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/30 ${
                draft === action.prompt
                  ? 'bg-[#EAF1FD] text-gg-primary'
                  : 'text-gg-muted hover:bg-gg-subtle hover:text-gg-ink'
              }`}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}

      {sourceNodes.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1 px-1" aria-label="任务来源节点">
          {sourceNodes.slice(0, 6).map((node) => {
            const sourcePlugin = getPlugin(node.type)
            const SourceIcon = sourcePlugin.icon
            return (
              <span
                key={node.id}
                title={`来源 · ${node.title || sourcePlugin.label}`}
                className="flex max-w-44 items-center gap-1.5 rounded-[8px] border border-gg-line bg-white px-2 py-1 text-[10px] text-gg-ink"
              >
                <SourceIcon size={10} className="shrink-0 text-gg-muted" strokeWidth={1.8} />
                <span className="truncate">{node.title || sourcePlugin.label}</span>
              </span>
            )
          })}
        </div>
      )}

      <div className="flex items-end gap-2 rounded-[12px] border border-gg-line bg-white p-2 focus-within:border-gg-primary/55 focus-within:ring-2 focus-within:ring-gg-primary/10">
        {plugin && PluginIcon && (
          <span
            title={`${plugin.label}节点`}
            className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-gg-subtle text-gg-muted"
          >
            <PluginIcon size={14} aria-hidden="true" />
          </span>
        )}
        <textarea
          value={draft}
          rows={2}
          maxLength={250_000}
          disabled={submitting}
          aria-label={provenanceOrigin ? '生成它的提示词与派生任务输入' : '任务提示词'}
          placeholder={plugin?.instr.placeholder ?? context.placeholder}
          onChange={(event) => store.setComposerDraft(draftKey, event.target.value)}
          onKeyDown={onKeyDown}
          className="max-h-28 min-h-11 min-w-0 flex-1 resize-none bg-transparent px-1 py-1.5 text-[12px] leading-5 text-gg-ink outline-none placeholder:text-[#98A2B3] disabled:opacity-65"
        />
      </div>
      <div className="mt-1.5 flex items-center gap-1 px-1">
        {plugin && (
          <span className="rounded-full border border-gg-line bg-white px-2.5 py-1 text-[10px] text-gg-muted">
            {plugin.label}
          </span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          disabled
          aria-label="语音输入暂不可用"
          title="语音输入暂不可用"
          className="flex h-7 w-7 items-center justify-center rounded-full text-gg-muted opacity-55"
        >
          <Mic size={13} aria-hidden="true" />
        </button>
        <button
          type="submit"
          disabled={!draft.trim() || submitting}
          aria-label={submitting ? '正在创建并启动任务' : '创建并启动任务'}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gg-primary text-white outline-none hover:bg-gg-select focus-visible:ring-2 focus-visible:ring-gg-primary/35 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {submitting
            ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />
            : <ArrowUp size={15} strokeWidth={2.2} aria-hidden="true" />}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 px-1 text-[10.5px] leading-4 text-[#B42318]">
          {error}。任务若已创建会保留为草稿，可在任务内重试。
        </p>
      )}
    </form>
  )

  function describeContext(): {
    title: string
    detail: string
    label: string
    placeholder: string
  } {
    if (selection.length === 0) {
      return {
        title: '创建任务',
        detail: 'Agent 将根据目标决定输出节点类型',
        label: '创建画布任务',
        placeholder: '描述要完成的任务…',
      }
    }
    if (selection.length === 1 && selection[0]?.kind === 'node') {
      const node = state.document.nodes.find((entry) => entry.id === selection[0]?.id)
      if (node && isEmptyUserOutputSlotV2(node)) {
        return {
          title: `使用“${node.title}”作为输出槽`,
          detail: '该节点的专属控件会创建任务，输出类型保持不变',
          label: '从空节点创建任务',
          placeholder: `描述要在${node.title}中生成的内容…`,
        }
      }
      return {
        title: provenanceOrigin ? '生成它的提示词' : `从“${node?.title ?? '所选节点'}”派生`,
        detail: '编辑后会生成新结果，原节点保持不变',
        label: '从内容节点派生任务',
        placeholder: '描述希望如何修改或派生这个内容…',
      }
    }
    return {
      title: `从 ${selection.length} 个选中项创建任务`,
      detail: '临时大节点作为本次上下文；需要持久分组时再保存为集合',
      label: '从多选上下文创建任务',
      placeholder: '描述如何综合这些上下文…',
    }
  }
}

function resolveRunOriginV2(
  nodes: readonly CanvasNodeV2[],
  node: CanvasNodeV2,
): { runId: string; taskId: string; sourceNodeId: string } | null {
  const seen = new Set<string>()
  let current: CanvasNodeV2 | undefined = node
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    if (current.origin.kind === 'agent-output') {
      return {
        runId: current.origin.runId,
        taskId: current.origin.taskId,
        sourceNodeId: current.id,
      }
    }
    if (current.origin.kind !== 'copied') return null
    const sourceNodeId: string = current.origin.sourceNodeId
    current = nodes.find((candidate) => candidate.id === sourceNodeId)
  }
  return null
}

function selectSourceNodesV2(
  nodes: readonly CanvasNodeV2[],
  edges: readonly {
    from: { kind: 'node' | 'task'; id: string }
    to: { kind: 'node' | 'task'; id: string }
    contextRole: 'full' | 'summary' | 'none'
  }[],
  node: CanvasNodeV2,
): CanvasNodeV2[] {
  const targetTaskId = node.origin.kind === 'agent-output'
    ? node.origin.taskId
    : node.homeTaskId
  const ids = new Set(edges.flatMap((edge) => {
    if (edge.contextRole === 'none' || edge.from.kind !== 'node') return []
    if (edge.to.kind === 'node' && edge.to.id === node.id) return [edge.from.id]
    if (targetTaskId && edge.to.kind === 'task' && edge.to.id === targetTaskId) {
      return [edge.from.id]
    }
    return []
  }))
  return nodes.filter((candidate) => ids.has(candidate.id))
}

function attachedComposerStyleV2(input: {
  bounds: CanvasBoundsV2
  camera: { x: number; y: number; zoom: number }
  viewport?: CanvasV2ViewportRect
  compound: boolean
  provenance: boolean
}): CSSProperties {
  const viewportWidth = input.viewport?.width || window.innerWidth || 1_024
  const viewportHeight = input.viewport?.height || window.innerHeight || 768
  const scaledLeft = input.camera.x + input.bounds.x * input.camera.zoom
  const scaledTop = input.camera.y + input.bounds.y * input.camera.zoom
  const scaledWidth = input.bounds.w * input.camera.zoom
  const scaledBottom = input.camera.y + (input.bounds.y + input.bounds.h) * input.camera.zoom
  const width = input.compound
    ? clampV2(scaledWidth, 420, Math.min(680, viewportWidth - 24))
    : clampV2(scaledWidth + 70, 360, Math.min(430, viewportWidth - 24))
  const estimatedHeight = input.provenance ? 252 : 188
  const gap = 8
  const below = scaledBottom + gap
  const above = scaledTop - estimatedHeight - gap
  const top = below + estimatedHeight <= viewportHeight - 12 || above < 56
    ? below
    : above
  return {
    left: clampV2(scaledLeft - 20 * input.camera.zoom, 12, viewportWidth - width - 12),
    top: Math.max(12, top),
    width,
    maxHeight: Math.max(180, viewportHeight - Math.max(12, top) - 12),
    overflowY: 'auto',
  }
}

function clampV2(value: number, minimum: number, maximum: number): number {
  if (maximum < minimum) return Math.max(0, maximum)
  return Math.min(maximum, Math.max(minimum, value))
}

function createClientTaskIdV2(): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `task-${random}`
}
