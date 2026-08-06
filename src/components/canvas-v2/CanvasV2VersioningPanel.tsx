import {
  AlertTriangle,
  Check,
  ChevronRight,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  History,
  Loader2,
  Plus,
} from 'lucide-react'
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { CanvasV2StoreState } from '@/canvas-v2/store'
import type { CanvasV2SaveConflictBranchResult } from '@/canvas-v2/daemonClient'
import type {
  CanvasV2HistoryEntry,
  CanvasV2VersionBranch,
  CanvasV2VersioningClient,
  CanvasV2VersioningStatus,
  CanvasV2WorkspaceMergePreview,
  CanvasV2WorkspaceOperationResult,
} from '@/canvas-v2/versioningClient'

export interface CanvasV2VersioningFlushStore {
  flushCommands(): Promise<void>
  saveConflictAsBranch(newBranch: string): Promise<CanvasV2SaveConflictBranchResult>
  getSnapshot(): Pick<CanvasV2StoreState, 'commandSync'>
}

export interface CanvasV2VersioningPanelProps {
  client: Pick<
    CanvasV2VersioningClient,
    | 'status'
    | 'listBranches'
    | 'history'
    | 'createBranch'
    | 'checkpoint'
    | 'restoreAsNewBranch'
    | 'previewMerge'
    | 'executeMerge'
  >
  projectDir: string
  branch: string
  store: CanvasV2VersioningFlushStore
  onNavigateBranch: (branch: string) => void
  onClose: () => void
}

interface RestoreDraft {
  checkpoint: string
  newBranch: string
}

type BusyOperation =
  | 'loading'
  | 'switch'
  | 'create'
  | 'checkpoint'
  | 'history'
  | 'restore'
  | 'preview'
  | 'merge'
  | 'save-conflict'
  | null

