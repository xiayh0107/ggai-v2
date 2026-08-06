import { Boxes, ChevronLeft, History, Loader2, RotateCcw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { DAEMON_URL } from '@/agent/config'
import { useCanvasV2State, useCanvasV2Store } from '@/canvas-v2/hooks'
import {
  useCanvasV2BranchNavigation,
  type CanvasV2BranchNavigationCommit,
} from '@/canvas-v2/versioningNavigation'
import { CanvasV2VersioningClient } from '@/canvas-v2/versioningClient'
import CanvasV2Stage from './CanvasV2Stage'
import CanvasV2VersioningPanel from './CanvasV2VersioningPanel'

export interface CanvasV2ShellProps {
  versioningClient?: CanvasV2VersioningClient
  branchNavigationCommit?: CanvasV2BranchNavigationCommit
  projectTitle?: string
}

export default function CanvasV2Shell({
  versioningClient: injectedVersioningClient,
  branchNavigationCommit,
  projectTitle = '当前项目',
}: CanvasV2ShellProps = {}) {
  const store = useCanvasV2Store()
  const state = useCanvasV2State()
  const [versioningOpen, setVersioningOpen] = useState(false)
  const versioningClient = useMemo(
    () => injectedVersioningClient ?? new CanvasV2VersioningClient({ baseUrl: DAEMON_URL }),
    [injectedVersioningClient],
  )
  const navigateBranch = useCanvasV2BranchNavigation(branchNavigationCommit)

  if (state.hydration.status === 'idle' || state.hydration.status === 'loading') {
    return (
      <main className="flex h-screen w-screen items-center justify-center bg-gg-bg font-sans">
        <div className="flex items-center gap-2 text-[13px] text-gg-muted">
          <Loader2 size={16} className="animate-spin" /> 正在加载 Canvas V2…
        </div>
      </main>
    )
  }

  if (state.hydration.status === 'error') {
    return (
      <main className="flex h-screen w-screen items-center justify-center bg-gg-bg p-6 font-sans">
        <div className="flex max-w-sm flex-col items-center gap-3 rounded-[16px] border border-gg-line bg-gg-node p-6 text-center">
          <h1 className="text-[15px] font-semibold text-gg-ink">Canvas V2 加载失败</h1>
          <p className="text-[12px] leading-5 text-gg-muted">
            {state.hydration.error ?? '无法读取 V2 画布数据'}
          </p>
          <button
            type="button"
            onClick={() => void store.reload()}
            className="flex h-8 items-center gap-1.5 rounded-[10px] bg-gg-primary px-3 text-[13px] text-white transition-colors hover:bg-gg-select"
          >
            <RotateCcw size={14} /> 重试
          </button>
        </div>
      </main>
    )
  }

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-gg-bg font-sans text-gg-ink">
      <header className="absolute inset-x-0 top-0 z-10 flex h-[52px] items-center justify-between border-b border-gg-line bg-gg-node/95 px-4">
        <div className="flex min-w-0 items-center gap-2 text-[13px] font-semibold">
          <Link
            to="/"
            title="返回工作空间"
            aria-label="返回工作空间"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-gg-muted transition-colors hover:bg-gg-subtle hover:text-gg-ink"
          >
            <ChevronLeft size={16} />
          </Link>
          <Boxes size={16} className="text-gg-primary" /> Canvas V2
          <span className="rounded-full bg-gg-subtle px-2 py-0.5 text-[10px] font-medium text-gg-muted">
            V2
          </span>
          <span className="h-4 w-px shrink-0 bg-gg-line" />
          <span className="max-w-[260px] truncate font-medium text-gg-ink" title={projectTitle}>
            {projectTitle}
          </span>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-gg-muted">
          <span>{state.document.tasks.length} 个任务</span>
          <span>{state.document.nodes.length} 个节点</span>
          {state.commandSync.pendingCount > 0 && (
            <span>待同步 {state.commandSync.pendingCount}</span>
          )}
          <button
            type="button"
            onClick={() => setVersioningOpen(true)}
            className="flex h-8 items-center gap-1.5 rounded-[10px] border border-gg-line bg-white px-3 text-[11px] font-medium text-gg-ink transition-colors hover:border-gg-primary"
            aria-haspopup="dialog"
          >
            <History size={13} /> {state.scope.branch} · 版本历史
          </button>
        </div>
      </header>
      <div className="absolute inset-x-0 bottom-0 top-[52px]">
        <CanvasV2Stage />
      </div>
      {versioningOpen && (
        <CanvasV2VersioningPanel
          client={versioningClient}
          projectDir={state.scope.projectDir}
          branch={state.scope.branch}
          store={store}
          onNavigateBranch={navigateBranch}
          onClose={() => setVersioningOpen(false)}
        />
      )}
    </main>
  )
}
