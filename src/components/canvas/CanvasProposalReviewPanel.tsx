import {
  useId,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from 'react'
import {
  MAX_TASK_PROPOSAL_EDIT_DEPENDENCIES,
  MAX_TASK_PROPOSAL_EDIT_PROMPT_LENGTH,
  MAX_TASK_PROPOSAL_EDIT_TITLE_LENGTH,
  type TaskProposalEdit,
  type TaskProposalEdits,
  type TrustedTaskProposal,
} from '@/canvas/commands'

interface ProposalDraft {
  title: string
  prompt: string
  dependsOn: string[]
}

export interface CanvasProposalReviewAcceptance {
  proposalKeys: string[]
  edits: TaskProposalEdits
}

export interface CanvasProposalReviewPanelProps {
  proposals: readonly TrustedTaskProposal[]
  settledProposalKeys?: readonly string[]
  onAccept: (acceptance: CanvasProposalReviewAcceptance) => void
  onReject: (proposalKeys: string[]) => void
}

interface ProposalReviewEditorProps extends CanvasProposalReviewPanelProps {
  unsettledProposals: readonly TrustedTaskProposal[]
}

/**
 * An intentionally isolated review boundary. It owns only transient form state
 * and emits user intent; command dispatch and task execution remain with its
 * caller.
 */
export default function CanvasProposalReviewPanel(
  props: CanvasProposalReviewPanelProps,
) {
  const settledKeys = new Set(props.settledProposalKeys ?? [])
  const unsettledProposals = props.proposals.filter((proposal) =>
    !settledKeys.has(proposal.key))
  const stateKey = JSON.stringify({
    proposals: props.proposals,
    settledProposalKeys: [...settledKeys].sort(),
  })

  return (
    <ProposalReviewEditor
      key={stateKey}
      {...props}
      unsettledProposals={unsettledProposals}
    />
  )
}

function ProposalReviewEditor({
  proposals,
  settledProposalKeys = [],
  unsettledProposals,
  onAccept,
  onReject,
}: ProposalReviewEditorProps) {
  const panelId = useId()
  const settledKeys = new Set(settledProposalKeys)
  const proposalsByKey = new Map(proposals.map((proposal) => [proposal.key, proposal]))
  const [order, setOrder] = useState(() =>
    unsettledProposals.map((proposal) => proposal.key))
  const [selectedKeys, setSelectedKeys] = useState(() =>
    new Set(unsettledProposals.map((proposal) => proposal.key)))
  const [drafts, setDrafts] = useState<Record<string, ProposalDraft>>(() =>
    Object.fromEntries(unsettledProposals.map((proposal) => [proposal.key, {
      title: proposal.title,
      prompt: proposal.prompt,
      dependsOn: [...proposal.dependsOn],
    }])))
  const [draggedKey, setDraggedKey] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const validationIssues = validateDrafts(order, selectedKeys, drafts, proposalsByKey)
  const selectedCount = selectedKeys.size
  const rejectableKeys = order.filter((proposalKey) => proposalsByKey.has(proposalKey))
  const canAccept = selectedCount > 0 && validationIssues.length === 0

  const setSelection = (proposalKey: string, selected: boolean) => {
    setSelectedKeys((current) => {
      const next = new Set(current)
      if (selected) next.add(proposalKey)
      else next.delete(proposalKey)
      return next
    })
  }

  const updateDraft = (
    proposalKey: string,
    patch: Partial<ProposalDraft>,
  ) => {
    setDrafts((current) => ({
      ...current,
      [proposalKey]: {
        ...current[proposalKey]!,
        ...patch,
      },
    }))
  }

  const toggleDependency = (
    proposalKey: string,
    dependencyKey: string,
    checked: boolean,
  ) => {
    const current = drafts[proposalKey]?.dependsOn ?? []
    const next = checked
      ? [...current, dependencyKey]
      : current.filter((key) => key !== dependencyKey)
    updateDraft(proposalKey, { dependsOn: next })
  }

  const moveProposal = (proposalKey: string, offset: -1 | 1) => {
    setOrder((current) => {
      const fromIndex = current.indexOf(proposalKey)
      const toIndex = fromIndex + offset
      if (fromIndex < 0 || toIndex < 0 || toIndex >= current.length) return current
      const next = [...current]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved!)
      return next
    })
    const proposal = proposalsByKey.get(proposalKey)
    setAnnouncement(`${proposal?.title ?? proposalKey}已${offset < 0 ? '上移' : '下移'}`)
  }

  const reorderOnDrop = (targetKey: string, event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    const sourceKey = event.dataTransfer.getData('text/plain') || draggedKey
    setDraggedKey(null)
    if (!sourceKey || sourceKey === targetKey) return
    setOrder((current) => {
      const fromIndex = current.indexOf(sourceKey)
      const toIndex = current.indexOf(targetKey)
      if (fromIndex < 0 || toIndex < 0) return current
      const next = [...current]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved!)
      return next
    })
    const proposal = proposalsByKey.get(sourceKey)
    const target = proposalsByKey.get(targetKey)
    setAnnouncement(`${proposal?.title ?? sourceKey}已移动到${target?.title ?? targetKey}附近`)
  }

  const acceptSelection = () => {
    if (!canAccept) return
    const proposalKeys = order.filter((proposalKey) => selectedKeys.has(proposalKey))
    onAccept({
      proposalKeys,
      edits: buildEdits(proposalKeys, drafts, proposalsByKey),
    })
  }

  const rejectRemaining = () => {
    if (rejectableKeys.length === 0) return
    onReject([...rejectableKeys])
  }

  return (
    <section
      data-testid="canvas-proposal-review-panel"
      aria-labelledby={`${panelId}-title`}
      className="w-[440px] rounded-[18px] border border-gg-line bg-gg-node p-4 shadow-float"
    >
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 id={`${panelId}-title`} className="text-[13px] font-semibold text-gg-ink">
            审阅 Agent 任务提案
          </h2>
          <p className="mt-1 text-[10.5px] leading-4 text-gg-muted">
            先确认任务边界和依赖；接受提案不会在此处自动运行任务。
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-[#EEF4FF] px-2 py-1 text-[10px] text-gg-primary">
          已选 {selectedCount}/{unsettledProposals.length}
        </span>
      </header>

      {unsettledProposals.length === 0 ? (
        <p className="mt-4 rounded-[12px] border border-gg-line bg-white px-3 py-4 text-[11px] text-gg-muted">
          没有尚待处理的任务提案。
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-2" aria-label="批量选择任务提案">
            <button
              type="button"
              data-testid="proposal-select-all"
              disabled={selectedCount === unsettledProposals.length}
              onClick={() => setSelectedKeys(new Set(order))}
              className="rounded-[8px] border border-gg-line bg-white px-2.5 py-1 text-[10px] text-gg-muted outline-none hover:border-gg-primary/40 hover:text-gg-primary focus-visible:ring-2 focus-visible:ring-gg-primary/30 disabled:cursor-not-allowed disabled:opacity-45"
            >
              全选
            </button>
            <button
              type="button"
              data-testid="proposal-clear-selection"
              disabled={selectedCount === 0}
              onClick={() => setSelectedKeys(new Set())}
              className="rounded-[8px] border border-gg-line bg-white px-2.5 py-1 text-[10px] text-gg-muted outline-none hover:border-gg-primary/40 hover:text-gg-primary focus-visible:ring-2 focus-visible:ring-gg-primary/30 disabled:cursor-not-allowed disabled:opacity-45"
            >
              清空选择
            </button>
          </div>

          <div className="mt-3 space-y-3">
            {order.map((proposalKey, orderIndex) => {
              const proposal = proposalsByKey.get(proposalKey)
              const draft = drafts[proposalKey]
              if (!proposal || !draft) return null
              const selected = selectedKeys.has(proposalKey)
              const titleError = selected
                ? displayStringIssue(
                    draft.title,
                    MAX_TASK_PROPOSAL_EDIT_TITLE_LENGTH,
                    '标题',
                  )
                : null
              const promptError = selected
                ? displayStringIssue(
                    draft.prompt,
                    MAX_TASK_PROPOSAL_EDIT_PROMPT_LENGTH,
                    '提示词',
                  )
                : null
              const fieldId = `${panelId}-proposal-${proposal.key}`

              return (
                <article
                  key={proposal.key}
                  data-proposal-key={proposal.key}
                  className={draggedKey === proposal.key ? 'opacity-55' : undefined}
                  onDragOver={(event) => {
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                  }}
                  onDrop={(event) => reorderOnDrop(proposal.key, event)}
                >
                  <fieldset
                    className="rounded-[14px] border border-gg-line bg-white p-3 disabled:bg-[#F8FAFC]"
                  >
                    <legend className="max-w-full px-1">
                      <label
                        htmlFor={`${fieldId}-selected`}
                        className="flex min-w-0 cursor-pointer items-center gap-2 text-[11px] font-semibold text-gg-ink"
                      >
                        <input
                          id={`${fieldId}-selected`}
                          data-testid={`proposal-select-${proposal.key}`}
                          type="checkbox"
                          checked={selected}
                          onChange={(event) => setSelection(proposal.key, event.target.checked)}
                          className="h-4 w-4 accent-gg-primary"
                        />
                        <span className="truncate">{draft.title || proposal.key}</span>
                      </label>
                    </legend>

                    <div className="mb-3 flex items-center justify-between gap-2">
                      <span className="text-[9.5px] text-[#98A2B3]">
                        顺序 {orderIndex + 1} · key: {proposal.key}
                      </span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          draggable
                          aria-label={`拖动“${draft.title || proposal.key}”调整顺序`}
                          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                          title="拖动，或按 Alt + ↑/↓ 调整顺序"
                          onDragStart={(event) => {
                            setDraggedKey(proposal.key)
                            event.dataTransfer.effectAllowed = 'move'
                            event.dataTransfer.setData('text/plain', proposal.key)
                          }}
                          onDragEnd={() => setDraggedKey(null)}
                          onKeyDown={(event) => handleReorderKeyDown(
                            event,
                            proposal.key,
                            moveProposal,
                          )}
                          className="h-7 rounded-[7px] border border-gg-line px-2 text-[11px] text-gg-muted outline-none hover:border-gg-primary/40 focus-visible:ring-2 focus-visible:ring-gg-primary/30"
                        >
                          ↕
                        </button>
                        <button
                          type="button"
                          aria-label={`将“${draft.title || proposal.key}”上移`}
                          disabled={orderIndex === 0}
                          onClick={() => moveProposal(proposal.key, -1)}
                          className="h-7 rounded-[7px] border border-gg-line px-2 text-[10px] text-gg-muted outline-none hover:border-gg-primary/40 focus-visible:ring-2 focus-visible:ring-gg-primary/30 disabled:cursor-not-allowed disabled:opacity-35"
                        >
                          上移
                        </button>
                        <button
                          type="button"
                          aria-label={`将“${draft.title || proposal.key}”下移`}
                          disabled={orderIndex === order.length - 1}
                          onClick={() => moveProposal(proposal.key, 1)}
                          className="h-7 rounded-[7px] border border-gg-line px-2 text-[10px] text-gg-muted outline-none hover:border-gg-primary/40 focus-visible:ring-2 focus-visible:ring-gg-primary/30 disabled:cursor-not-allowed disabled:opacity-35"
                        >
                          下移
                        </button>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div>
                        <label
                          htmlFor={`${fieldId}-title`}
                          className="mb-1 block text-[10px] font-medium text-gg-muted"
                        >
                          任务标题
                        </label>
                        <input
                          id={`${fieldId}-title`}
                          data-testid={`proposal-title-${proposal.key}`}
                          value={draft.title}
                          disabled={!selected}
                          maxLength={MAX_TASK_PROPOSAL_EDIT_TITLE_LENGTH}
                          aria-invalid={Boolean(titleError)}
                          onChange={(event) => updateDraft(proposal.key, {
                            title: event.target.value,
                          })}
                          className="w-full rounded-[9px] border border-gg-line px-2.5 py-2 text-[11px] text-gg-ink outline-none focus:border-gg-primary/50 focus:ring-2 focus:ring-gg-primary/10 disabled:cursor-not-allowed disabled:opacity-55"
                        />
                      </div>

                      <div>
                        <label
                          htmlFor={`${fieldId}-prompt`}
                          className="mb-1 block text-[10px] font-medium text-gg-muted"
                        >
                          任务提示词
                        </label>
                        <textarea
                          id={`${fieldId}-prompt`}
                          data-testid={`proposal-prompt-${proposal.key}`}
                          value={draft.prompt}
                          disabled={!selected}
                          rows={3}
                          maxLength={MAX_TASK_PROPOSAL_EDIT_PROMPT_LENGTH}
                          aria-invalid={Boolean(promptError)}
                          onChange={(event) => updateDraft(proposal.key, {
                            prompt: event.target.value,
                          })}
                          className="w-full resize-y rounded-[9px] border border-gg-line px-2.5 py-2 text-[11px] leading-4 text-gg-ink outline-none focus:border-gg-primary/50 focus:ring-2 focus:ring-gg-primary/10 disabled:cursor-not-allowed disabled:opacity-55"
                        />
                      </div>

                      <fieldset
                        disabled={!selected}
                        className="rounded-[10px] border border-gg-line px-2.5 pb-2.5"
                      >
                        <legend className="px-1 text-[10px] font-medium text-gg-muted">
                          前置任务（dependsOn）
                        </legend>
                        <div className="mt-1 grid grid-cols-2 gap-1.5">
                          {proposals.map((candidate, candidateIndex) => {
                            const candidateId = `${fieldId}-dependency-${candidateIndex}`
                            return (
                              <label
                                key={candidate.key}
                                htmlFor={candidateId}
                                className="flex min-w-0 items-start gap-1.5 rounded-[7px] px-1 py-1 text-[9.5px] text-gg-muted hover:bg-[#F8FAFC]"
                              >
                                <input
                                  id={candidateId}
                                  data-testid={`proposal-dependency-${proposal.key}-${candidate.key}`}
                                  type="checkbox"
                                  checked={draft.dependsOn.includes(candidate.key)}
                                  onChange={(event) => toggleDependency(
                                    proposal.key,
                                    candidate.key,
                                    event.target.checked,
                                  )}
                                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-gg-primary"
                                />
                                <span className="min-w-0 truncate">
                                  {candidate.title}
                                  {candidate.key === proposal.key ? '（自身）' : ''}
                                  {settledKeys.has(candidate.key) ? '（已处理）' : ''}
                                  {!settledKeys.has(candidate.key)
                                    && !selectedKeys.has(candidate.key)
                                    ? '（未选）'
                                    : ''}
                                </span>
                              </label>
                            )
                          })}
                        </div>
                      </fieldset>
                    </div>
                  </fieldset>
                </article>
              )
            })}
          </div>

          <div
            id={`${panelId}-validation`}
            data-testid="proposal-validation"
            aria-live="polite"
            aria-atomic="true"
            className={`mt-3 rounded-[10px] border px-3 py-2 text-[10px] leading-4 ${
              validationIssues.length > 0
                ? 'border-[#F3B8B4] bg-[#FFF6F5] text-[#B42318]'
                : 'border-[#ABEFC6] bg-[#ECFDF3] text-[#067647]'
            }`}
          >
            {validationIssues.length > 0 ? (
              <>
                <p className="font-semibold">提交前请修正：</p>
                <ul className="mt-1 list-disc pl-4">
                  {validationIssues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p>{announcement || `可以接受 ${selectedCount} 个提案。`}</p>
            )}
          </div>

          <footer className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              data-testid="proposal-reject"
              disabled={rejectableKeys.length === 0}
              onClick={rejectRemaining}
              className="rounded-[9px] border border-gg-line bg-white px-3 py-2 text-[10.5px] font-medium text-gg-muted outline-none hover:border-[#F0B4B4] hover:text-[#B42318] focus-visible:ring-2 focus-visible:ring-[#D92D20]/25 disabled:cursor-not-allowed disabled:opacity-45"
            >
              拒绝剩余提案
            </button>
            <button
              type="button"
              data-testid="proposal-accept"
              disabled={!canAccept}
              aria-describedby={`${panelId}-validation`}
              onClick={acceptSelection}
              className="rounded-[9px] bg-gg-primary px-3 py-2 text-[10.5px] font-semibold text-white outline-none hover:bg-[#1558C0] focus-visible:ring-2 focus-visible:ring-gg-primary/35 disabled:cursor-not-allowed disabled:bg-[#B8C5D8]"
            >
              接受所选提案
            </button>
          </footer>
        </>
      )}
    </section>
  )
}

function handleReorderKeyDown(
  event: KeyboardEvent<HTMLButtonElement>,
  proposalKey: string,
  moveProposal: (proposalKey: string, offset: -1 | 1) => void,
) {
  if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
  event.preventDefault()
  moveProposal(proposalKey, event.key === 'ArrowUp' ? -1 : 1)
}

function validateDrafts(
  order: readonly string[],
  selectedKeys: ReadonlySet<string>,
  drafts: Readonly<Record<string, ProposalDraft>>,
  proposalsByKey: ReadonlyMap<string, TrustedTaskProposal>,
): string[] {
  if (selectedKeys.size === 0) return ['至少选择一个任务提案。']
  const issues: string[] = []
  for (const proposalKey of order) {
    if (!selectedKeys.has(proposalKey)) continue
    const proposal = proposalsByKey.get(proposalKey)
    const draft = drafts[proposalKey]
    if (!proposal || !draft) continue
    const titleIssue = displayStringIssue(
      draft.title,
      MAX_TASK_PROPOSAL_EDIT_TITLE_LENGTH,
      '标题',
    )
    const promptIssue = displayStringIssue(
      draft.prompt,
      MAX_TASK_PROPOSAL_EDIT_PROMPT_LENGTH,
      '提示词',
    )
    if (titleIssue) issues.push(`${proposal.title}：${titleIssue}`)
    if (promptIssue) issues.push(`${proposal.title}：${promptIssue}`)
    if (draft.dependsOn.length > MAX_TASK_PROPOSAL_EDIT_DEPENDENCIES) {
      issues.push(`${proposal.title}：前置任务不能超过 ${MAX_TASK_PROPOSAL_EDIT_DEPENDENCIES} 个。`)
    }
    for (const dependencyKey of draft.dependsOn) {
      if (dependencyKey === proposalKey) {
        issues.push(`${proposal.title}：不能依赖自身。`)
      } else if (!selectedKeys.has(dependencyKey)) {
        const dependency = proposalsByKey.get(dependencyKey)
        issues.push(`${proposal.title}：依赖的“${dependency?.title ?? dependencyKey}”尚未选中。`)
      }
    }
  }

  if (hasDependencyCycle(order, selectedKeys, drafts)) {
    issues.push('所选任务的依赖关系存在循环，请调整为有向无环图。')
  }
  return [...new Set(issues)]
}

function displayStringIssue(value: string, maxLength: number, label: string): string | null {
  if (value.length === 0) return `${label}不能为空。`
  if (value.length > maxLength) return `${label}不能超过 ${maxLength} 个字符。`
  if (value !== value.trim()) return `${label}首尾不能包含空白。`
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return `${label}不能包含控制字符。`
  }
  return null
}