export default function CanvasV2VersioningPanel({
  client,
  projectDir,
  branch,
  store,
  onNavigateBranch,
  onClose,
}: CanvasV2VersioningPanelProps) {
  const headingId = useId()
  const [status, setStatus] = useState<CanvasV2VersioningStatus | null>(null)
  const [branches, setBranches] = useState<CanvasV2VersionBranch[]>([])
  const [history, setHistory] = useState<CanvasV2HistoryEntry[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [busy, setBusy] = useState<BusyOperation>('loading')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [newBranch, setNewBranch] = useState('')
  const [checkpointReason, setCheckpointReason] = useState('')
  const [restoreDraft, setRestoreDraft] = useState<RestoreDraft | null>(null)
  const [mergeSource, setMergeSource] = useState('')
  const [mergePreview, setMergePreview] = useState<CanvasV2WorkspaceMergePreview | null>(null)
  const [conflictBranchDraft, setConflictBranchDraft] = useState<string | null>(null)
  const [conflictBranchError, setConflictBranchError] = useState<string | null>(null)

  const scope = useMemo(() => ({ projectDir }), [projectDir])
  const commandSync = store.getSnapshot().commandSync
  const commandConflict = commandSync.status === 'conflict' ? commandSync.conflict : null
  const conflictBranchIssue = conflictBranchDraft === null
    ? null
    : validateConflictBranch(conflictBranchDraft, branch)
  const mergeSources = branches.filter((candidate) => candidate.name !== branch)
  const mutationsDisabled = busy !== null || status?.state === 'degraded'

  useEffect(() => {
    let active = true
    setBusy('loading')
    setError(null)
    Promise.all([
      client.status(scope),
      client.listBranches(scope),
      client.history(scope, { branch, limit: 25 }),
    ]).then(([statusResult, branchResult, historyResult]) => {
      if (!active) return
      setStatus(statusResult.versioning)
      if (branchResult.ok) setBranches(branchResult.value)
      else setError(operationFailure('读取分支失败', branchResult))
      setStatus(branchResult.versioning)
      if (historyResult.ok) {
        setHistory(historyResult.value.entries)
        setNextCursor(historyResult.value.nextCursor)
      } else {
        setError((current) => current ?? operationFailure('读取历史失败', historyResult))
      }
      setStatus(historyResult.versioning)
    }).catch((cause: unknown) => {
      if (active) setError(`无法读取版本历史：${errorMessage(cause)}`)
    }).finally(() => {
      if (active) setBusy(null)
    })
    return () => {
      active = false
    }
  }, [branch, client, scope])

  useEffect(() => {
    if (mergeSource && mergeSources.some((candidate) => candidate.name === mergeSource)) return
    setMergeSource(mergeSources[0]?.name ?? '')
  }, [mergeSource, mergeSources])

  const clearFeedback = () => {
    setError(null)
    setNotice(null)
  }

  const gateOutbox = async (): Promise<boolean> => {
    try {
      await store.flushCommands()
    } catch (cause) {
      setError(`画布命令同步失败：${errorMessage(cause)}。版本操作尚未开始。`)
      return false
    }
    const sync = store.getSnapshot().commandSync
    if (sync.conflict || sync.status === 'conflict') {
      setError(
        `画布存在未解决的命令冲突：${sync.conflict?.message ?? '请先处理冲突'}。版本操作尚未开始。`,
      )
      return false
    }
    if (sync.error || sync.status === 'error') {
      setError(`画布命令未能保存：${sync.error ?? '请先重试同步'}。版本操作尚未开始。`)
      return false
    }
    if (sync.pendingCount !== 0 || sync.status === 'pending' || sync.status === 'saving') {
      setError(`仍有 ${sync.pendingCount} 条画布命令未确认，版本操作尚未开始。`)
      return false
    }
    return true
  }

  const runMutation = async (operation: Exclude<BusyOperation, 'loading' | 'history' | null>) => {
    clearFeedback()
    setBusy(operation)
    const allowed = await gateOutbox()
    if (!allowed) setBusy(null)
    return allowed
  }

  const refreshBranches = async () => {
    const result = await client.listBranches(scope)
    setStatus(result.versioning)
    if (result.ok) setBranches(result.value)
    else setError(operationFailure('刷新分支失败', result))
  }

  const refreshHistory = async () => {
    const result = await client.history(scope, { branch, limit: 25 })
    setStatus(result.versioning)
    if (result.ok) {
      setHistory(result.value.entries)
      setNextCursor(result.value.nextCursor)
    } else {
      setError(operationFailure('刷新历史失败', result))
    }
  }

  const switchBranch = async (targetBranch: string) => {
    if (!await runMutation('switch')) return
    onNavigateBranch(targetBranch)
  }

  const createBranch = async (event: FormEvent) => {
    event.preventDefault()
    const name = newBranch.trim()
    if (!name) {
      setError('请输入新分支名称。')
      return
    }
    if (!await runMutation('create')) return
    try {
      const result = await client.createBranch(scope, { name, fromBranch: branch })
      setStatus(result.versioning)
      if (!result.ok) {
        setError(operationFailure('创建分支失败', result))
        return
      }
      setNewBranch('')
      setNotice(`已从 ${branch} 创建分支 ${result.value.branch.name}。`)
      await refreshBranches()
    } catch (cause) {
      setError(`创建分支失败：${errorMessage(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  const createCheckpoint = async () => {
    if (!await runMutation('checkpoint')) return
    try {
      const result = await client.checkpoint(scope, {
        branch,
        ...(checkpointReason.trim() ? { reason: checkpointReason.trim() } : {}),
      })
      setStatus(result.versioning)
      if (!result.ok) {
        setError(operationFailure('创建检查点失败', result))
        return
      }
      setCheckpointReason('')
      setNotice(result.value.checkpoint.changed
        ? `已创建检查点 ${shortCommit(result.value.checkpoint.commit)}。`
        : '当前画布没有新变化，检查点保持不变。')
      await refreshHistory()
    } catch (cause) {
      setError(`创建检查点失败：${errorMessage(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  const loadMoreHistory = async () => {
    if (!nextCursor || busy) return
    clearFeedback()
    setBusy('history')
    try {
      const result = await client.history(scope, { branch, cursor: nextCursor, limit: 25 })
      setStatus(result.versioning)
      if (!result.ok) {
        setError(operationFailure('读取更多历史失败', result))
        return
      }
      setHistory((current) => deduplicateHistory([...current, ...result.value.entries]))
      setNextCursor(result.value.nextCursor)
    } catch (cause) {
      setError(`读取更多历史失败：${errorMessage(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  const openRestore = (checkpoint: string) => {
    clearFeedback()
    setRestoreDraft({
      checkpoint,
      newBranch: `restore-${shortCommit(checkpoint)}`,
    })
  }

  const restoreCheckpoint = async () => {
    if (!restoreDraft || !restoreDraft.newBranch.trim()) {
      setError('请输入恢复分支名称。')
      return
    }
    if (!await runMutation('restore')) return
    try {
      const result = await client.restoreAsNewBranch(scope, {
        sourceBranch: branch,
        newBranch: restoreDraft.newBranch.trim(),
        checkpoint: restoreDraft.checkpoint,
      })
      setStatus(result.versioning)
      if (!result.ok) {
        setError(operationFailure('恢复失败', result))
        return
      }
      onNavigateBranch(result.value.branch.name)
    } catch (cause) {
      setError(`恢复失败：${errorMessage(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  const previewMerge = async (event: FormEvent) => {
    event.preventDefault()
    if (!mergeSource) {
      setError('请选择来源分支。')
      return
    }
    if (!await runMutation('preview')) return
    try {
      const result = await client.previewMerge(scope, {
        sourceBranch: mergeSource,
        targetBranch: branch,
      })
      setStatus(result.versioning)
      if (!result.ok) {
        setError(operationFailure('合并预览失败', result))
        return
      }
      setMergePreview(result.value)
    } catch (cause) {
      setError(`合并预览失败：${errorMessage(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  const executeMerge = async () => {
    if (!mergePreview) return
    if (!await runMutation('merge')) return
    try {
      const result = await client.executeMerge(scope, {
        sourceBranch: mergePreview.canvas.sourceBranch,
        targetBranch: mergePreview.canvas.targetBranch,
        confirmed: true,
        expected: mergePreview.expectation,
      })
      setStatus(result.versioning)
      if (!result.ok) {
        setError(operationFailure('合并失败', result))
        return
      }
      if (result.value.state === 'conflicts') {
        setError('合并仍有冲突，未覆盖目标分支。请关闭确认框并检查冲突路径。')
        return
      }
      setMergePreview(null)
      setNotice(result.value.state === 'up-to-date' ? '目标分支已是最新。' : '合并完成，正在重新加载目标分支。')
      onNavigateBranch(branch)
    } catch (cause) {
      setError(`合并失败：${errorMessage(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  const openConflictBranch = () => {
    clearFeedback()
    setConflictBranchError(null)
    setConflictBranchDraft(defaultConflictBranchName(branch, commandConflict?.mutationId ?? 'local'))
  }

  const saveConflictBranch = async () => {
    if (conflictBranchDraft === null) return
    const issue = validateConflictBranch(conflictBranchDraft, branch)
    if (issue) {
      setConflictBranchError(issue)
      return
    }
    setBusy('save-conflict')
    setConflictBranchError(null)
    try {
      const result = await store.saveConflictAsBranch(conflictBranchDraft.trim())
      setConflictBranchDraft(null)
      onNavigateBranch(result.newBranch)
    } catch (cause) {
      setConflictBranchError(`保存冲突分支失败：${errorMessage(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <Dialog open onOpenChange={(open) => {
        if (!open) onClose()
      }}>
        <DialogContent
          className="max-h-[calc(100vh-2rem)] max-w-[760px] overflow-y-auto border-gg-line bg-gg-node p-0 text-gg-ink"
          data-testid="canvas-v2-versioning-panel"
        >
          <DialogHeader className="border-b border-gg-line px-6 py-5 text-left">
            <DialogTitle className="flex items-center gap-2 text-[16px]">
              <History size={18} className="text-gg-primary" /> 工作区版本历史
            </DialogTitle>
            <DialogDescription className="text-[12px] leading-5 text-gg-muted">
              仅记录 Canvas V2 文档。任务运行、日志、源码与本地视图状态不在此历史中。
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-5 px-6 py-5 md:grid-cols-2">
            {commandConflict && (
              <section
                aria-labelledby={`${headingId}-command-conflict`}
                className="rounded-[12px] border border-amber-300 bg-amber-50 p-4 md:col-span-2"
              >
                <div className="flex flex-wrap items-start gap-3">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-700" />
                  <div className="min-w-0 flex-1">
                    <h2 id={`${headingId}-command-conflict`} className="text-[13px] font-semibold text-amber-900">
                      本地命令与远端分支冲突
                    </h2>
                    <p className="mt-1 text-[11px] leading-5 text-amber-800">
                      {commandConflict.message}。{commandSync.pendingCount} 条本地命令仍安全保留；可将它们保存到新分支后继续。
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={openConflictBranch}
                    className="rounded-[9px] bg-amber-700 px-3 py-2 text-[11px] font-semibold text-white disabled:opacity-45"
                    data-testid="versioning-open-conflict-branch"
                  >
                    保存到冲突分支…
                  </button>
                </div>
              </section>
            )}
            <section aria-labelledby={`${headingId}-status`} className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 id={`${headingId}-status`} className="text-[13px] font-semibold">当前状态</h2>
                <StatusBadge status={status} />
              </div>
              <div className="rounded-[12px] border border-gg-line bg-gg-subtle/60 p-3 text-[12px]">
                <div className="flex items-center gap-2 font-medium">
                  <GitBranch size={14} /> {branch}
                </div>
                {status?.state === 'degraded' && (
                  <p className="mt-2 text-amber-700">{status.reason}</p>
                )}
              </div>
            </section>

            <section aria-labelledby={`${headingId}-checkpoint`} className="space-y-3">
              <h2 id={`${headingId}-checkpoint`} className="text-[13px] font-semibold">手工检查点</h2>
              <label className="block text-[11px] text-gg-muted" htmlFor={`${headingId}-reason`}>
                说明（可选）
              </label>
              <div className="flex gap-2">
                <input
                  id={`${headingId}-reason`}
                  value={checkpointReason}
                  onChange={(event) => setCheckpointReason(event.target.value)}
                  maxLength={500}
                  className="h-9 min-w-0 flex-1 rounded-[10px] border border-gg-line bg-white px-3 text-[12px] outline-none focus:border-gg-primary"
                  placeholder="例如：调整图表前"
                />
                <button
                  type="button"
                  disabled={mutationsDisabled}
                  onClick={() => void createCheckpoint()}
                  className="rounded-[10px] bg-gg-primary px-3 text-[12px] font-medium text-white disabled:opacity-45"
                  data-testid="versioning-checkpoint"
                >
                  {busy === 'checkpoint' ? '保存中…' : '创建'}
                </button>
              </div>
            </section>

            <section aria-labelledby={`${headingId}-branches`} className="space-y-3 md:col-span-2">
              <h2 id={`${headingId}-branches`} className="text-[13px] font-semibold">分支</h2>
              <div className="grid gap-2 sm:grid-cols-2">
                {branches.map((candidate) => {
                  const current = candidate.name === branch
                  return (
                    <div
                      key={candidate.name}
                      className="flex min-w-0 items-center gap-2 rounded-[11px] border border-gg-line px-3 py-2"
                    >
                      <GitBranch size={14} className={current ? 'text-gg-primary' : 'text-gg-muted'} />
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                        {candidate.name}
                      </span>
                      <code className="text-[10px] text-gg-muted">{shortCommit(candidate.commit)}</code>
                      {current ? (
                        <span className="flex items-center gap-1 text-[10px] text-gg-primary">
                          <Check size={11} /> 当前
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={mutationsDisabled}
                          onClick={() => void switchBranch(candidate.name)}
                          className="rounded-[8px] border border-gg-line px-2 py-1 text-[11px] hover:border-gg-primary disabled:opacity-45"
                        >
                          切换
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
              <form onSubmit={(event) => void createBranch(event)} className="flex gap-2">
                <label htmlFor={`${headingId}-branch`} className="sr-only">新分支名称</label>
                <input
                  id={`${headingId}-branch`}
                  value={newBranch}
                  onChange={(event) => setNewBranch(event.target.value)}
                  maxLength={120}
                  className="h-9 min-w-0 flex-1 rounded-[10px] border border-gg-line bg-white px-3 text-[12px] outline-none focus:border-gg-primary"
                  placeholder="新分支名称"
                  data-testid="versioning-new-branch"
                />
                <button
                  type="submit"
                  disabled={mutationsDisabled}
                  className="flex items-center gap-1 rounded-[10px] border border-gg-line px-3 text-[12px] font-medium hover:border-gg-primary disabled:opacity-45"
                  data-testid="versioning-create-branch"
                >
                  <Plus size={13} /> 创建
                </button>
              </form>
            </section>

            <section aria-labelledby={`${headingId}-merge`} className="space-y-3 md:col-span-2">
              <h2 id={`${headingId}-merge`} className="flex items-center gap-2 text-[13px] font-semibold">
                <GitMerge size={15} /> 合并到 {branch}
              </h2>
              <form onSubmit={(event) => void previewMerge(event)} className="flex gap-2">
                <label htmlFor={`${headingId}-merge-source`} className="sr-only">来源分支</label>
                <select
                  id={`${headingId}-merge-source`}
                  value={mergeSource}
                  onChange={(event) => setMergeSource(event.target.value)}
                  className="h-9 min-w-0 flex-1 rounded-[10px] border border-gg-line bg-white px-3 text-[12px]"
                  data-testid="versioning-merge-source"
                >
                  {mergeSources.length === 0 && <option value="">没有可合并的其他分支</option>}
                  {mergeSources.map((candidate) => (
                    <option key={candidate.name} value={candidate.name}>{candidate.name}</option>
                  ))}
                </select>
                <button
                  type="submit"
                  disabled={mutationsDisabled || !mergeSource}
                  className="rounded-[10px] border border-gg-line px-3 text-[12px] font-medium hover:border-gg-primary disabled:opacity-45"
                  data-testid="versioning-preview-merge"
                >
                  预览合并
                </button>
              </form>
            </section>

            <section aria-labelledby={`${headingId}-history`} className="space-y-3 md:col-span-2">
              <h2 id={`${headingId}-history`} className="flex items-center gap-2 text-[13px] font-semibold">
                <GitCommitHorizontal size={15} /> {branch} 的检查点
              </h2>
              {history.length === 0 && busy !== 'loading' ? (
                <p className="rounded-[12px] border border-dashed border-gg-line p-4 text-center text-[12px] text-gg-muted">
                  暂无检查点
                </p>
              ) : (
                <ol className="space-y-2">
                  {history.map((entry) => (
                    <li key={entry.commit} className="flex items-start gap-3 rounded-[11px] border border-gg-line p-3">
                      <GitCommitHorizontal size={14} className="mt-0.5 shrink-0 text-gg-muted" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12px] font-medium">{entry.subject}</p>
                        <p className="mt-1 text-[10px] text-gg-muted">
                          {formatDate(entry.committedAt)} · {shortCommit(entry.commit)}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={mutationsDisabled}
                        onClick={() => openRestore(entry.commit)}
                        className="rounded-[8px] border border-gg-line px-2 py-1 text-[11px] hover:border-gg-primary disabled:opacity-45"
                      >
                        恢复…
                      </button>
                    </li>
                  ))}
                </ol>
              )}
              {nextCursor && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void loadMoreHistory()}
                  className="flex w-full items-center justify-center gap-1 rounded-[10px] border border-gg-line py-2 text-[11px] hover:border-gg-primary disabled:opacity-45"
                >
                  {busy === 'history' ? <Loader2 size={12} className="animate-spin" /> : <ChevronRight size={12} />}
                  加载更早记录
                </button>
              )}
            </section>
          </div>

          <div className="sticky bottom-0 border-t border-gg-line bg-gg-node px-6 py-3">
            <div aria-live="polite" className="min-h-5 text-[11px]">
              {busy === 'loading' && (
                <span className="flex items-center gap-1.5 text-gg-muted">
                  <Loader2 size={12} className="animate-spin" /> 正在读取版本状态…
                </span>
              )}
              {error && (
                <span className="flex items-start gap-1.5 text-red-700" role="alert">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {error}
                </span>
              )}
              {!error && notice && <span className="text-emerald-700">{notice}</span>}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={restoreDraft !== null} onOpenChange={(open) => {
        if (!open && busy !== 'restore') setRestoreDraft(null)
      }}>
        <AlertDialogContent className="border-gg-line bg-gg-node text-gg-ink">
          <AlertDialogHeader>
            <AlertDialogTitle>恢复检查点到新分支</AlertDialogTitle>
            <AlertDialogDescription className="text-gg-muted">
              当前分支不会被覆盖。将从 {restoreDraft ? shortCommit(restoreDraft.checkpoint) : ''} 创建一个新分支。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="text-[12px] font-medium" htmlFor={`${headingId}-restore-branch`}>
            新分支名称
          </label>
          <input
            id={`${headingId}-restore-branch`}
            value={restoreDraft?.newBranch ?? ''}
            onChange={(event) => setRestoreDraft((current) => current
              ? { ...current, newBranch: event.target.value }
              : current)}
            className="h-9 rounded-[10px] border border-gg-line px-3 text-[12px] outline-none focus:border-gg-primary"
            data-testid="versioning-restore-branch"
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === 'restore'}>取消</AlertDialogCancel>
            <button
              type="button"
              disabled={busy === 'restore'}
              onClick={() => void restoreCheckpoint()}
              className="rounded-[9px] bg-gg-primary px-4 py-2 text-[13px] font-medium text-white disabled:opacity-45"
              data-testid="versioning-confirm-restore"
            >
              {busy === 'restore' ? '恢复中…' : '创建并切换'}
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={mergePreview !== null} onOpenChange={(open) => {
        if (!open && busy !== 'merge') setMergePreview(null)
      }}>
        <AlertDialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto border-gg-line bg-gg-node text-gg-ink">
          <AlertDialogHeader>
            <AlertDialogTitle>确认合并 Canvas V2 分支</AlertDialogTitle>
            <AlertDialogDescription className="text-gg-muted">
              预览固定在以下提交与修订号；确认前会再次清空命令队列，daemon 也会拒绝过期预览。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {mergePreview && (
            <div className="space-y-3 text-[12px]">
              <div className="rounded-[10px] border border-gg-line bg-gg-subtle/60 p-3">
                <p><strong>{mergePreview.canvas.sourceBranch}</strong> → <strong>{mergePreview.canvas.targetBranch}</strong></p>
                <p className="mt-1 text-gg-muted">
                  {mergePreview.canvas.paths.length} 个路径 · {mergePreview.canvas.conflicts.length} 个冲突
                </p>
              </div>
              {mergePreview.canvas.paths.length > 0 && (
                <ul className="max-h-32 overflow-y-auto rounded-[10px] border border-gg-line p-3 font-mono text-[10px]">
                  {mergePreview.canvas.paths.map((path) => <li key={path}>{path}</li>)}
                </ul>
              )}
              {mergePreview.canvas.conflicts.length > 0 && (
                <div className="rounded-[10px] border border-amber-300 bg-amber-50 p-3 text-amber-800">
                  预览发现冲突；执行不会静默覆盖目标分支。
                </div>
              )}
              {error && <p className="text-red-700" role="alert">{error}</p>}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === 'merge'}>取消</AlertDialogCancel>
            <button
              type="button"
              disabled={busy === 'merge' || (mergePreview?.canvas.conflicts.length ?? 0) > 0}
              onClick={() => void executeMerge()}
              className="rounded-[9px] bg-gg-primary px-4 py-2 text-[13px] font-medium text-white disabled:opacity-45"
              data-testid="versioning-confirm-merge"
            >
              {busy === 'merge' ? '合并中…' : '明确确认并合并'}
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={conflictBranchDraft !== null} onOpenChange={(open) => {
        if (!open && busy !== 'save-conflict') {
          setConflictBranchDraft(null)
          setConflictBranchError(null)
        }
      }}>
        <AlertDialogContent className="border-amber-300 bg-gg-node text-gg-ink">
          <AlertDialogHeader>
            <AlertDialogTitle>保存本地命令到冲突分支</AlertDialogTitle>
            <AlertDialogDescription className="text-gg-muted">
              daemon 将从冲突前的原始修订重放当前 FIFO 命令，不会上传或覆盖整个画布快照。成功后将切换到新分支。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="text-[12px] font-medium" htmlFor={`${headingId}-conflict-branch`}>
            新分支名称
          </label>
          <input
            id={`${headingId}-conflict-branch`}
            value={conflictBranchDraft ?? ''}
            onChange={(event) => {
              setConflictBranchDraft(event.target.value)
              setConflictBranchError(null)
            }}
            maxLength={120}
            aria-invalid={conflictBranchIssue ? 'true' : 'false'}
            aria-describedby={`${headingId}-conflict-branch-help`}
            className="h-9 rounded-[10px] border border-gg-line px-3 text-[12px] outline-none focus:border-gg-primary"
            data-testid="versioning-conflict-branch"
          />
          <div id={`${headingId}-conflict-branch-help`} aria-live="polite" className="min-h-5 text-[11px]">
            {conflictBranchError ? (
              <p role="alert" className="text-red-700">{conflictBranchError}</p>
            ) : conflictBranchIssue ? (
              <p className="text-amber-700">{conflictBranchIssue}</p>
            ) : (
              <p className="text-gg-muted">允许字母、数字、点、短横线、下划线和斜杠，最长 120 个字符。</p>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === 'save-conflict'}>取消</AlertDialogCancel>
            <button
              type="button"
              disabled={busy === 'save-conflict' || conflictBranchIssue !== null}
              onClick={() => void saveConflictBranch()}
              className="rounded-[9px] bg-amber-700 px-4 py-2 text-[13px] font-medium text-white disabled:opacity-45"
              data-testid="versioning-confirm-conflict-branch"
            >
              {busy === 'save-conflict' ? '保存中…' : '保存到冲突分支'}
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function StatusBadge({ status }: { status: CanvasV2VersioningStatus | null }) {
  if (!status) return <span className="text-[10px] text-gg-muted">读取中</span>
  if (status.state === 'degraded') {
    return <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-800">受限</span>
  }
  if (status.state === 'uninitialized') {
    return <span className="rounded-full bg-gg-subtle px-2 py-0.5 text-[10px] text-gg-muted">未初始化</span>
  }
  return <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-700">可用</span>
}

function operationFailure<Value>(
  label: string,
  result: Extract<CanvasV2WorkspaceOperationResult<Value>, { ok: false }>,
): string {
  const partial = result.partial ? '操作已部分完成，当前状态已保留。' : ''
  return `${label}：${result.error.message}（${result.error.code}）。${partial}`
}

function shortCommit(commit: string): string {
  return commit.slice(0, 8)
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function deduplicateHistory(entries: CanvasV2HistoryEntry[]): CanvasV2HistoryEntry[] {
  return [...new Map(entries.map((entry) => [entry.commit, entry])).values()]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function validateConflictBranch(value: string, sourceBranch: string): string | null {
  const branch = value.trim()
  if (!branch) return '请输入新分支名称。'
  if (branch === sourceBranch) return '冲突分支必须与当前分支不同。'
  if (branch.length > 120
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(branch)
    || branch.includes('..')
    || branch.includes('//')
    || branch.endsWith('/')
    || branch.endsWith('.')
    || branch.endsWith('.lock')
    || branch.split('/').some((segment) => segment === '.' || segment.endsWith('.'))) {
    return '分支名称格式无效。'
  }
  return null
}

function defaultConflictBranchName(sourceBranch: string, mutationId: string): string {
  const source = sourceBranch.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
  const suffix = mutationId.replace(/[^A-Za-z0-9]+/gu, '').slice(-8) || 'local'
  return `conflict/${source || 'canvas'}-${suffix}`.slice(0, 120).replace(/[./]+$/gu, '')
}
