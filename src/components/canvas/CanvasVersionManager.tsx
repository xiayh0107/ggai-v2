import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { DAEMON_PROJECT_DIR, DAEMON_URL } from '@/agent/config'
import {
  DaemonClient,
  type CanvasAutomationMode,
  type CanvasGitBranch,
  type CanvasGitHistoryEntry,
  type CanvasPreferences,
  type CanvasVersionOperation,
  type CanvasVersionStatuses,
  type SourceCheckpoint,
  type SourceGitStatus,
  type WorkspaceMergePreview,
} from '@/agent/daemonClient'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

const defaultClient = new DaemonClient({ baseUrl: DAEMON_URL })

type VersioningClient = Pick<DaemonClient,
  | 'getCanvasStatus'
  | 'listCanvasBranches'
  | 'createCanvasBranch'
  | 'deleteCanvasBranch'
  | 'getCanvasHistory'
  | 'createCanvasCheckpoint'
  | 'restoreCanvasCheckpoint'
  | 'previewCanvasMerge'
  | 'executeCanvasMerge'
  | 'getCanvasSourceStatus'
  | 'bindCanvasSource'
  | 'createCanvasSourceCheckpoint'
  | 'getCanvasPreferences'
  | 'putCanvasPreferences'
>

export interface CanvasVersionManagerProps {
  branch: string
  /** Branch-changing operations are blocked until the canvas is durably saved. */
  canChangeBranch: boolean
  conflict?: boolean
  client?: VersioningClient
  projectDir?: string
  onSwitchBranch?: (branch: string) => void
  onPreserveConflict?: (branch: string) => Promise<void>
  onMergeApplied?: () => void
}

interface CanvasVersionManagerPanelProps extends CanvasVersionManagerProps {
  client: VersioningClient
}

interface ViewState {
  statuses: CanvasVersionStatuses | null
  branches: CanvasGitBranch[]
  history: CanvasGitHistoryEntry[]
  nextCursor: string | null
  source: SourceGitStatus | null
  preferences: CanvasPreferences | null
}

interface PendingSourceCheckpoint {
  runId: string
  checkpoint: SourceCheckpoint
}

const EMPTY_VIEW: ViewState = {
  statuses: null,
  branches: [],
  history: [],
  nextCursor: null,
  source: null,
  preferences: null,
}

function defaultSwitchBranch(branch: string): void {
  const url = new URL(window.location.href)
  if (branch === 'main') url.searchParams.delete('branch')
  else url.searchParams.set('branch', branch)
  window.location.assign(url)
}

function defaultMergeApplied(): void {
  window.location.reload()
}

function operationError<T>(operation: CanvasVersionOperation<T>): string | null {
  if (operation.ok) return null
  const suffix = operation.partial ? '（部分操作已完成，请刷新确认）' : ''
  return `${operation.error.message}${suffix}`
}

function compactError(error: unknown): string {
  if (!(error instanceof Error) || !error.message.trim()) return '版本管理操作失败'
  const message = error.message.trim().replace(/\s+/g, ' ')
  return message.length > 180 ? `${message.slice(0, 180)}…` : message
}

function redactAbsolutePaths(message: string): string {
  return message
    .replace(/[A-Za-z]:[\\/][^\s,;，；)）]+/g, '[路径已隐藏]')
    .replace(/(^|[\s(（:：])\/[^\s,;，；)）]+/g, '$1[路径已隐藏]')
}

function compactSourceError(error: unknown): string {
  return redactAbsolutePaths(compactError(error))
}

function sourceOperationError<T>(operation: CanvasVersionOperation<T>): string | null {
  const failure = operationError(operation)
  return failure ? redactAbsolutePaths(failure) : null
}

function safeSourcePath(path: string): string {
  const normalized = path.trim().replaceAll('\\', '/')
  if (!normalized) return '[路径已隐藏]'
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    const name = normalized.split('/').filter(Boolean).at(-1)
    return name ? `[路径已隐藏]/${name}` : '[路径已隐藏]'
  }
  return normalized
}

function sourceWarningLabel(warning: string): string {
  const value = warning.trim()
  const sensitivePrefix = 'sensitive path:'
  const largeFilePrefix = 'large file:'
  if (value.toLowerCase().startsWith(sensitivePrefix)) {
    return `敏感路径：${safeSourcePath(value.slice(sensitivePrefix.length))}`
  }
  if (value.toLowerCase().startsWith(largeFilePrefix)) {
    return `大文件：${safeSourcePath(value.slice(largeFilePrefix.length))}`
  }
  if (/(?:^|\s)(?:\/|[A-Za-z]:[\\/])/.test(value)) {
    return '检测到敏感或大型文件（绝对路径已隐藏）'
  }
  return value || '检测到需要确认的源码改动'
}

