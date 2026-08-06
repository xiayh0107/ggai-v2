import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileDown,
  Loader2,
  Send,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react'
import {
  useContext,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { DAEMON_AGENT_ID, runArtifactUrl } from '@/agent/config'
import type { DaemonProjectionOutputV2 } from '@/agent/daemonClient'
import { useCanvasV2State, useCanvasV2Store } from '@/canvas-v2/hooks'
import type { CanvasTaskV2 } from '@/canvas-v2/model'
import { CanvasV2TaskRunContext } from '@/canvas-v2/runHooks'
import type {
  CanvasV2TaskRunLifecycle,
  CanvasV2TaskRunLifecycleSnapshot,
} from '@/canvas-v2/runProvider'
import { taskComposerDraftKeyV2 } from '@/canvas-v2/taskRunUi'
import type {
  CanvasTaskRunPhaseV2,
  CanvasTaskRuntimeV2,
} from '@/canvas-v2/selectors'

const MAX_VISIBLE_LOG_ENTRIES = 200

export interface CanvasV2TaskRunPanelProps {
  task: CanvasTaskV2
}

/**
 * Optional at the integration boundary so isolated Stage tests and embeds that
 * intentionally omit Task Run ownership can still render the durable canvas.
 */
export default function CanvasV2TaskRunPanel(props: CanvasV2TaskRunPanelProps) {
  const lifecycle = useContext(CanvasV2TaskRunContext)
  if (!lifecycle) return null
  return <CanvasV2TaskRunPanelContent {...props} lifecycle={lifecycle} />
}

function CanvasV2TaskRunPanelContent({
  task,
  lifecycle,
}: CanvasV2TaskRunPanelProps & { lifecycle: CanvasV2TaskRunLifecycle }) {
  const store = useCanvasV2Store()
  const canvasState = useCanvasV2State()
  const runState = useLifecycleSnapshot(lifecycle)
  const draftKey = taskComposerDraftKeyV2(task.id)
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
  const [resolvingPermissionIds, setResolvingPermissionIds] = useState<Set<string>>(
    () => new Set(),
  )
  const [rememberByPermissionId, setRememberByPermissionId] = useState<Record<string, boolean>>({})
  const hasPrompt = Boolean(draft.trim() || task.goal.trim())
  const submitDisabled = !hasPrompt || active || submitting || cancelling

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

  return (
    <aside
      data-testid={`canvas-v2-task-run-panel-${task.id}`}
      data-no-drag
      aria-label={`${task.title}的运行控制`}
      className="pointer-events-auto w-[420px] overflow-hidden rounded-[18px] border border-gg-line bg-gg-node shadow-float"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="border-b border-gg-line px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-gg-ink">
              {hasPreviousRun ? '继续任务' : '开始任务'}
            </p>
            <RunStatus runtime={runtime} cancelling={cancelling} />
          </div>
          {active && (
            <button
              type="button"
              onClick={() => void cancel()}
              disabled={cancelling}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-[9px] border border-[#F0B4B4] px-2.5 text-[11px] font-medium text-[#B42318] outline-none hover:bg-[#FFF1F0] focus-visible:ring-2 focus-visible:ring-[#D92D20]/30 disabled:cursor-wait disabled:opacity-60"
            >
              {cancelling
                ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" />
                : <Square size={11} fill="currentColor" />}
              {cancelling ? '等待取消完成' : '取消运行'}
            </button>
          )}
        </div>

        {suggestedActions.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5" aria-label="建议的后续操作">
            {suggestedActions.map((action) => (
              <button
                key={action.id}
                type="button"
                title="仅填入草稿，不会自动运行"
                aria-label={`把建议“${action.label}”填入任务草稿`}
                onClick={() => setDraft(action.prompt)}
                className="rounded-full border border-gg-line bg-white px-2.5 py-1 text-[10.5px] text-gg-muted outline-none hover:border-gg-primary/40 hover:text-gg-primary focus-visible:ring-2 focus-visible:ring-gg-primary/30"
              >
                {action.label}
              </button>
            ))}
          </div>
        )}

        <form className="mt-3" onSubmit={(event) => void submit(event)}>
          <label htmlFor={`canvas-v2-task-composer-${task.id}`} className="sr-only">
            {task.title}的提示词
          </label>
          <div className="flex items-end gap-2 rounded-[13px] border border-gg-line bg-white p-2 focus-within:border-gg-primary/50 focus-within:ring-2 focus-within:ring-gg-primary/10">
            <textarea
              id={`canvas-v2-task-composer-${task.id}`}
              value={draft}
              rows={2}
              maxLength={250_000}
              disabled={active || submitting || cancelling}
              placeholder={task.goal || '描述本次任务要完成的目标'}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              className="min-h-[44px] min-w-0 flex-1 resize-none bg-transparent px-1 py-1 text-[12px] leading-5 text-gg-ink outline-none placeholder:text-[#98A2B3] disabled:cursor-not-allowed disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={submitDisabled}
              aria-label={hasPreviousRun ? `继续任务${task.title}` : `开始任务${task.title}`}
              title="运行（⌘/Ctrl + Enter）"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gg-primary text-white outline-none hover:bg-[#1558C0] focus-visible:ring-2 focus-visible:ring-gg-primary/35 disabled:cursor-not-allowed disabled:bg-[#B8C5D8]"
            >
              {submitting
                ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" />
                : <Send size={15} />}
            </button>
          </div>
          <p className="mt-1.5 text-[9.5px] text-[#98A2B3]">
            ⌘/Ctrl + Enter 运行；建议操作只会填入这里
          </p>
        </form>
      </div>

      {pendingPermissions.map((permission) => {
        const resolving = resolvingPermissionIds.has(permission.permissionId)
        const rememberId = `canvas-v2-permission-remember-${permission.permissionId}`
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

      {logs.length > 0 && (
        <section aria-label="运行日志">
          <button
            type="button"
            aria-expanded={logsExpanded}
            aria-controls={`canvas-v2-task-run-log-${task.id}`}
            onClick={() => setLogsExpanded((expanded) => !expanded)}
            className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-[10.5px] font-medium text-gg-muted outline-none hover:bg-gg-subtle focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gg-primary/30"
          >
            <span>运行日志 · {logs.length}</span>
            {logsExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
          {logsExpanded && (
            <ol
              id={`canvas-v2-task-run-log-${task.id}`}
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
    </aside>
  )
}

function ArtifactTrayOutput({
  output,
  projectDir,
}: {
  output: DaemonProjectionOutputV2
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
  runtime?: CanvasTaskRuntimeV2
  cancelling: boolean
}) {
  const text = cancelling
    ? '正在等待 daemon 确认取消并写入最终状态'
    : runtimeStatusLabel(runtime)
  const live = cancelling || runtime?.phase === 'awaiting-permission' ? 'assertive' : 'polite'
  return (
    <p
      role="status"
      aria-live={live}
      aria-atomic="true"
      className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-gg-muted"
    >
      {text}
    </p>
  )
}

function useLifecycleSnapshot(
  lifecycle: CanvasV2TaskRunLifecycle,
): CanvasV2TaskRunLifecycleSnapshot {
  return useSyncExternalStore(
    lifecycle.subscribe,
    lifecycle.getSnapshot,
    lifecycle.getSnapshot,
  )
}

function isActiveRunPhase(phase: CanvasTaskRunPhaseV2 | undefined): boolean {
  return phase === 'queued' || phase === 'running' || phase === 'awaiting-permission'
}

function runtimeStatusLabel(runtime: CanvasTaskRuntimeV2 | undefined): string {
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

function logKindLabel(kind: 'thinking' | 'text' | 'tool' | 'warning'): string {
  if (kind === 'thinking') return '思考'
  if (kind === 'text') return '输出'
  if (kind === 'tool') return '工具'
  return '警告'
}

function outputRoleLabel(role: DaemonProjectionOutputV2['role']): string {
  if (role === 'primary') return '主要产物'
  if (role === 'supporting') return '支持产物'
  return '辅助产物'
}
