import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileDown,
  Loader2,
  Maximize2,
  Mic,
  Paperclip,
  RefreshCw,
  ShieldCheck,
  Square,
  WandSparkles,
  X,
} from 'lucide-react'
import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { DAEMON_AGENT_ID, DAEMON_URL, runArtifactUrl } from '@/agent/config'
import type { DaemonProjectionOutput } from '@/agent/projectionPlan'
import {
  TaskRunPreflightClient,
  type TaskRunPreflightApi,
  type TaskRunPreflightIssue,
} from '@/agent/taskRunPreflightClient'
import { artifactKey, artifactTitle } from '@/canvas/attachments'
import { useCanvasState, useCanvasStore } from '@/canvas/hooks'
import type { CanvasTask } from '@/canvas/model'
import { CanvasTaskRunContext } from '@/canvas/runHooks'
import type {
  CanvasTaskRunLifecycle,
  CanvasTaskRunLifecycleSnapshot,
} from '@/canvas/runProvider'
import { taskComposerDraftKey } from '@/canvas/taskRunUi'
import { effectiveTaskSkillRefs } from '@/canvas/taskSkills'
import { useOpenCanvasRunLogViewer } from '@/canvas/runLogViewerContext'
import type {
  CanvasTaskRunPhase,
  CanvasTaskRuntime,
} from '@/canvas/selectors'
import { useOptionalCanvasWorkbenchController } from '@/canvas/workbenchController'
import { getPlugin } from '@/plugins/types'
import {
  ProjectArtifactCatalogClient,
  type ProjectArtifactCatalogApi,
  type ProjectArtifactResource,
} from '@/resources/artifactCatalogClient'
import CanvasAttachmentPicker, { AttachmentTypeIcon } from './CanvasAttachmentPicker'
import CanvasPromptControl from './CanvasPromptControl'

const MAX_VISIBLE_LOG_ENTRIES = 200

type PreflightState =
  | { status: 'idle' | 'checking' | 'ready' }
  | { status: 'blocked'; issues: TaskRunPreflightIssue[] }
  | { status: 'error' }

export interface CanvasTaskRunPanelProps {
  task: CanvasTask
  width?: number
  /** Deterministic UI-render and component-test seam. */
  preflightApi?: TaskRunPreflightApi
  /** Deterministic UI-render and component-test seam. */
  artifactCatalogApi?: Pick<ProjectArtifactCatalogApi, 'list'>
  /** Deterministic UI-render and component-test seam. */
  initialAttachments?: readonly ProjectArtifactResource[]
  /** Deterministic UI-render and component-test seam. */
  initialAttachmentPickerOpen?: boolean
}

/**
 * Optional at the integration boundary so isolated Stage tests and embeds that
 * intentionally omit Task Run ownership can still render the durable canvas.
 */
export default function CanvasTaskRunPanel(props: CanvasTaskRunPanelProps) {
  const lifecycle = useContext(CanvasTaskRunContext)
  if (!lifecycle) return null
  return <CanvasTaskRunPanelContent {...props} lifecycle={lifecycle} />
}

