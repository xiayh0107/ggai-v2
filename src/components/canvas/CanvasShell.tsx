import { ChevronLeft, Loader2, RotateCcw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { DAEMON_URL } from '@/agent/config'
import { useCanvasState, useCanvasStore } from '@/canvas/hooks'
import { CanvasWorkbenchControllerProvider } from '@/canvas/workbenchController'
import {
  useCanvasBranchNavigation,
  type CanvasBranchNavigationCommit,
} from '@/canvas/versioningNavigation'
import { CanvasVersioningClient } from '@/canvas/versioningClient'
import {
  ProjectArtifactCatalogClient,
  type ProjectArtifactCatalogApi,
} from '@/resources/artifactCatalogClient'
import { SkillAssetClient, type SkillAssetApi } from '@/skills/client'
import CanvasStage from './CanvasStage'
import CanvasVersioningPanel from './CanvasVersioningPanel'
import CanvasWorkbench from './CanvasWorkbench'

export interface CanvasShellProps {
  versioningClient?: CanvasVersioningClient
  branchNavigationCommit?: CanvasBranchNavigationCommit
  artifactApi?: ProjectArtifactCatalogApi
  skillApi?: SkillAssetApi
  projectId?: string
  projectTitle?: string
}

export default function CanvasShell({
  versioningClient: injectedVersioningClient,
  branchNavigationCommit,
  artifactApi: injectedArtifactApi,
  skillApi: injectedSkillApi,
  projectId,
  projectTitle = '当前项目',
}: CanvasShellProps = {}) {
  const store = useCanvasStore()
  const state = useCanvasState()
  const [versioningOpen, setVersioningOpen] = useState(false)
  const versioningClient = useMemo(
    () => injectedVersioningClient ?? new CanvasVersioningClient({ baseUrl: DAEMON_URL }),
    [injectedVersioningClient],
  )
  const artifactApi = useMemo(
    () => injectedArtifactApi ?? new ProjectArtifactCatalogClient({ baseUrl: DAEMON_URL }),
    [injectedArtifactApi],
  )
  const skillApi = useMemo(
    () => injectedSkillApi ?? new SkillAssetClient({ baseUrl: DAEMON_URL }),
    [injectedSkillApi],
  )
  const navigateBranch = useCanvasBranchNavigation(branchNavigationCommit)

  if (state.hydration.status === 'idle' || state.hydration.status === 'loading') {
    return (
      <main className="flex h-screen w-screen items-center justify-center bg-gg-bg font-sans">
        <div className="flex items-center gap-2 text-[13px] text-gg-muted">
          <Loader2 size={16} className="animate-spin" /> 正在打开画布…
        </div>
      </main>
    )
  }

  if (state.hydration.status === 'error') {
    return (
      <main className="flex h-screen w-screen items-center justify-center bg-gg-bg p-6 font-sans">
        <div
          role="alert"
          className="flex max-w-sm flex-col items-center gap-3 rounded-[16px] border border-gg-line bg-gg-node p-6 text-center"
        >
          <h1 className="text-[15px] font-semibold text-gg-ink">画布加载失败</h1>
          <p className="text-[12px] leading-5 text-gg-muted">
            {state.hydration.error ?? '无法读取画布数据'}
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
          <span className="max-w-[360px] truncate text-[14px] text-gg-ink" title={projectTitle}>
            {projectTitle}
          </span>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-gg-muted">
          {state.commandSync.pendingCount > 0 && (
            <span role="status">正在保存</span>
          )}
        </div>
      </header>
      <div className="absolute inset-x-0 bottom-0 top-[52px]">
        <CanvasWorkbenchControllerProvider skillApi={skillApi}>
          <CanvasStage />
          <CanvasWorkbench
            projectId={projectId}
            artifactApi={artifactApi}
            skillApi={skillApi}
            onOpenHistory={() => setVersioningOpen(true)}
          />
        </CanvasWorkbenchControllerProvider>
      </div>
      {versioningOpen && (
        <CanvasVersioningPanel
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
