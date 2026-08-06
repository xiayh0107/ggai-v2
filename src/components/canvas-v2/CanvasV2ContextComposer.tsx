import { Loader2, Send } from 'lucide-react'
import {
  useContext,
  useState,
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
import type { CanvasPointV2 } from '@/canvas-v2/model'
import { CanvasV2TaskRunContext } from '@/canvas-v2/runHooks'
import { taskComposerDraftKeyV2 } from '@/canvas-v2/taskRunUi'

export interface CanvasV2ContextComposerProps {
  getAnchor: () => CanvasPointV2
}

/** Context-aware Task creation. It never overwrites a selected content Node. */
export default function CanvasV2ContextComposer({ getAnchor }: CanvasV2ContextComposerProps) {
  const lifecycle = useContext(CanvasV2TaskRunContext)
  const store = useCanvasV2Store()
  const state = useCanvasV2State()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selection = state.view.selection
  const draftKey = canvasV2ContextComposerKey(selection)
  const draft = state.view.composerDrafts[draftKey] ?? ''

  // A selected Task owns its own continuation composer and stable session.
  if (!lifecycle || selectionIsSingleTaskV2(selection)) return null

  const context = describeContext()
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
      data-no-drag
      aria-label={context.label}
      onSubmit={(event) => void submit(event)}
      onPointerDown={(event) => event.stopPropagation()}
      className="absolute bottom-5 left-1/2 z-30 w-[min(680px,calc(100%-2rem))] -translate-x-1/2 rounded-[18px] border border-gg-line bg-white p-3 shadow-float"
    >
      <div className="mb-2 flex items-center justify-between gap-3 px-1">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-semibold text-gg-ink">{context.title}</p>
          <p className="truncate text-[10px] text-gg-muted">{context.detail}</p>
        </div>
        <span className="shrink-0 text-[9px] text-gg-muted">⌘/Ctrl + Enter</span>
      </div>
      <div className="flex items-end gap-2 rounded-[13px] border border-gg-line bg-white p-2 focus-within:border-gg-primary/55 focus-within:ring-2 focus-within:ring-gg-primary/10">
        <textarea
          value={draft}
          rows={2}
          disabled={submitting}
          aria-label="任务提示词"
          placeholder={context.placeholder}
          onChange={(event) => store.setComposerDraft(draftKey, event.target.value)}
          onKeyDown={onKeyDown}
          className="max-h-28 min-h-11 min-w-0 flex-1 resize-none bg-transparent px-1 py-1.5 text-[12px] leading-5 text-gg-ink outline-none placeholder:text-[#98A2B3] disabled:opacity-65"
        />
        <button
          type="submit"
          disabled={!draft.trim() || submitting}
          aria-label={submitting ? '正在创建并启动任务' : '创建并启动任务'}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gg-primary text-white outline-none hover:bg-gg-select focus-visible:ring-2 focus-visible:ring-gg-primary/35 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {submitting
            ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" />
            : <Send size={15} aria-hidden="true" />}
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
          detail: '新任务会拥有该空节点，输出类型保持不变',
          label: '从空节点创建任务',
          placeholder: `描述要在${node.title}中生成的内容…`,
        }
      }
      return {
        title: `从“${node?.title ?? '所选节点'}”派生新任务`,
        detail: '原节点保持不变，新结果进入独立任务与会话',
        label: '从内容节点派生任务',
        placeholder: '描述希望如何修改或派生这个内容…',
      }
    }
    return {
      title: `从 ${selection.length} 个选中项创建任务`,
      detail: '临时多选只作为本次任务上下文，不会自动保存为集合',
      label: '从多选上下文创建任务',
      placeholder: '描述如何综合这些上下文…',
    }
  }
}

function createClientTaskIdV2(): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `task-${random}`
}