function CanvasTaskRunPanelContent({
  task,
  width,
  lifecycle,
  preflightApi: injectedPreflightApi,
  artifactCatalogApi: injectedArtifactCatalogApi,
  initialAttachments = [],
  initialAttachmentPickerOpen = false,
}: CanvasTaskRunPanelProps & { lifecycle: CanvasTaskRunLifecycle }) {
  const store = useCanvasStore()
  const openRunLogViewer = useOpenCanvasRunLogViewer()
  const workbenchController = useOptionalCanvasWorkbenchController()
  const canvasState = useCanvasState()
  const runState = useLifecycleSnapshot(lifecycle)
  const preflightApi = useMemo(
    () => injectedPreflightApi ?? new TaskRunPreflightClient({ baseUrl: DAEMON_URL }),
    [injectedPreflightApi],
  )
  const artifactCatalogApi = useMemo(
    () => injectedArtifactCatalogApi ?? new ProjectArtifactCatalogClient({ baseUrl: DAEMON_URL }),
    [injectedArtifactCatalogApi],
  )
  const draftKey = taskComposerDraftKey(task.id)
  const draft = canvasState.view.composerDrafts[draftKey] ?? ''
  const runtime = canvasState.runtimeByTaskId[task.id]
  const review = lifecycle.getProjectionReviewForTask(task.id)
  const suggestedActions = review?.suggestedActions ?? []
  const trayOutputs = review?.plan.outputs.filter((output) => !output.materialize) ?? []
  const pendingPermissions = runState.pendingPermissions.filter((entry) =>
    entry.taskId === task.id)
  const errors = runState.nonFatalErrors.filter((error) =>
    error.taskId === task.id || error.taskId === undefined)
  const hasPreviousRun = Boolean(runtime?.runId)
    || canvasState.document.nodes.some((node) => node.homeTaskId === task.id)
    || canvasState.document.receipts.some((receipt) => receipt.taskId === task.id)
  const active = isActiveRunPhase(runtime?.phase)
  const runId = runtime?.runId ?? review?.runId
  const logs = runId
    ? lifecycle.getRunLog(runId).slice(-MAX_VISIBLE_LOG_ENTRIES)
    : []
  const [submitting, setSubmitting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [logsExpanded, setLogsExpanded] = useState(false)
  const [preflightAttempt, setPreflightAttempt] = useState(0)
  const [preflightState, setPreflightState] = useState<PreflightState>({ status: 'idle' })
  const [attachmentPickerOpen, setAttachmentPickerOpen] = useState(
    initialAttachmentPickerOpen,
  )
  const [attachments, setAttachments] = useState<ProjectArtifactResource[]>(
    () => [...initialAttachments],
  )
  const [skillCount, setSkillCount] = useState(0)
  const attachmentScopeKey = `${canvasState.scope.projectDir}\u0000${canvasState.scope.branch}\u0000${task.id}`
  const attachmentScopeRef = useRef(attachmentScopeKey)
  const wasActiveRef = useRef(false)
  const attachmentRefs = useMemo(() => attachments.map((attachment) => ({
    kind: 'artifact' as const,
    runId: attachment.runId,
    artifactId: attachment.artifactId,
  })), [attachments])
  const [resolvingPermissionIds, setResolvingPermissionIds] = useState<Set<string>>(
    () => new Set(),
  )
  const [rememberByPermissionId, setRememberByPermissionId] = useState<Record<string, boolean>>({})
  const hasPrompt = Boolean(draft.trim() || task.goal.trim())
  const submitDisabled = !hasPrompt
    || active
    || submitting
    || cancelling
    || preflightState.status !== 'ready'
  const ownedNodes = canvasState.document.nodes.filter((node) => node.homeTaskId === task.id)
  const skillTargetNode = ownedNodes.length === 1 ? ownedNodes[0] : null
  const outputPlugin = skillTargetNode ? getPlugin(skillTargetNode.type) : null
  const panelTitle = skillTargetNode
    ? `使用“${skillTargetNode.title}”作为输出槽`
    : '任务提示词'

  useEffect(() => {
    if (attachmentScopeRef.current === attachmentScopeKey) return
    attachmentScopeRef.current = attachmentScopeKey
    setAttachments([])
    setAttachmentPickerOpen(false)
  }, [attachmentScopeKey])

  useEffect(() => {
    if (active) {
      wasActiveRef.current = true
      setAttachmentPickerOpen(false)
      return
    }
    if (!wasActiveRef.current) return
    wasActiveRef.current = false
    setAttachments([])
  }, [active])

  useEffect(() => {
    const skillApi = workbenchController?.skillApi
    if (!skillApi || !skillTargetNode || canvasState.hydration.status !== 'ready') {
      setSkillCount(0)
      return
    }
    const controller = new AbortController()
    void skillApi.list(controller.signal).then(
      (catalog) => {
        if (controller.signal.aborted) return
        try {
          setSkillCount(effectiveTaskSkillRefs(
            canvasState.document,
            task.id,
            catalog.typeBindings,
          ).length)
        } catch {
          setSkillCount(0)
        }
      },
      () => {
        if (!controller.signal.aborted) setSkillCount(0)
      },
    )
    return () => controller.abort()
  }, [
    canvasState.document,
    canvasState.hydration.status,
    skillTargetNode,
    task.id,
    workbenchController?.skillApi,
  ])

  useEffect(() => {
    const revision = canvasState.envelope?.revision
    if (active || canvasState.hydration.status !== 'ready' || revision === undefined) {
      setPreflightState({ status: 'idle' })
      return
    }
    const controller = new AbortController()
    setPreflightState({ status: 'checking' })
    void preflightApi.check({
      projectDir: canvasState.scope.projectDir,
      taskId: task.id,
      agentId: DAEMON_AGENT_ID,
      canvasBranch: canvasState.scope.branch,
      baseRevision: revision,
      attachments: attachmentRefs,
      signal: controller.signal,
    }).then(
      (result) => setPreflightState(result.status === 'ready'
        ? { status: 'ready' }
        : { status: 'blocked', issues: result.issues }),
      (error: unknown) => {
        if (!isAbortError(error)) setPreflightState({ status: 'error' })
      },
    )
    return () => controller.abort()
  }, [
    active,
    attachmentRefs,
    canvasState.envelope?.revision,
    canvasState.hydration.status,
    canvasState.scope.branch,
    canvasState.scope.projectDir,
    preflightApi,
    preflightAttempt,
    task.id,
  ])

  const setDraft = (value: string) => store.setComposerDraft(draftKey, value)

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    if (submitDisabled) return
    setSubmitting(true)
    try {
      const input = {
        taskId: task.id,
        agentId: DAEMON_AGENT_ID,
        ...(draft.trim() ? { prompt: draft.trim() } : {}),
        ...(attachmentRefs.length > 0 ? { attachments: attachmentRefs } : {}),
      }
      if (hasPreviousRun) await lifecycle.continueTask(input)
      else await lifecycle.startTask(input)
      setDraft('')
    } catch {
      // The lifecycle records a visible non-fatal error and preserves the draft.
    } finally {
      setSubmitting(false)
    }
  }

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return
    event.preventDefault()
    void submit()
  }

  const cancel = async () => {
    if (!active || cancelling) return
    setCancelling(true)
    try {
      // cancelTask resolves only after the daemon's durable close is observed.
      await lifecycle.cancelTask(task.id)
    } catch {
      // The lifecycle records a visible non-fatal error.
    } finally {
      setCancelling(false)
    }
  }

  const resolvePermission = async (permissionId: string, decision: 'allow' | 'deny') => {
    if (resolvingPermissionIds.has(permissionId)) return
    setResolvingPermissionIds((current) => new Set(current).add(permissionId))
    try {
      await lifecycle.resolvePermission(permissionId, {
        decision,
        remember: rememberByPermissionId[permissionId] ?? false,
      })
    } catch {
      // The lifecycle records a visible non-fatal error.
    } finally {
      setResolvingPermissionIds((current) => {
        const next = new Set(current)
        next.delete(permissionId)
        return next
      })
    }
  }

  const openSkills = () => {
    if (active || !skillTargetNode || !workbenchController) return
    store.setSelection([{ kind: 'node', id: skillTargetNode.id }])
    workbenchController.openSection('skills')
  }

  const preflightNotice = preflightState.status === 'blocked'
    ? {
        message: preflightState.issues[0]?.message ?? '当前暂时无法开始生成。',
        additional: Math.max(0, preflightState.issues.length - 1),
        retryable: preflightState.issues.some((issue) => issue.retryable),
      }
    : preflightState.status === 'error'
      ? {
          message: '暂时无法确认生成服务状态，请重新检测。',
          additional: 0,
          retryable: true,
        }
      : null

  return (
    <aside
      data-testid={`canvas-task-run-panel-${task.id}`}
      data-preflight-status={preflightState.status}
      data-no-drag
      aria-label={`${task.title}的运行控制`}
      className="pointer-events-auto"
      style={{ width: width ?? 420 }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <CanvasPromptControl
        mode={active ? 'running' : 'draft'}
        title={panelTitle}
        detail={<RunStatus runtime={runtime} cancelling={cancelling} />}
        shortcut={active ? undefined : '⌘/Ctrl + Enter'}
        ariaLabel={`${task.title}的提示词与运行控制`}
        onSubmit={(event) => void submit(event)}
        topContent={(
          <>
            {!active && preflightNotice && (
              <GenerationPreflightNotice
                message={preflightNotice.message}
                additional={preflightNotice.additional}
                retryable={preflightNotice.retryable}
                checking={preflightState.status === 'checking'}
                onRetry={() => setPreflightAttempt((attempt) => attempt + 1)}
              />
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
                    {!active && (
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
                    )}
                  </span>
                ))}
              </div>
            )}
            {!active && suggestedActions.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1 px-1" aria-label="建议的后续操作">
                {suggestedActions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    title="仅填入草稿，不会自动运行"
                    aria-label={`把建议“${action.label}”填入任务草稿`}
                    onClick={() => setDraft(action.prompt)}
                    className="rounded-full px-2 py-[3px] text-[10.5px] text-gg-muted outline-none hover:bg-gg-subtle hover:text-gg-ink focus-visible:ring-2 focus-visible:ring-gg-primary/30"
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        inputLeading={(
          <>
            <button
              type="button"
              disabled={active}
              aria-label={active ? '生成期间不可添加附件' : '添加附件'}
              aria-haspopup={active ? undefined : 'dialog'}
              aria-expanded={active ? undefined : attachmentPickerOpen}
              title={active ? '生成期间不可添加附件' : '从资源库添加附件'}
              onClick={() => setAttachmentPickerOpen((open) => !open)}
              className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/30 disabled:cursor-not-allowed disabled:opacity-55 ${
                attachmentPickerOpen || attachments.length > 0
                  ? 'bg-[#EAF1FD] text-gg-primary'
                  : 'bg-gg-subtle text-gg-muted hover:text-gg-ink'
              }`}
            >
              <Paperclip size={14} aria-hidden="true" />
            </button>
            {!active && attachmentPickerOpen && (
              <CanvasAttachmentPicker
                api={artifactCatalogApi}
                projectDir={canvasState.scope.projectDir}
                branch={canvasState.scope.branch}
                selected={attachments}
                onChange={setAttachments}
                onClose={() => setAttachmentPickerOpen(false)}
              />
            )}
          </>
        )}
        inputContent={(
          <textarea
            id={`canvas-task-composer-${task.id}`}
            value={active ? task.goal : draft}
            rows={2}
            maxLength={250_000}
            readOnly={active}
            disabled={submitting || cancelling}
            aria-label={`${task.title}的提示词`}
            aria-busy={active}
            placeholder={task.goal || '描述本次任务要完成的目标'}
            onChange={(event) => {
              if (!active) setDraft(event.target.value)
            }}
            onKeyDown={handleComposerKeyDown}
            className="max-h-28 min-h-11 min-w-0 flex-1 resize-none bg-transparent px-1 py-1.5 text-[12px] leading-5 text-gg-ink outline-none placeholder:text-[#98A2B3] disabled:cursor-not-allowed disabled:opacity-65"
          />
        )}
        footerLeading={(
          <>
            {outputPlugin && (
              <span className="rounded-full border border-gg-line bg-white px-2.5 py-1 text-[10px] text-gg-muted">
                {outputPlugin.label}
              </span>
            )}
            {skillTargetNode && skillCount > 0 && workbenchController && (
              <button
                type="button"
                data-testid="canvas-task-skills-summary"
                disabled={active}
                aria-label={`打开节点 Skills，共 ${skillCount} 个`}
                title={active ? '生成期间 Skills 已锁定' : '打开节点 Skills'}
                onClick={openSkills}
                className="flex items-center gap-1 rounded-full border border-gg-line bg-white px-2.5 py-1 text-[10px] text-gg-muted outline-none hover:border-gg-primary/35 hover:text-gg-primary focus-visible:ring-2 focus-visible:ring-gg-primary/30 disabled:cursor-not-allowed disabled:opacity-55"
              >
                <WandSparkles size={10} aria-hidden="true" />
                Skills {skillCount}
              </button>
            )}
            {active && (
              <span
                role="status"
                aria-live="polite"
                className="ml-1 flex items-center gap-1 text-[9.5px] text-gg-primary"
              >
                <Loader2
                  size={11}
                  className="animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                {cancelling ? '正在取消' : '生成中'}
              </span>
            )}
          </>
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
            {active && logs.length > 0 && (
              <button
                type="button"
                aria-label={logsExpanded ? '收起运行日志' : '展开运行日志'}
                aria-expanded={logsExpanded}
                onClick={() => setLogsExpanded((expanded) => !expanded)}
                className="flex h-7 w-7 items-center justify-center rounded-[7px] text-gg-muted outline-none hover:bg-gg-subtle hover:text-gg-ink focus-visible:ring-2 focus-visible:ring-gg-primary/30"
              >
                {logsExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
            )}
            {active && openRunLogViewer && runId && (
              <button
                type="button"
                aria-label="在侧边大窗查看运行日志"
                aria-haspopup="dialog"
                onClick={() => openRunLogViewer({
                  runId,
                  title: task.title,
                  initialTab: 'log',
                })}
                className="flex h-7 w-7 items-center justify-center rounded-[7px] text-gg-muted outline-none hover:bg-gg-subtle hover:text-gg-primary focus-visible:ring-2 focus-visible:ring-gg-primary/30"
              >
                <Maximize2 size={12} aria-hidden="true" />
              </button>
            )}
            <button
              type={active ? 'button' : 'submit'}
              aria-label={active
                ? cancelling ? '正在取消运行' : '取消运行'
                : hasPreviousRun ? `继续任务${task.title}` : `开始任务${task.title}`}
              title={active
                ? cancelling ? '正在取消运行' : '取消运行'
                : '运行（⌘/Ctrl + Enter）'}
              onClick={active ? () => void cancel() : undefined}
              disabled={active ? cancelling : submitDisabled}
              className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gg-primary text-white outline-none hover:bg-gg-select focus-visible:ring-2 focus-visible:ring-gg-primary/35 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {active ? (
                <>
                  <Loader2
                    size={16}
                    className="animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                  {!cancelling && (
                    <Square
                      size={6}
                      fill="currentColor"
                      className="absolute"
                      aria-hidden="true"
                    />
                  )}
                </>
              ) : submitting ? (
                <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />
              ) : (
                <ArrowUp size={15} strokeWidth={2.2} aria-hidden="true" />
              )}
            </button>
          </>
        )}
      >

      {pendingPermissions.map((permission) => {
        const resolving = resolvingPermissionIds.has(permission.permissionId)
        const rememberId = `canvas-permission-remember-${permission.permissionId}`
        return (
          <section
            key={permission.permissionId}
            aria-label="Agent 权限请求"
            className="border-b border-[#F7D9A5] bg-[#FFF9ED] px-4 py-3"
          >
            <div className="flex items-start gap-2">
              <ShieldCheck size={15} className="mt-0.5 shrink-0 text-[#B45309]" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold text-[#7A2E0E]">
                  需要你的许可：{permission.action}
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-[10.5px] leading-4 text-[#92400E]">
                  {permission.detail}
                </p>
                <label
                  htmlFor={rememberId}
                  className="mt-2 flex w-fit cursor-pointer items-center gap-1.5 text-[10px] text-[#7A2E0E]"
                >
                  <input
                    id={rememberId}
                    type="checkbox"
                    checked={rememberByPermissionId[permission.permissionId] ?? false}
                    disabled={resolving}
                    onChange={(event) => setRememberByPermissionId((current) => ({
                      ...current,
                      [permission.permissionId]: event.target.checked,
                    }))}
                  />
                  本次运行记住选择
                </label>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    disabled={resolving}
                    onClick={() => void resolvePermission(permission.permissionId, 'allow')}
                    className="rounded-[8px] bg-[#B45309] px-3 py-1.5 text-[10.5px] font-medium text-white outline-none focus-visible:ring-2 focus-visible:ring-[#B45309]/35 disabled:cursor-wait disabled:opacity-60"
                  >
                    允许
                  </button>
                  <button
                    type="button"
                    disabled={resolving}
                    onClick={() => void resolvePermission(permission.permissionId, 'deny')}
                    className="rounded-[8px] border border-[#E8B86D] bg-white px-3 py-1.5 text-[10.5px] font-medium text-[#7A2E0E] outline-none focus-visible:ring-2 focus-visible:ring-[#B45309]/30 disabled:cursor-wait disabled:opacity-60"
                  >
                    拒绝
                  </button>
                </div>
              </div>
            </div>
          </section>
        )
      })}

      {errors.slice(-3).map((error) => (
        <div
          key={error.id}
          role="alert"
          className="flex items-start gap-2 border-b border-[#F4C7C3] bg-[#FFF5F4] px-4 py-3 text-[#B42318]"
        >
          <CircleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <p className="min-w-0 flex-1 break-words text-[10.5px] leading-4">
            {error.message}
          </p>
          <button
            type="button"
            aria-label="关闭运行错误"
            onClick={() => lifecycle.clearNonFatalError(error.id)}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] outline-none hover:bg-[#FEE4E2] focus-visible:ring-2 focus-visible:ring-[#D92D20]/30"
          >
            <X size={12} />
          </button>
        </div>
      ))}

      {trayOutputs.length > 0 && (
        <section aria-label="未上画布的产物" className="border-b border-gg-line px-4 py-3">
          <div className="flex items-center gap-2 text-[11px] font-semibold text-gg-ink">
            <FileDown size={14} className="text-gg-muted" aria-hidden="true" />
            产物托盘
            <span className="font-normal text-gg-muted">{trayOutputs.length}</span>
          </div>
          <ul className="mt-2 space-y-2">
            {trayOutputs.map((output) => (
              <ArtifactTrayOutput
                key={output.key}
                output={output}
                projectDir={canvasState.scope.projectDir}
              />
            ))}
          </ul>
        </section>
      )}

      {active && logsExpanded && logs.length > 0 && (
        <ol
          id={`canvas-task-run-log-${task.id}`}
          role="log"
          aria-label={`${task.title}的有界运行日志`}
          className="max-h-36 space-y-1.5 overflow-auto border-t border-gg-line px-3 py-2.5 font-mono text-[9.5px] leading-4 text-[#475467]"
        >
          {logs.map((entry) => (
            <li key={`${entry.eventId}:${entry.kind}`} className="line-clamp-3 whitespace-pre-wrap break-words">
              <span className="mr-2 select-none text-[#98A2B3]">{logKindLabel(entry.kind)}</span>
              {entry.text}
            </li>
          ))}
        </ol>
      )}

      {!active && logs.length > 0 && (
        <section aria-label="运行日志">
          <button
            type="button"
            aria-expanded={logsExpanded}
            aria-controls={`canvas-task-run-log-${task.id}`}
            onClick={() => setLogsExpanded((expanded) => !expanded)}
            className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-[10.5px] font-medium text-gg-muted outline-none hover:bg-gg-subtle focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gg-primary/30"
          >
            <span>运行日志 · {logs.length}</span>
            {logsExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
          {logsExpanded && (
            <ol
              id={`canvas-task-run-log-${task.id}`}
              role="log"
              aria-label={`${task.title}的有界运行日志`}
              className="max-h-44 space-y-2 overflow-auto border-t border-gg-line bg-[#F7F9FC] px-4 py-3 font-mono text-[10px] leading-4 text-[#475467]"
            >
              {logs.map((entry) => (
                <li key={`${entry.eventId}:${entry.kind}`} className="whitespace-pre-wrap break-words">
                  <span className="mr-2 select-none text-[#98A2B3]">{logKindLabel(entry.kind)}</span>
                  {entry.text}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
      </CanvasPromptControl>
    </aside>
  )
}

function GenerationPreflightNotice({
  message,
  additional,
  retryable,
  checking,
  onRetry,
}: {
  message: string
  additional: number
  retryable: boolean
  checking: boolean
  onRetry(): void
}) {
  return (
    <div
      role="alert"
      data-testid="canvas-generation-preflight-notice"
      className="mb-1.5 flex items-start gap-2 rounded-[10px] border border-[#F4C7C3] bg-[#FFF8F7] px-2.5 py-2"
    >
      <CircleAlert size={13} className="mt-0.5 shrink-0 text-[#B42318]" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-[10.5px] leading-4 text-[#912018]">{message}</p>
        {additional > 0 && (
          <p className="mt-0.5 text-[9.5px] text-[#B5473E]">另有 {additional} 项需要处理</p>
        )}
      </div>
      {retryable && (
        <button
          type="button"
          disabled={checking}
          onClick={onRetry}
          className="flex shrink-0 items-center gap-1 rounded-[7px] border border-[#F0B8B2] bg-white px-2 py-1 text-[9.5px] font-medium text-[#B42318] outline-none hover:bg-[#FFF0EE] focus-visible:ring-2 focus-visible:ring-[#D92D20]/25 disabled:cursor-wait disabled:opacity-60"
        >
          <RefreshCw
            size={10}
            className={checking ? 'animate-spin motion-reduce:animate-none' : undefined}
            aria-hidden="true"
          />
          重新检测
        </button>
      )}
    </div>
  )
}

function ArtifactTrayOutput({
  output,
  projectDir,
}: {
  output: DaemonProjectionOutput
  projectDir: string
}) {
  return (
    <li className="rounded-[10px] border border-gg-line bg-gg-subtle px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[10.5px] font-medium text-gg-ink">{output.title}</p>
          <p className="mt-0.5 text-[9.5px] text-gg-muted">
            {output.pluginId} · {outputRoleLabel(output.role)} · 未自动上画布
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          {output.artifactRefs.map((reference, index) => (
            <a
              key={`${reference.runId}:${reference.artifactId}`}
              href={runArtifactUrl(reference.runId, reference.artifactId, projectDir)}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-[7px] border border-gg-line bg-white px-2 py-1 text-[9.5px] font-medium text-gg-primary outline-none hover:border-gg-primary/40 focus-visible:ring-2 focus-visible:ring-gg-primary/30"
            >
              {output.artifactRefs.length > 1 ? `打开 ${index + 1}` : '打开产物'}
            </a>
          ))}
          {output.artifactRefs.length === 0 && (
            <span className="text-[9.5px] text-[#98A2B3]">不可预览</span>
          )}
        </div>
      </div>
    </li>
  )
}

function RunStatus({
  runtime,
  cancelling,
}: {
  runtime?: CanvasTaskRuntime
  cancelling: boolean
}) {
  const text = cancelling
    ? '正在等待取消完成'
    : runtimeStatusLabel(runtime)
  const live = cancelling || runtime?.phase === 'awaiting-permission' ? 'assertive' : 'polite'
  return (
    <p
      role="status"
      aria-live={live}
      aria-atomic="true"
      className="line-clamp-2 text-[10px] leading-4 text-gg-muted"
    >
      {text}
    </p>
  )
}

function useLifecycleSnapshot(
  lifecycle: CanvasTaskRunLifecycle,
): CanvasTaskRunLifecycleSnapshot {
  return useSyncExternalStore(
    lifecycle.subscribe,
    lifecycle.getSnapshot,
    lifecycle.getSnapshot,
  )
}

function isActiveRunPhase(phase: CanvasTaskRunPhase | undefined): boolean {
  return phase === 'queued' || phase === 'running' || phase === 'awaiting-permission'
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === 'AbortError'
}

function runtimeStatusLabel(runtime: CanvasTaskRuntime | undefined): string {
  if (!runtime) return '尚未运行；提交后将使用此 Task 的独立会话'
  if (runtime.message) return runtime.message
  switch (runtime.phase) {
    case 'draft': return '尚未运行'
    case 'queued': return '等待运行'
    case 'running': return '正在运行'
    case 'awaiting-permission': return '等待权限确认'
    case 'done': return '运行已完成'
    case 'partial': return '运行部分完成，合法产物已保留'
    case 'error': return '运行失败'
    case 'cancelled': return '运行已取消'
    case 'interrupted': return '运行已中断'
  }
}

function logKindLabel(kind: 'thinking' | 'text' | 'tool' | 'warning' | 'meta'): string {
  if (kind === 'thinking') return '思考'
  if (kind === 'text') return '输出'
  if (kind === 'tool') return '工具'
  if (kind === 'meta') return '记录'
  return '警告'
}

function outputRoleLabel(role: DaemonProjectionOutput['role']): string {
  if (role === 'primary') return '主要产物'
  if (role === 'supporting') return '支持产物'
  return '辅助产物'
}