function createSourceCheckpointRunId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `manual-${globalThis.crypto.randomUUID()}`
  }
  return `manual-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function shortCommit(commit: string): string {
  return commit.slice(0, 8)
}

function formatCheckpointTime(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}

export default function CanvasVersionManager({
  branch,
  canChangeBranch,
  conflict = false,
  client = defaultClient,
  projectDir = DAEMON_PROJECT_DIR,
  onSwitchBranch = defaultSwitchBranch,
  onPreserveConflict,
  onMergeApplied = defaultMergeApplied,
}: CanvasVersionManagerProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className={`flex h-8 items-center gap-1.5 rounded-[10px] border px-3 text-[13px] transition-colors ${
            conflict
              ? 'border-red-200 bg-red-50 text-gg-danger hover:bg-red-100'
              : 'border-gg-line text-gg-ink hover:bg-gg-subtle'
          }`}
        >
          {conflict ? <AlertTriangle size={14} /> : <History size={14} />}
          {conflict ? '解决冲突' : '版本'}
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[86vh] max-w-[720px] overflow-y-auto rounded-[16px] border-gg-line bg-gg-node p-0">
        <DialogHeader className="border-b border-gg-line px-5 py-4">
          <DialogTitle className="text-[16px] text-gg-ink">画布版本管理</DialogTitle>
          <DialogDescription className="text-[12px] text-gg-muted">
            画布快照独立保存；分支切换不会改动你的源码仓库。
          </DialogDescription>
        </DialogHeader>
        <CanvasVersionManagerPanel
          branch={branch}
          canChangeBranch={canChangeBranch}
          conflict={conflict}
          client={client}
          projectDir={projectDir}
          onSwitchBranch={onSwitchBranch}
          onPreserveConflict={onPreserveConflict}
          onMergeApplied={onMergeApplied}
        />
      </DialogContent>
    </Dialog>
  )
}

export function CanvasVersionManagerPanel({
  branch,
  canChangeBranch,
  conflict = false,
  client,
  projectDir = DAEMON_PROJECT_DIR,
  onSwitchBranch = defaultSwitchBranch,
  onPreserveConflict,
  onMergeApplied = defaultMergeApplied,
}: CanvasVersionManagerPanelProps) {
  const [view, setView] = useState<ViewState>(EMPTY_VIEW)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [newBranch, setNewBranch] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [restoreCommit, setRestoreCommit] = useState<string | null>(null)
  const [restoreBranch, setRestoreBranch] = useState('')
  const [conflictBranch, setConflictBranch] = useState('conflict-copy')
  const [mergePreview, setMergePreview] = useState<WorkspaceMergePreview | null>(null)
  const [mergeApproved, setMergeApproved] = useState(false)
  const [pendingSourceCheckpoint, setPendingSourceCheckpoint] = useState<PendingSourceCheckpoint | null>(null)
  const mounted = useRef(true)

  const readAll = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError(null)
    try {
      const [statuses, branchesResult, historyResult, source, preferences] = await Promise.all([
        client.getCanvasStatus({ projectDir }, signal),
        client.listCanvasBranches({ projectDir }, signal),
        client.getCanvasHistory({ projectDir, branch, limit: 25 }, signal),
        client.getCanvasSourceStatus({ projectDir }, signal),
        client.getCanvasPreferences({ projectDir }, signal),
      ])
      if (!mounted.current || signal?.aborted) return
      const branchError = operationError(branchesResult)
      const historyError = operationError(historyResult)
      setView({
        statuses,
        branches: branchesResult.value ?? [],
        history: historyResult.value?.entries ?? [],
        nextCursor: historyResult.value?.nextCursor ?? null,
        source,
        preferences,
      })
      setError(branchError ?? historyError)
    } catch (loadError) {
      if (!signal?.aborted && mounted.current) setError(compactError(loadError))
    } finally {
      if (!signal?.aborted && mounted.current) setLoading(false)
    }
  }, [branch, client, projectDir])

  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    void readAll(controller.signal)
    return () => {
      mounted.current = false
      controller.abort()
    }
  }, [readAll])

  useEffect(() => {
    setPendingSourceCheckpoint(null)
  }, [branch])

  const runOperation = useCallback(async (
    key: string,
    operation: () => Promise<CanvasVersionOperation<unknown>>,
    successMessage: string,
  ): Promise<boolean> => {
    setBusy(key)
    setError(null)
    setNotice(null)
    try {
      const result = await operation()
      const failure = operationError(result)
      if (failure) {
        setError(failure)
        return false
      }
      setNotice(successMessage)
      return true
    } catch (operationFailure) {
      setError(compactError(operationFailure))
      return false
    } finally {
      setBusy(null)
    }
  }, [])

  const createBranch = useCallback(async () => {
    const name = newBranch.trim()
    if (!name) return
    const created = await runOperation(
      'create-branch',
      () => client.createCanvasBranch({ projectDir, name, fromBranch: branch }),
      `已创建分支 ${name}`,
    )
    if (created) onSwitchBranch(name)
  }, [branch, client, newBranch, onSwitchBranch, projectDir, runOperation])

  const deleteBranch = useCallback(async (name: string) => {
    const deleted = await runOperation(
      `delete:${name}`,
      () => client.deleteCanvasBranch({ projectDir, branch: name }),
      `已删除分支 ${name}`,
    )
    setDeleteTarget(null)
    if (deleted) await readAll()
  }, [client, projectDir, readAll, runOperation])

  const checkpoint = useCallback(async () => {
    const saved = await runOperation(
      'checkpoint',
      () => client.createCanvasCheckpoint({ projectDir, branch, reason: 'manual' }),
      '已创建手动检查点',
    )
    if (saved) await readAll()
  }, [branch, client, projectDir, readAll, runOperation])

  const restore = useCallback(async () => {
    const name = restoreBranch.trim()
    if (!restoreCommit || !name) return
    const restored = await runOperation(
      'restore',
      () => client.restoreCanvasCheckpoint({
        projectDir,
        sourceBranch: branch,
        checkpoint: restoreCommit,
        newBranch: name,
      }),
      `检查点已恢复到新分支 ${name}`,
    )
    if (restored) onSwitchBranch(name)
  }, [branch, client, onSwitchBranch, projectDir, restoreBranch, restoreCommit, runOperation])

  const bindSource = useCallback(async () => {
    const bound = await runOperation(
      'bind-source',
      () => client.bindCanvasSource({ projectDir, branch }),
      '源码 Git 已绑定到当前画布分支',
    )
    if (bound) await readAll()
  }, [branch, client, projectDir, readAll, runOperation])

  const checkpointSource = useCallback(async (allowSensitive: boolean) => {
    const runId = allowSensitive
      ? pendingSourceCheckpoint?.runId
      : createSourceCheckpointRunId()
    if (!runId) return

    setBusy(allowSensitive ? 'source-checkpoint-confirm' : 'source-checkpoint')
    setError(null)
    setNotice(null)
    try {
      const result = await client.createCanvasSourceCheckpoint({
        projectDir,
        branch,
        runId,
        nodeTitle: '手动源码检查点',
        allowSensitive,
      })
      const failure = sourceOperationError(result)
      if (failure) {
        setError(failure)
        return
      }
      if (!result.value) return
      if (result.value.requiresConfirmation && !allowSensitive) {
        setPendingSourceCheckpoint({ runId, checkpoint: result.value })
        return
      }

      setPendingSourceCheckpoint(null)
      setNotice(result.value.changed
        ? `源码变更已提交（${shortCommit(result.value.commit)}）`
        : '源码工作树没有待提交变更')
      await readAll()
    } catch (checkpointError) {
      setError(compactSourceError(checkpointError))
    } finally {
      setBusy(null)
    }
  }, [branch, client, pendingSourceCheckpoint, projectDir, readAll])

  const updateAutomationMode = useCallback(async (mode: CanvasAutomationMode) => {
    setBusy('preferences')
    setError(null)
    setNotice(null)
    try {
      const preferences = await client.putCanvasPreferences({
        projectDir,
        automationMode: mode,
      })
      setView((current) => ({ ...current, preferences }))
      setNotice(mode === 'auto' ? '已启用自动提交' : '敏感改动将先请求确认')
    } catch (preferenceError) {
      setError(compactError(preferenceError))
    } finally {
      setBusy(null)
    }
  }, [client, projectDir])

  const preserveConflict = useCallback(async () => {
    const name = conflictBranch.trim()
    if (!name || !onPreserveConflict) return
    setBusy('preserve-conflict')
    setError(null)
    setNotice(null)
    try {
      await onPreserveConflict(name)
      setNotice(`冲突改动已安全保留到新分支 ${name}`)
    } catch (preserveError) {
      setError(compactError(preserveError))
    } finally {
      setBusy(null)
    }
  }, [conflictBranch, onPreserveConflict])

  const previewMerge = useCallback(async (sourceBranch: string) => {
    setBusy(`merge-preview:${sourceBranch}`)
    setError(null)
    setNotice(null)
    setMergePreview(null)
    setMergeApproved(false)
    try {
      const result = await client.previewCanvasMerge({
        projectDir,
        sourceBranch,
        targetBranch: branch,
      })
      const failure = operationError(result)
      if (failure) {
        setError(failure)
        return
      }
      if (result.value) setMergePreview(result.value)
    } catch (previewError) {
      setError(compactError(previewError))
    } finally {
      setBusy(null)
    }
  }, [branch, client, projectDir])

  const executeMerge = useCallback(async () => {
    if (!mergePreview || mergePreview.state === 'conflicts' || !mergeApproved) return
    const sourceBranch = mergePreview.canvas.sourceBranch
    setBusy('merge-execute')
    setError(null)
    setNotice(null)
    try {
      const result = await client.executeCanvasMerge({
        projectDir,
        sourceBranch,
        targetBranch: branch,
        confirmed: true,
        expected: mergePreview.expectation,
      })
      const failure = operationError(result)
      if (failure) {
        if (!result.ok && result.error.code === 'merge_preview_stale') {
          setMergePreview(null)
          setMergeApproved(false)
          setError(`${failure} 请重新预览后再确认。`)
          return
        }
        // A source merge can fail after the canvas merge and runtime snapshot
        // were already committed. The operation payload makes that partial
        // success explicit; refresh the active branch before the user can keep
        // editing against its now-stale revision.
        if (result.partial
          && (result.value?.canvas.merged || result.value?.source?.merged)) {
          await readAll()
          setError(failure)
          onMergeApplied()
        } else {
          setError(failure)
        }
        return
      }
      if (!result.value) return
      if (result.value.state === 'conflicts') {
        setMergePreview({
          state: 'conflicts',
          canvas: result.value.canvas,
          source: result.value.source,
          expectation: mergePreview.expectation,
        })
        setMergeApproved(false)
        setError('分支在确认后发生变化，现已检测到冲突；合并未自动应用。')
        return
      }
      setNotice(result.value.state === 'up-to-date' ? '当前分支已是最新状态' : '分支合并完成')
      await readAll()
      onMergeApplied()
    } catch (mergeError) {
      setError(compactError(mergeError))
    } finally {
      setBusy(null)
    }
  }, [branch, client, mergeApproved, mergePreview, onMergeApplied, projectDir, readAll])

  const loadMore = useCallback(async () => {
    if (!view.nextCursor) return
    setBusy('history-more')
    setError(null)
    try {
      const result = await client.getCanvasHistory({
        projectDir,
        branch,
        cursor: view.nextCursor,
        limit: 25,
      })
      const failure = operationError(result)
      if (failure) setError(failure)
      else if (result.value) {
        setView((current) => ({
          ...current,
          history: [...current.history, ...result.value!.entries],
          nextCursor: result.value!.nextCursor,
        }))
      }
    } catch (historyError) {
      setError(compactError(historyError))
    } finally {
      setBusy(null)
    }
  }, [branch, client, projectDir, view.nextCursor])

  const knownBranches = useMemo(() => {
    if (view.branches.some((candidate) => candidate.name === branch)) return view.branches
    return [{ name: branch, commit: '', worktree: null }, ...view.branches]
  }, [branch, view.branches])

  const currentSourceBinding = view.source?.status === 'ready'
    ? view.source.branches.find((candidate) => candidate.logicalBranch === branch) ?? null
    : null

  if (loading) {
    return (
      <div className="flex min-h-[300px] items-center justify-center text-[13px] text-gg-muted">
        <Loader2 size={16} className="mr-2 animate-spin" /> 正在读取版本信息…
      </div>
    )
  }

  return (
    <div className="grid gap-5 px-5 py-4 text-[12px] text-gg-ink md:grid-cols-[1fr_1.15fr]">
      {conflict && onPreserveConflict && (
        <section
          aria-labelledby="save-conflict-title"
          className="rounded-[10px] border border-red-200 bg-red-50 p-3 md:col-span-2"
        >
          <h3 id="save-conflict-title" className="flex items-center gap-1.5 font-semibold text-gg-danger">
            <AlertTriangle size={13} /> 画布已有更新，当前改动未被覆盖
          </h3>
          <p className="mt-1 text-[11px] leading-5 text-gg-muted">
            把本地待保存内容写入一个新分支，再从新分支继续工作。
          </p>
          <div className="mt-2 flex max-w-sm gap-2">
            <input
              aria-label="冲突内容的新分支名称"
              value={conflictBranch}
              onChange={(event) => setConflictBranch(event.target.value)}
              className="h-8 min-w-0 flex-1 rounded-[8px] border border-red-200 bg-white px-2.5 text-[11px] outline-none focus:border-gg-primary"
            />
            <button
              type="button"
              disabled={busy !== null || !conflictBranch.trim() || conflictBranch.trim() === branch}
              onClick={() => void preserveConflict()}
              className="flex h-8 items-center gap-1 rounded-[8px] bg-gg-primary px-2.5 text-[11px] text-white disabled:opacity-40"
            >
              {busy === 'preserve-conflict' ? <Loader2 size={12} className="animate-spin" /> : <GitBranch size={12} />}
              保留为新分支
            </button>
          </div>
        </section>
      )}
      {mergePreview && (
        <MergePreviewCard
          preview={mergePreview}
          approved={mergeApproved}
          busy={busy === 'merge-execute'}
          onApprovedChange={setMergeApproved}
          onConfirm={() => void executeMerge()}
          onClose={() => {
            setMergePreview(null)
            setMergeApproved(false)
          }}
        />
      )}
      <div className="space-y-5">
        <section aria-labelledby="canvas-branches-title">
          <div className="mb-2 flex items-center justify-between">
            <h3 id="canvas-branches-title" className="flex items-center gap-1.5 text-[13px] font-semibold">
              <GitBranch size={14} /> 画布分支
            </h3>
            <VersioningBadge status={view.statuses?.versioning ?? null} />
          </div>

          {!canChangeBranch && (
            <p className="mb-2 rounded-[8px] bg-gg-subtle px-2.5 py-2 text-[11px] text-gg-muted">
              当前画布尚未保存，保存完成后才能切换或创建分支。
            </p>
          )}

          <div className="overflow-hidden rounded-[10px] border border-gg-line">
            {knownBranches.map((candidate) => {
              const active = candidate.name === branch
              return (
                <div
                  key={candidate.name}
                  className="flex min-h-9 items-center gap-2 border-b border-gg-line px-2.5 last:border-b-0"
                >
                  <span className="min-w-0 flex-1 truncate font-medium">{candidate.name}</span>
                  {candidate.commit && (
                    <code className="text-[10px] text-gg-muted">{shortCommit(candidate.commit)}</code>
                  )}
                  {active ? (
                    <span className="flex items-center gap-1 text-[10px] text-gg-primary">
                      <Check size={11} /> 当前
                    </span>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={!canChangeBranch || busy !== null}
                        onClick={() => onSwitchBranch(candidate.name)}
                        className="rounded-[6px] px-1.5 py-1 text-[11px] text-gg-primary hover:bg-gg-subtle disabled:opacity-40"
                      >
                        切换
                      </button>
                      <button
                        type="button"
                        title={`将 ${candidate.name} 合并到 ${branch}`}
                        disabled={!canChangeBranch || busy !== null}
                        onClick={() => void previewMerge(candidate.name)}
                        className="flex items-center gap-0.5 rounded-[6px] px-1.5 py-1 text-[11px] text-gg-primary hover:bg-gg-subtle disabled:opacity-40"
                      >
                        {busy === `merge-preview:${candidate.name}`
                          ? <Loader2 size={10} className="animate-spin" />
                          : <GitMerge size={10} />}
                        合并
                      </button>
                      {candidate.name !== 'main' && deleteTarget !== candidate.name && (
                        <button
                          type="button"
                          aria-label={`删除分支 ${candidate.name}`}
                          disabled={!canChangeBranch || busy !== null}
                          onClick={() => setDeleteTarget(candidate.name)}
                          className="rounded-[6px] p-1 text-gg-muted hover:bg-gg-subtle hover:text-gg-danger disabled:opacity-40"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                      {deleteTarget === candidate.name && (
                        <span className="flex items-center gap-1">
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => void deleteBranch(candidate.name)}
                            className="text-[10px] text-gg-danger hover:underline"
                          >
                            确认删除
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(null)}
                            className="text-[10px] text-gg-muted hover:underline"
                          >
                            取消
                          </button>
                        </span>
                      )}
                    </>
                  )}
                </div>
              )
            })}
          </div>

          <div className="mt-2 flex gap-2">
            <input
              aria-label="新分支名称"
              value={newBranch}
              onChange={(event) => setNewBranch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void createBranch()
              }}
              placeholder="例如 experiment-a"
              className="h-8 min-w-0 flex-1 rounded-[8px] border border-gg-line bg-gg-node px-2.5 text-[12px] outline-none focus:border-gg-primary"
            />
            <button
              type="button"
              disabled={!canChangeBranch || busy !== null || !newBranch.trim()}
              onClick={() => void createBranch()}
              className="flex h-8 items-center gap-1 rounded-[8px] bg-gg-primary px-2.5 text-[11px] text-white disabled:opacity-40"
            >
              {busy === 'create-branch' ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
              新建
            </button>
          </div>
        </section>

        <section aria-labelledby="source-git-title">
          <h3 id="source-git-title" className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold">
            <GitBranch size={14} /> 源码 Git
          </h3>
          <SourceStatusCard
            status={view.source}
            branch={branch}
            busy={busy === 'bind-source'}
            disabled={!canChangeBranch || busy !== null}
            onBind={() => void bindSource()}
          />
          {currentSourceBinding && (
            <div className="mt-2">
              <button
                type="button"
                disabled={!canChangeBranch || busy !== null}
                onClick={() => void checkpointSource(false)}
                className="flex h-8 items-center gap-1 rounded-[8px] border border-gg-line px-2.5 text-[11px] text-gg-primary hover:bg-gg-subtle disabled:opacity-40"
              >
                {busy === 'source-checkpoint'
                  ? <Loader2 size={12} className="animate-spin" />
                  : <GitCommitHorizontal size={12} />}
                检查并提交源码变更
              </button>

              {pendingSourceCheckpoint && (
                <div role="alert" className="mt-2 rounded-[8px] border border-red-200 bg-red-50 p-2.5">
                  <p className="flex items-center gap-1.5 font-medium text-gg-danger">
                    <AlertTriangle size={12} /> 检测到需要确认的源码改动
                  </p>
                  <p className="mt-1 text-[10px] leading-4 text-gg-muted">
                    即使启用自动提交，敏感改动也不会自动提交。请检查风险后再明确确认。
                  </p>
                  {pendingSourceCheckpoint.checkpoint.warnings.length > 0 && (
                    <ul className="mt-2 space-y-1 text-[10px] text-gg-danger">
                      {pendingSourceCheckpoint.checkpoint.warnings.map((warning, index) => (
                        <li key={`${index}:${warning}`}>{sourceWarningLabel(warning)}</li>
                      ))}
                    </ul>
                  )}
                  {pendingSourceCheckpoint.checkpoint.paths.length > 0 && (
                    <div className="mt-2">
                      <p className="text-[10px] font-medium text-gg-ink">待提交路径</p>
                      <ul className="mt-1 max-h-20 space-y-0.5 overflow-y-auto text-[10px] text-gg-muted">
                        {pendingSourceCheckpoint.checkpoint.paths.map((path, index) => (
                          <li key={`${index}:${path}`}><code>{safeSourcePath(path)}</code></li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void checkpointSource(true)}
                      className="flex h-7 items-center gap-1 rounded-[7px] bg-gg-danger px-2 text-[10px] text-white disabled:opacity-40"
                    >
                      {busy === 'source-checkpoint-confirm'
                        ? <Loader2 size={11} className="animate-spin" />
                        : <ShieldCheck size={11} />}
                      确认风险并提交
                    </button>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => setPendingSourceCheckpoint(null)}
                      className="h-7 px-1 text-[10px] text-gg-muted hover:underline disabled:opacity-40"
                    >
                      暂不提交
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        <section aria-labelledby="automation-title">
          <h3 id="automation-title" className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold">
            <ShieldCheck size={14} /> 自动化策略
          </h3>
          <label className="flex items-center justify-between gap-3 rounded-[10px] border border-gg-line px-3 py-2.5">
            <span>
              <span className="block font-medium">源码提交</span>
              <span className="mt-0.5 block text-[10px] leading-4 text-gg-muted">
                大文件、密钥等敏感改动始终需要确认。
              </span>
            </span>
            <select
              aria-label="源码提交模式"
              value={view.preferences?.automationMode ?? 'confirm'}
              disabled={busy !== null}
              onChange={(event) => void updateAutomationMode(
                event.target.value as CanvasAutomationMode,
              )}
              className="h-8 rounded-[8px] border border-gg-line bg-gg-node px-2 text-[11px] outline-none focus:border-gg-primary"
            >
              <option value="confirm">每次确认</option>
              <option value="auto">安全改动自动提交</option>
            </select>
          </label>
        </section>
      </div>

      <section aria-labelledby="checkpoint-history-title">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 id="checkpoint-history-title" className="flex items-center gap-1.5 text-[13px] font-semibold">
            <GitCommitHorizontal size={14} /> 检查点历史
          </h3>
          <button
            type="button"
            disabled={!canChangeBranch || busy !== null}
            onClick={() => void checkpoint()}
            className="flex h-7 items-center gap-1 rounded-[7px] border border-gg-line px-2 text-[10px] hover:bg-gg-subtle disabled:opacity-40"
          >
            {busy === 'checkpoint' ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
            创建检查点
          </button>
        </div>

        {view.history.length === 0 ? (
          <div className="rounded-[10px] border border-dashed border-gg-line p-5 text-center text-[11px] leading-5 text-gg-muted">
            尚无检查点。画布保存后会自动生成，也可以现在手动创建。
          </div>
        ) : (
          <div className="overflow-hidden rounded-[10px] border border-gg-line">
            {view.history.map((entry) => (
              <div key={entry.commit} className="border-b border-gg-line p-2.5 last:border-b-0">
                <div className="flex items-start gap-2">
                  <GitCommitHorizontal size={13} className="mt-0.5 shrink-0 text-gg-primary" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{entry.subject || '画布检查点'}</p>
                    <p className="mt-0.5 flex items-center gap-2 text-[10px] text-gg-muted">
                      <code>{shortCommit(entry.commit)}</code>
                      <span>{formatCheckpointTime(entry.committedAt)}</span>
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={!canChangeBranch || busy !== null}
                    onClick={() => {
                      setRestoreCommit(entry.commit)
                      setRestoreBranch(`restore-${shortCommit(entry.commit)}`)
                    }}
                    className="flex items-center gap-0.5 rounded-[6px] px-1.5 py-1 text-[10px] text-gg-primary hover:bg-gg-subtle disabled:opacity-40"
                  >
                    恢复 <ChevronRight size={10} />
                  </button>
                </div>
                {restoreCommit === entry.commit && (
                  <div className="mt-2 flex gap-1.5 rounded-[8px] bg-gg-subtle p-2">
                    <input
                      aria-label="恢复到新分支"
                      value={restoreBranch}
                      onChange={(event) => setRestoreBranch(event.target.value)}
                      className="h-7 min-w-0 flex-1 rounded-[7px] border border-gg-line bg-gg-node px-2 text-[10px] outline-none focus:border-gg-primary"
                    />
                    <button
                      type="button"
                      disabled={!restoreBranch.trim() || busy !== null}
                      onClick={() => void restore()}
                      className="h-7 rounded-[7px] bg-gg-primary px-2 text-[10px] text-white disabled:opacity-40"
                    >
                      恢复为新分支
                    </button>
                    <button
                      type="button"
                      onClick={() => setRestoreCommit(null)}
                      className="h-7 px-1 text-[10px] text-gg-muted hover:underline"
                    >
                      取消
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {view.nextCursor && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void loadMore()}
            className="mt-2 flex w-full items-center justify-center gap-1 rounded-[8px] border border-gg-line py-1.5 text-[10px] text-gg-muted hover:bg-gg-subtle"
          >
            {busy === 'history-more' && <Loader2 size={11} className="animate-spin" />}
            加载更多
          </button>
        )}
      </section>

      {(error || notice) && (
        <div
          role={error ? 'alert' : 'status'}
          className={`flex items-start gap-1.5 rounded-[9px] px-3 py-2 md:col-span-2 ${
            error ? 'bg-red-50 text-gg-danger' : 'bg-blue-50 text-gg-primary'
          }`}
        >
          {error ? <AlertTriangle size={13} className="mt-0.5 shrink-0" /> : <Check size={13} className="mt-0.5 shrink-0" />}
          <span className="min-w-0 flex-1">{error ?? notice}</span>
          {error && (
            <button
              type="button"
              aria-label="重新读取版本信息"
              disabled={busy !== null}
              onClick={() => void readAll()}
              className="rounded-[6px] p-1 hover:bg-white/60 disabled:opacity-40"
            >
              <RefreshCw size={12} />
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function MergePreviewCard({
  preview,
  approved,
  busy,
  onApprovedChange,
  onConfirm,
  onClose,
}: {
  preview: WorkspaceMergePreview
  approved: boolean
  busy: boolean
  onApprovedChange: (approved: boolean) => void
  onConfirm: () => void
  onClose: () => void
}) {
  const conflicts = [
    ...preview.canvas.conflicts.map((conflict) => ({ scope: '画布', ...conflict })),
    ...(preview.source?.conflicts ?? []).map((conflict) => ({ scope: '源码', ...conflict })),
  ]
  const hasConflicts = preview.state === 'conflicts' || conflicts.length > 0
  const sourceBranch = preview.canvas.sourceBranch
  const targetBranch = preview.canvas.targetBranch

  return (
    <section
      aria-labelledby="merge-preview-title"
      className="rounded-[10px] border border-blue-200 bg-blue-50/60 p-3 md:col-span-2"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="merge-preview-title" className="flex items-center gap-1.5 font-semibold">
            <GitMerge size={13} className="text-gg-primary" /> 合并预览
          </h3>
          <p className="mt-1 text-[11px] text-gg-muted">
            <code>{sourceBranch}</code> → <code>{targetBranch}</code>
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={onClose}
          className="text-[10px] text-gg-muted hover:underline disabled:opacity-40"
        >
          关闭
        </button>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <MergeScopePreview label="画布状态" preview={preview.canvas} />
        {preview.source
          ? <MergeScopePreview label="源码工作树" preview={preview.source} />
          : (
            <div className="rounded-[8px] border border-gg-line bg-white p-2.5 text-[10px] text-gg-muted">
              源码 Git 未绑定，本次只合并画布状态。
            </div>
          )}
      </div>

      {hasConflicts ? (
        <div role="alert" className="mt-3 rounded-[8px] border border-red-200 bg-red-50 p-2.5">
          <p className="flex items-center gap-1.5 font-medium text-gg-danger">
            <AlertTriangle size={12} /> 检测到 {conflicts.length} 个冲突，合并未执行
          </p>
          <ul className="mt-1.5 max-h-24 space-y-1 overflow-y-auto text-[10px] text-gg-muted">
            {conflicts.map((conflict) => (
              <li key={`${conflict.scope}:${conflict.path}`}>
                <span className="mr-1 rounded-[4px] bg-white px-1 py-0.5">{conflict.scope}</span>
                <code>{conflict.path}</code> · {mergeConflictLabel(conflict.kind)}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[10px] leading-4 text-gg-danger">
            请通过单独的冲突解决流程处理。任何解决建议都不会在这里自动应用。
          </p>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2 rounded-[8px] border border-blue-200 bg-white p-2.5 sm:flex-row sm:items-center sm:justify-between">
          <label className="flex min-w-0 items-start gap-2 text-[10px] leading-4 text-gg-ink">
            <input
              type="checkbox"
              aria-label="明确确认合并预览"
              checked={approved}
              disabled={busy}
              onChange={(event) => onApprovedChange(event.target.checked)}
              className="mt-0.5"
            />
            <span>
              我已检查上述路径，确认将 <code>{sourceBranch}</code> 合并到 <code>{targetBranch}</code>。
              {preview.state === 'up-to-date' && ' 当前预览显示无需新增改动。'}
            </span>
          </label>
          <button
            type="button"
            disabled={!approved || busy}
            onClick={onConfirm}
            className="flex h-8 shrink-0 items-center justify-center gap-1 rounded-[8px] bg-gg-primary px-3 text-[11px] text-white disabled:opacity-40"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <GitMerge size={12} />}
            明确确认并合并
          </button>
        </div>
      )}
    </section>
  )
}

function MergeScopePreview({
  label,
  preview,
}: {
  label: string
  preview: WorkspaceMergePreview['canvas']
}) {
  return (
    <div className="rounded-[8px] border border-gg-line bg-white p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{label}</span>
        <span className={`text-[10px] ${preview.conflicts.length > 0 ? 'text-gg-danger' : 'text-gg-muted'}`}>
          {preview.conflicts.length > 0
            ? `${preview.conflicts.length} 个冲突`
            : preview.state === 'up-to-date' ? '无需改动' : `${preview.paths.length} 个路径`}
        </span>
      </div>
      {preview.paths.length > 0 && (
        <ul className="mt-1.5 max-h-20 space-y-0.5 overflow-y-auto text-[10px] text-gg-muted">
          {preview.paths.map((path) => <li key={path}><code>{path}</code></li>)}
        </ul>
      )}
    </div>
  )
}

function mergeConflictLabel(kind: WorkspaceMergePreview['canvas']['conflicts'][number]['kind']): string {
  switch (kind) {
    case 'content': return '内容冲突'
    case 'add-add': return '双方新增'
    case 'modify-delete': return '当前修改、来源删除'
    case 'delete-modify': return '当前删除、来源修改'
    case 'unknown': return '未知冲突'
  }
}

function VersioningBadge({ status }: { status: CanvasVersionStatuses['versioning'] | null }) {
  if (!status) return null
  if (status.state === 'ready') {
    return <span className="flex items-center gap-1 text-[10px] text-gg-success"><Check size={10} /> Git 已就绪</span>
  }
  if (status.state === 'uninitialized') {
    return <span className="text-[10px] text-gg-muted">首次检查点时初始化</span>
  }
  return (
    <span title={status.reason} className="flex items-center gap-1 text-[10px] text-gg-danger">
      <AlertTriangle size={10} /> Git 降级
    </span>
  )
}

function SourceStatusCard({
  status,
  branch,
  busy,
  disabled,
  onBind,
}: {
  status: SourceGitStatus | null
  branch: string
  busy: boolean
  disabled: boolean
  onBind: () => void
}) {
  if (!status) return null
  if (status.status === 'unavailable') {
    return (
      <p className="rounded-[10px] border border-gg-line px-3 py-2.5 text-[11px] leading-5 text-gg-muted">
        未检测到源码 Git 仓库。画布版本仍会独立保存。
      </p>
    )
  }
  if (status.status === 'degraded') {
    return (
      <p className="flex gap-1.5 rounded-[10px] border border-gg-line px-3 py-2.5 text-[11px] leading-5 text-gg-danger">
        <AlertTriangle size={13} className="mt-0.5 shrink-0" />
        {status.reason || '源码 Git 当前不可用'}
      </p>
    )
  }
  if (status.status === 'unbound') {
    return (
      <div className="rounded-[10px] border border-gg-line px-3 py-2.5">
        <p className="text-[11px] leading-5 text-gg-muted">
          已检测到源码仓库，但不会自动创建分支或提交。
        </p>
        <button
          type="button"
          disabled={disabled}
          onClick={onBind}
          className="mt-2 flex h-7 items-center gap-1 rounded-[7px] border border-gg-line px-2 text-[10px] text-gg-primary hover:bg-gg-subtle disabled:opacity-40"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <GitBranch size={11} />}
          显式绑定当前分支
        </button>
      </div>
    )
  }
  const binding = status.branches.find((candidate) => candidate.logicalBranch === branch)
  return (
    <div className="rounded-[10px] border border-gg-line px-3 py-2.5">
      <p className="flex items-center gap-1.5 font-medium text-gg-success">
        <Check size={12} /> 源码工作树已隔离
      </p>
      <p className="mt-1 text-[10px] text-gg-muted">
        {binding
          ? `${binding.gitBranch} · ${shortCommit(binding.head)}${binding.dirty ? ' · 有未提交改动' : ''}`
          : `当前画布分支 ${branch} 尚无对应源码工作树`}
      </p>
    </div>
  )
}