function hasDependencyCycle(
  order: readonly string[],
  selectedKeys: ReadonlySet<string>,
  drafts: Readonly<Record<string, ProposalDraft>>,
): boolean {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (proposalKey: string): boolean => {
    if (visited.has(proposalKey)) return false
    if (visiting.has(proposalKey)) return true
    visiting.add(proposalKey)
    for (const dependencyKey of drafts[proposalKey]?.dependsOn ?? []) {
      if (selectedKeys.has(dependencyKey) && visit(dependencyKey)) return true
    }
    visiting.delete(proposalKey)
    visited.add(proposalKey)
    return false
  }
  return order.some((proposalKey) =>
    selectedKeys.has(proposalKey) && visit(proposalKey))
}

function buildEdits(
  proposalKeys: readonly string[],
  drafts: Readonly<Record<string, ProposalDraft>>,
  proposalsByKey: ReadonlyMap<string, TrustedTaskProposal>,
): TaskProposalEdits {
  const edits: TaskProposalEdits = {}
  for (const proposalKey of proposalKeys) {
    const proposal = proposalsByKey.get(proposalKey)
    const draft = drafts[proposalKey]
    if (!proposal || !draft) continue
    const edit: TaskProposalEdit = {}
    if (draft.title !== proposal.title) edit.title = draft.title
    if (draft.prompt !== proposal.prompt) edit.prompt = draft.prompt
    if (!sameStringArray(draft.dependsOn, proposal.dependsOn)) {
      edit.dependsOn = [...draft.dependsOn]
    }
    if (Object.keys(edit).length > 0) edits[proposalKey] = edit
  }
  return edits
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index])
}
