import {
  ArrowUp,
  History,
  Loader2,
  Mic,
  Paperclip,
  X,
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
import { DAEMON_AGENT_ID, DAEMON_URL } from '@/agent/config'
import {
  buildContextTaskPlan,
  canvasContextComposerKey,
  isEmptyUserOutputSlot,
  selectSourceNodes,
  selectionIsSingleTask,
} from '@/canvas/contextComposer'
import { useCanvasState, useCanvasStore } from '@/canvas/hooks'
import type { CanvasNode, CanvasPoint } from '@/canvas/model'
import type { CanvasViewportRect } from '@/canvas/interaction'
import type { CanvasSelectionTarget } from '@/canvas/persistence'
import { CanvasTaskRunContext } from '@/canvas/runHooks'
import type { CanvasTaskRunSummary } from '@/canvas/runController'
import type { CanvasBounds } from '@/canvas/selectors'
import { taskComposerDraftKey } from '@/canvas/taskRunUi'
import { getPlugin } from '@/plugins/types'
import {
  ProjectArtifactCatalogClient,
  type ProjectArtifactCatalogApi,
  type ProjectArtifactResource,
} from '@/resources/artifactCatalogClient'
import CanvasAttachmentPicker, {
  AttachmentTypeIcon,
} from './CanvasAttachmentPicker'
import CanvasPromptControl from './CanvasPromptControl'
import { artifactKey, artifactTitle } from '@/canvas/attachments'

export interface CanvasContextComposerProps {
  getAnchor: () => CanvasPoint
  /** Canonical visible selection supplied by the Stage hierarchy. */
  selectionOverride?: readonly CanvasSelectionTarget[]
  /**
   * The selected Node is still controlled by its owning Task. In that state the
   * Task Run panel is the only prompt surface; rendering a second composer would
   * incorrectly create a derived Task while the owned output is still pending.
   */
  controlOwnerTaskId?: string | null
  /** World-space bounds for the current selection. The panel remains screen-sized. */
  selectionBounds?: CanvasBounds | null
  getViewport?: () => CanvasViewportRect
  artifactCatalogApi?: Pick<ProjectArtifactCatalogApi, 'list'>
}

interface NodeRunProvenance {
  sourceNodeId: string
  summary: CanvasTaskRunSummary | null
  loading: boolean
  failed: boolean
}

const runSummaryCache = new Map<string, Promise<CanvasTaskRunSummary>>()

/** Context-aware Task creation. It never overwrites a selected content Node. */
export default function CanvasContextComposer({
  getAnchor,
  selectionOverride,
  controlOwnerTaskId = null,
  selectionBounds = null,
  getViewport,
  artifactCatalogApi: injectedArtifactCatalogApi,
}: CanvasContextComposerProps) {
  const lifecycle = useContext(CanvasTaskRunContext)
  const store = useCanvasStore()
  const state = useCanvasState()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attachmentPickerOpen, setAttachmentPickerOpen] = useState(false)
  const [attachments, setAttachments] = useState<ProjectArtifactResource[]>([])
  const artifactCatalogApi = useMemo(
    () => injectedArtifactCatalogApi ?? new ProjectArtifactCatalogClient({ baseUrl: DAEMON_URL }),
    [injectedArtifactCatalogApi],
  )
  const selection = selectionOverride ?? state.view.selection
  const draftKey = canvasContextComposerKey(selection)
  const hasDraft = Object.prototype.hasOwnProperty.call(state.view.composerDrafts, draftKey)
  const draft = state.view.composerDrafts[draftKey] ?? ''
  const selectedNode = selection.length === 1 && selection[0]?.kind === 'node'
    ? state.document.nodes.find((entry) => entry.id === selection[0]?.id) ?? null
    : null
  const provenanceOrigin = useMemo(
    () => selectedNode && !controlOwnerTaskId
      ? resolveRunOrigin(state.document.nodes, selectedNode)
      : null,
    [controlOwnerTaskId, selectedNode, state.document.nodes],
  )
  const [provenance, setProvenance] = useState<NodeRunProvenance | null>(null)

  useEffect(() => {
    setAttachments([])
    setAttachmentPickerOpen(false)
  }, [draftKey, state.scope.projectDir, state.scope.branch])

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
  // An owned Node also yields prompt control to that Task while its Run is
  // active or the output slot is still empty. The Node remains visually
  // selected; only the competing derived-task composer is suppressed.
  if (!lifecycle || selectionIsSingleTask(selection) || controlOwnerTaskId) return null

  const context = describeContext()
  const plugin = selectedNode ? getPlugin(selectedNode.type) : null
  const sourceNodes = selectedNode ? selectSourceNodes(state.document.nodes, state.document.edges, selectedNode) : []
  const suggestedActions = selectedNode
    ? (provenanceOrigin ? lifecycle.getSuggestedActions(provenanceOrigin.taskId) : [])
    : []
  const pluginPrompts = selectedNode && plugin
    ? [
        ...plugin.instr.actions,
        ...(plugin.instr.actionsFor?.(selectedNode, sourceNodes) ?? []),
      ]
    : []
  const actionPrompts = suggestedActions.length > 0
    ? suggestedActions.map((action) => ({ id: action.id, label: action.label, prompt: action.prompt }))
    : pluginPrompts.map((prompt, index) => ({
        id: `plugin-${index}-${prompt}`,
        label: prompt,
        prompt,
      }))
  const attached = selection.length > 0 && selectionBounds !== null
  const panelStyle = attached
    ? attachedComposerStyle({
        bounds: selectionBounds,
        camera: state.view.camera,
        viewport: getViewport?.(),
        compound: selection.length > 1,
        provenance: Boolean(provenanceOrigin),
        actions: actionPrompts.length > 0,
      })
    : undefined

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    const prompt = draft.trim()
    if (!prompt || submitting) return
    setSubmitting(true)
    setError(null)
    const taskId = createClientTaskId()
    try {
      const plan = buildContextTaskPlan({
        document: state.document,
        selection,
        prompt,
        anchor: getAnchor(),
        taskId,
      })
      // dispatchCommand first records the Task command in the durable outbox;
      // runTask then flushes that outbox before constructing the revision-owned RunIntent.
      await store.dispatchCommand(plan.command)
      store.setComposerDraft(taskComposerDraftKey(taskId), prompt)
      store.setSelection([{ kind: 'task', id: taskId }])
      await lifecycle.startTask({
        taskId,
        agentId: DAEMON_AGENT_ID,
        prompt,
        ...(attachments.length > 0
          ? {
              attachments: attachments.map((attachment) => ({
                kind: 'artifact' as const,
                runId: attachment.runId,
                artifactId: attachment.artifactId,
              })),
            }
          : {}),
      })
      store.setComposerDraft(draftKey, '')
      store.setComposerDraft(taskComposerDraftKey(taskId), '')
      setAttachments([])
      setAttachmentPickerOpen(false)
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
    <div
      data-testid="canvas-context-composer"
      data-attached={attached ? 'true' : 'false'}
      data-no-drag
      className={attached
        ? 'absolute z-40'
        : 'absolute bottom-5 left-1/2 z-30 w-[min(680px,calc(100%-2rem))] -translate-x-1/2'}
      style={panelStyle}
    >
      <CanvasPromptControl
        mode="draft"
        title={context.title}
        detail={context.detail}
        shortcut="⌘/Ctrl + Enter"
        ariaLabel={context.label}
        onSubmit={(event) => void submit(event)}
        onPointerDown={(event) => event.stopPropagation()}
        topContent={(
          <>
            {provenanceOrigin && (
              <div
                data-testid="canvas-node-provenance"
                className="mb-1.5 flex items-center gap-2 rounded-[10px] bg-[#F5F8FD] px-2.5 py-1.5"
              >
                {provenance?.loading
                  ? <Loader2 size={12} className="shrink-0 animate-spin text-gg-primary motion-reduce:animate-none" />
                  : <History size={12} className="shrink-0 text-gg-primary" aria-hidden="true" />}
                <div
                  className="min-w-0 flex-1"
                  title={`Run ${provenanceOrigin.runId}${
                    provenance?.sourceNodeId === selectedNode?.id ? '' : ' · 复制链来源'
                  }`}
                >
                  <p className="truncate text-[10px] text-gg-muted">
                    {provenance?.loading
                      ? '正在读取来源会话…'
                      : provenance?.failed
                        ? `来自“${originTask?.title ?? '历史任务'}”（原始 Run 信息不可用）`
                        : `由“${originTask?.title ?? '任务'}”的提示词生成${
                          provenance?.summary?.baseRevision === undefined
                            ? ''
                            : ` · Canvas r${provenance.summary.baseRevision}`
                        }`}
                  </p>
                  {provenancePrompt && (
                    <p
                      data-testid="canvas-node-provenance-prompt"
                      className="truncate text-[10.5px] font-medium text-gg-ink"
                      title={provenancePrompt}
                    >
                      {provenancePrompt}
                    </p>
                  )}
                </div>
                {provenancePrompt && draft !== provenancePrompt && (
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

            {attachments.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1 px-1" aria-label="已添加附件">
                {attachments.map((attachment) => (
                  <span
                    key={artifactKey(attachment)}
                    className="flex max-w-52 items-center gap-1.5 rounded-[8px] border border-[#D6E2F5] bg-[#F5F8FD] py-1 pl-2 pr-1 text-[10px] text-gg-ink"
                  >
                    <AttachmentTypeIcon mediaType={attachment.mediaType} size={11} />
                    <span className="truncate" title={attachment.relativePath}>
                      {artifactTitle(attachment)}
                    </span>
                    <button
                      type="button"
                      aria-label={`移除附件 ${artifactTitle(attachment)}`}
                      onClick={() => setAttachments((current) => current.filter(
                        (candidate) => artifactKey(candidate) !== artifactKey(attachment),
                      ))}
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] text-gg-muted outline-none hover:bg-white hover:text-gg-ink focus-visible:ring-2 focus-visible:ring-gg-primary/30"
                    >
                      <X size={11} aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </>
        )}
        inputLeading={(
          <>
            <button
              type="button"
              aria-label="添加附件"
              aria-haspopup="dialog"
              aria-expanded={attachmentPickerOpen}
              title="从资源库添加附件"
              onClick={() => setAttachmentPickerOpen((open) => !open)}
              className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/30 ${
                attachmentPickerOpen || attachments.length > 0
                  ? 'bg-[#EAF1FD] text-gg-primary'
                  : 'bg-gg-subtle text-gg-muted hover:text-gg-ink'
              }`}
            >
              <Paperclip size={14} aria-hidden="true" />
            </button>
            {attachmentPickerOpen && (
              <CanvasAttachmentPicker
                api={artifactCatalogApi}
                projectDir={state.scope.projectDir}
                branch={state.scope.branch}
                selected={attachments}
                onChange={setAttachments}
                onClose={() => setAttachmentPickerOpen(false)}
              />
            )}
          </>
        )}
        inputContent={(
          <textarea
            value={draft}
            rows={2}
            maxLength={250_000}
            disabled={submitting}
            aria-label={provenanceOrigin ? '历史会话与派生任务输入' : '任务提示词'}
            placeholder={plugin?.instr.placeholder ?? context.placeholder}
            onChange={(event) => store.setComposerDraft(draftKey, event.target.value)}
            onKeyDown={onKeyDown}
            className="max-h-28 min-h-11 min-w-0 flex-1 resize-none bg-transparent px-1 py-1.5 text-[12px] leading-5 text-gg-ink outline-none placeholder:text-[#98A2B3] disabled:opacity-65"
          />
        )}
        footerLeading={plugin && (
          <span className="rounded-full border border-gg-line bg-white px-2.5 py-1 text-[10px] text-gg-muted">
            {plugin.label}
          </span>
        )}
        footerActions={(
          <>
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
          </>
        )}
        bodyAfter={error && (
          <p role="alert" className="mt-2 px-1 text-[10.5px] leading-4 text-[#B42318]">
            {error}。任务若已创建会保留为草稿，可在任务内重试。
          </p>
        )}
      />
    </div>
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
      if (node && isEmptyUserOutputSlot(node)) {
        return {
          title: `使用“${node.title}”作为输出槽`,
          detail: '该节点的专属控件会创建任务，输出类型保持不变',
          label: '从空节点创建任务',
          placeholder: `描述要在${node.title}中生成的内容…`,
        }
      }
      return {
        title: provenanceOrigin ? '历史会话' : `从“${node?.title ?? '所选节点'}”派生`,
        detail: '编辑后会生成新结果，原节点保持不变',
        label: '从内容节点派生任务',
        placeholder: '描述希望如何修改或派生这个内容…',
      }
    }
    return {
      title: '从“组合节点”创建任务',
      detail: `${selection.length} 个成员共同提供上下文`,
      label: '从组合节点创建任务',
      placeholder: '描述如何使用这个组合节点…',
    }
  }
}

function resolveRunOrigin(
  nodes: readonly CanvasNode[],
  node: CanvasNode,
): { runId: string; taskId: string; sourceNodeId: string } | null {
  const seen = new Set<string>()
  let current: CanvasNode | undefined = node
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

// eslint-disable-next-line react-refresh/only-export-components
export function attachedComposerStyle(input: {
  bounds: CanvasBounds
  camera: { x: number; y: number; zoom: number }
  viewport?: CanvasViewportRect
  compound: boolean
  provenance: boolean
  actions: boolean
}): CSSProperties {
  const viewportWidth = input.viewport?.width || window.innerWidth || 1_024
  const viewportHeight = input.viewport?.height || window.innerHeight || 768
  const scaledLeft = input.camera.x + input.bounds.x * input.camera.zoom
  const scaledTop = input.camera.y + input.bounds.y * input.camera.zoom
  const scaledWidth = input.bounds.w * input.camera.zoom
  const scaledBottom = input.camera.y + (input.bounds.y + input.bounds.h) * input.camera.zoom
  // 组合节点仍是 Node，不获得另一套超宽 Composer。所有 Node 都复用同一
  // 屏幕尺寸提示词控件；组合节点只把控件锚定在自己的水平中心。
  const width = clamp(scaledWidth + 70, 360, Math.min(430, viewportWidth - 24))
  const idealLeft = input.compound
    ? scaledLeft + (scaledWidth - width) / 2
    : scaledLeft - 20 * input.camera.zoom
  // The selection toolbar occupies the strip immediately above the node.  The
  // old estimate (168/196px) let a tall history composer extend through that
  // strip, making the toolbar appear inside the input and covering the node.
  // Reserve the toolbar lane when placing the composer above the selection and
  // cap the panel to the space that is actually available on that side.
  const estimatedHeight = input.provenance
    ? (input.actions ? 300 : 260)
    : (input.actions ? 250 : 210)
  const toolbarHeight = 48
  const gap = 12
  const below = scaledBottom + gap
  const belowSpace = viewportHeight - 12 - below
  const aboveBottom = scaledTop - toolbarHeight - gap
  const above = aboveBottom - estimatedHeight
  const aboveSpace = aboveBottom - 56
  const canBelow = belowSpace >= 180
  const canAbove = aboveSpace >= 180
  const placeAbove = !canBelow && (canAbove || aboveSpace >= belowSpace)
  const top = placeAbove ? Math.max(12, above) : below
  const availableHeight = placeAbove ? aboveSpace - 12 : belowSpace
  return {
    left: clamp(idealLeft, 12, viewportWidth - width - 12),
    top: Math.max(12, top),
    width,
    maxHeight: Math.max(180, availableHeight),
    overflowY: 'auto',
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (maximum < minimum) return Math.max(0, maximum)
  return Math.min(maximum, Math.max(minimum, value))
}

function createClientTaskId(): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `task-${random}`
}
