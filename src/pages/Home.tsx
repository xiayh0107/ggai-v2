import { Loader2, RotateCcw, ShieldAlert } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { DAEMON_URL } from '@/agent/config'
import {
  CanvasBootstrap,
  type CanvasBootstrapFailure,
} from '@/canvas/CanvasBootstrap'
import { CanvasDaemonClient } from '@/canvas/daemonClient'
import {
  CanvasScopeError,
  canvasProjectIdFromSearch,
} from '@/canvas/scope'
import {
  WorkspaceProjectClient,
  type WorkspaceProject,
  type WorkspaceProjectApi,
} from '@/workspace/projectClient'
import { workspaceProjectErrorMessage } from '@/workspace/projectMessages'
import CanvasHome from './CanvasHome'

export default function Home() {
  const capabilityClient = useMemo(
    () => new CanvasDaemonClient({ baseUrl: DAEMON_URL }),
    [],
  )
  const projectClient = useMemo(
    () => new WorkspaceProjectClient({ baseUrl: DAEMON_URL }),
    [],
  )
  let projectId: string
  try {
    projectId = canvasProjectIdFromSearch(window.location.search)
  } catch (error) {
    return (
      <CanvasProjectUnavailable
        title="项目地址无效"
        message={error instanceof CanvasScopeError
          ? '这个链接没有包含有效的项目标识。画布没有回退到其他项目，以免打开或修改错误的内容。'
          : '无法解析项目地址。'}
      />
    )
  }
  return (
    <CanvasBootstrap
      client={capabilityClient}
      loading={<CanvasModelLoading />}
      blocked={(failure, retry) => (
        <CanvasUnavailable failure={failure} onRetry={retry} />
      )}
    >
      <CanvasProjectBootstrap client={projectClient} projectId={projectId}>
        {(project) => (
          <CanvasHome
            projectId={project.id}
            projectDir={project.projectDir}
            projectTitle={project.title}
          />
        )}
      </CanvasProjectBootstrap>
    </CanvasBootstrap>
  )
}

export interface CanvasProjectBootstrapProps {
  client: Pick<WorkspaceProjectApi, 'open'>
  projectId: string
  children: (project: WorkspaceProject) => ReactNode
}

type ProjectBootstrapState =
  | { requestKey: string; status: 'loading' }
  | { requestKey: string; status: 'ready'; project: WorkspaceProject }
  | { requestKey: string; status: 'error'; message: string }

/** Resolves a catalog id before any project-scoped Canvas store is mounted. */
export function CanvasProjectBootstrap({
  client,
  projectId,
  children,
}: CanvasProjectBootstrapProps) {
  const [attempt, setAttempt] = useState(0)
  const requestKey = `${projectId}:${attempt}`
  const [state, setState] = useState<ProjectBootstrapState>({
    requestKey,
    status: 'loading',
  })

  useEffect(() => {
    const controller = new AbortController()
    void client.open(projectId, controller.signal).then(
      (project) => {
        if (controller.signal.aborted) return
        if (project.id !== projectId) {
          setState({
            requestKey,
            status: 'error',
            message: '项目服务返回了不匹配的数据，画布没有打开。',
          })
          return
        }
        if (project.state !== 'ready') {
          setState({
            requestKey,
            status: 'error',
            message: '项目目录当前不可用，请检查本地项目状态。',
          })
          return
        }
        setState({ requestKey, status: 'ready', project })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setState({
          requestKey,
          status: 'error',
          message: workspaceProjectErrorMessage(error, '项目暂时无法打开，请稍后重试。'),
        })
      },
    )
    return () => controller.abort()
  }, [client, projectId, requestKey])

  const visibleState: ProjectBootstrapState = state.requestKey === requestKey
    ? state
    : { requestKey, status: 'loading' }

  if (visibleState.status === 'loading') {
    return (
      <main className="flex h-screen w-screen items-center justify-center bg-gg-bg font-sans">
        <div className="flex items-center gap-2 text-[13px] text-gg-muted">
          <Loader2 size={16} className="animate-spin" /> 正在打开项目…
        </div>
      </main>
    )
  }
  if (visibleState.status === 'error') {
    return (
      <CanvasProjectUnavailable
        title="项目无法打开"
        message={visibleState.message}
        onRetry={() => setAttempt((current) => current + 1)}
      />
    )
  }
  return children(visibleState.project)
}

function CanvasProjectUnavailable({
  title,
  message,
  onRetry,
}: {
  title: string
  message: string
  onRetry?: () => void
}) {
  return (
    <main className="flex h-screen w-screen items-center justify-center bg-gg-bg p-6 font-sans">
      <div role="alert" className="flex max-w-md flex-col items-center gap-3 rounded-[16px] border border-gg-line bg-gg-node p-6 text-center">
        <ShieldAlert size={24} className="text-amber-600" />
        <h1 className="text-[15px] font-semibold text-gg-ink">{title}</h1>
        <p className="text-[12px] leading-5 text-gg-muted">{message}</p>
        <div className="flex items-center gap-2">
          <a
            href="/"
            className="flex h-8 items-center rounded-[10px] border border-gg-line bg-white px-3 text-[13px] text-gg-ink transition-colors hover:border-gg-primary"
          >
            返回工作空间
          </a>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="flex h-8 items-center gap-1.5 rounded-[10px] bg-gg-primary px-3 text-[13px] text-white transition-colors hover:bg-gg-select"
            >
              <RotateCcw size={14} /> 重试
            </button>
          )}
        </div>
      </div>
    </main>
  )
}

function CanvasUnavailable({
  failure,
  onRetry,
}: {
  failure: CanvasBootstrapFailure
  onRetry: () => void
}) {
  const explanation = failure.reason === 'daemon-incompatible'
    ? '本地 daemon 仍在使用已退役的根项目启动协议，请重启应用加载当前版本。'
    : '无法确认本地 daemon 的 Canvas 能力。请确认 daemon 已启动，并检查终端中的启动错误。'

  return (
    <main className="flex h-screen w-screen items-center justify-center bg-gg-bg p-6 font-sans">
      <div role="alert" className="flex max-w-md flex-col items-center gap-3 rounded-[16px] border border-gg-line bg-gg-node p-6 text-center">
        <ShieldAlert size={24} className="text-amber-600" />
        <h1 className="text-[15px] font-semibold text-gg-ink">Canvas 尚未就绪</h1>
        <p className="text-[12px] leading-5 text-gg-muted">{explanation}</p>
        {failure.message && (
          <p className="max-w-full break-words rounded-[10px] bg-gg-subtle px-3 py-2 text-[11px] text-gg-muted">
            {failure.message}
          </p>
        )}
        <button
          type="button"
          onClick={onRetry}
          className="flex h-8 items-center gap-1.5 rounded-[10px] bg-gg-primary px-3 text-[13px] text-white transition-colors hover:bg-gg-select"
        >
          <RotateCcw size={14} /> 重新检查
        </button>
      </div>
    </main>
  )
}

function CanvasModelLoading() {
  return (
    <main className="flex h-screen w-screen items-center justify-center bg-gg-bg font-sans">
      <div className="flex items-center gap-2 text-[13px] text-gg-muted">
        <Loader2 size={16} className="animate-spin" /> 正在确认 Canvas 能力…
      </div>
    </main>
  )
}
