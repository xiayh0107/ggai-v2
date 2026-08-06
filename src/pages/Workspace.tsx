import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { Link, useNavigate } from 'react-router'
import {
  Boxes,
  Compass,
  FolderKanban,
  FolderOpen,
  Home,
  Layers3,
  LayoutGrid,
  ListTodo,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  Settings,
  X,
} from 'lucide-react'
import { DAEMON_URL } from '@/agent/config'
import {
  WorkspaceProjectClient,
  type WorkspaceProject,
  type WorkspaceProjectApi,
} from '@/workspace/projectClient'
import { workspaceProjectErrorMessage } from '@/workspace/projectMessages'

const NAV = [
  { key: 'workspace', label: '工作空间', icon: Home, available: true },
  { key: 'discover', label: '发现灵感', icon: Compass, available: false },
  { key: 'templates', label: '模板中心', icon: LayoutGrid, available: false },
  { key: 'assets', label: '资源库', icon: FolderOpen, available: false },
  { key: 'settings', label: '设置', icon: Settings, available: false },
] as const

type WorkspaceTab = '个人' | '团队项目'
type LoadingState = 'loading' | 'ready' | 'error'

export interface WorkspaceProps {
  projectClient?: WorkspaceProjectApi
}

export default function Workspace({ projectClient: injectedClient }: WorkspaceProps = {}) {
  const navigate = useNavigate()
  const client = useMemo(
    () => injectedClient ?? new WorkspaceProjectClient({ baseUrl: DAEMON_URL }),
    [injectedClient],
  )
  const [tab, setTab] = useState<WorkspaceTab>('个人')
  const [projects, setProjects] = useState<WorkspaceProject[]>([])
  const [loadingState, setLoadingState] = useState<LoadingState>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [projectTitle, setProjectTitle] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const listControllerRef = useRef<AbortController | null>(null)
  const createControllerRef = useRef<AbortController | null>(null)
  const loadedOnceRef = useRef(false)
  const createTriggerRef = useRef<HTMLElement | null>(null)

  const loadProjects = useCallback(async () => {
    listControllerRef.current?.abort()
    const controller = new AbortController()
    listControllerRef.current = controller
    if (!loadedOnceRef.current) setLoadingState('loading')
    setRefreshError(null)
    try {
      const next = sortProjects(await client.list(controller.signal))
      if (controller.signal.aborted) return
      setProjects(next)
      setLoadError(null)
      setLoadingState('ready')
      loadedOnceRef.current = true
    } catch (error) {
      if (controller.signal.aborted) return
      const message = workspaceProjectErrorMessage(
        error,
        '项目列表暂时无法加载，请稍后重试。',
      )
      if (loadedOnceRef.current) {
        setRefreshError(message)
      } else {
        setLoadError(message)
        setLoadingState('error')
      }
    }
  }, [client])

  useEffect(() => {
    void loadProjects()
    const refreshOnFocus = () => void loadProjects()
    window.addEventListener('focus', refreshOnFocus)
    return () => {
      window.removeEventListener('focus', refreshOnFocus)
      listControllerRef.current?.abort()
      createControllerRef.current?.abort()
    }
  }, [loadProjects])

  const visibleProjects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN')
    if (!normalized) return projects
    return projects.filter((project) =>
      project.title.toLocaleLowerCase('zh-CN').includes(normalized))
  }, [projects, query])

  const recentProjects = useMemo(
    () => visibleProjects
      .filter((project) => project.state === 'ready' && project.lastOpenedAt !== null)
      .sort((left, right) => Date.parse(right.lastOpenedAt!) - Date.parse(left.lastOpenedAt!))
      .slice(0, 8),
    [visibleProjects],
  )

  const openCreateDialog = () => {
    createTriggerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    setProjectTitle('')
    setCreateError(null)
    setCreateOpen(true)
  }

  const closeCreateDialog = () => {
    if (creating) return
    setCreateOpen(false)
    setCreateError(null)
    window.requestAnimationFrame(() => createTriggerRef.current?.focus())
  }

  const createProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const title = projectTitle.trim()
    if (!title) {
      setCreateError('请输入项目名称')
      return
    }
    createControllerRef.current?.abort()
    const controller = new AbortController()
    createControllerRef.current = controller
    setCreating(true)
    setCreateError(null)
    try {
      const project = await client.create(title, controller.signal)
      if (controller.signal.aborted) return
      setProjects((current) => sortProjects([
        project,
        ...current.filter((entry) => entry.id !== project.id),
      ]))
      if (project.state !== 'ready') {
        setCreateError('项目已创建，但当前暂时无法打开')
        return
      }
      setCreateOpen(false)
      navigate(projectHref(project.id))
    } catch (error) {
      if (!controller.signal.aborted) {
        setCreateError(workspaceProjectErrorMessage(error, '项目创建失败，请稍后重试。'))
      }
    } finally {
      if (!controller.signal.aborted) setCreating(false)
    }
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-gg-bg font-sans">
      <header className="flex h-[56px] shrink-0 items-center justify-between border-b border-gg-line bg-gg-node px-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-gg-primary text-[14px] font-semibold text-white">G</div>
          <div>
            <p className="text-[14.5px] font-semibold leading-4 text-gg-ink">GGAI</p>
            <p className="text-[10.5px] leading-3 text-gg-muted">Generative Graphics AI</p>
          </div>
        </div>
        <span className="text-[12px] text-gg-muted">本地工作空间</span>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav aria-label="主导航" className="flex w-[180px] shrink-0 flex-col gap-0.5 border-r border-gg-line bg-gg-node p-3">
          {NAV.map(({ key, label, icon: Icon, available }) => (
            <button
              key={key}
              type="button"
              disabled={!available}
              aria-current={available ? 'page' : undefined}
              title={available ? undefined : '尚未开放'}
              className={`flex items-center gap-2.5 rounded-[10px] px-3 py-2 text-left text-[13px] ${
                available
                  ? 'bg-[#EAF1FD] font-medium text-gg-primary'
                  : 'cursor-not-allowed text-gg-muted opacity-55'
              }`}
            >
              <Icon size={15} strokeWidth={1.8} />
              {label}
            </button>
          ))}
        </nav>

        <main className="min-w-0 flex-1 overflow-y-auto px-8 pb-12 pt-6">
          <div className="flex items-center justify-between gap-4">
            <div role="tablist" aria-label="项目范围" className="flex gap-5">
              {(['个人', '团队项目'] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={tab === item}
                  onClick={() => setTab(item)}
                  className={`border-b-2 pb-2 text-[14px] transition-colors ${
                    tab === item
                      ? 'border-gg-primary font-medium text-gg-ink'
                      : 'border-transparent text-gg-muted hover:text-gg-ink'
                  }`}
                >
                  {item}
                </button>
              ))}
            </div>
            {tab === '个人' && (
              <div className="flex items-center gap-3">
                <label className="flex h-9 w-[300px] items-center gap-2 rounded-[10px] border border-gg-line bg-gg-node px-3 focus-within:border-gg-primary">
                  <Search size={14} className="shrink-0 text-gg-muted" />
                  <span className="sr-only">搜索项目</span>
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索项目名称"
                    className="w-full bg-transparent text-[12.5px] text-gg-ink outline-none placeholder:text-[#98A2B3]"
                  />
                </label>
                <button
                  type="button"
                  onClick={openCreateDialog}
                  className="flex h-9 items-center gap-1.5 rounded-[10px] bg-gg-primary px-4 text-[13px] font-medium text-white transition-colors hover:bg-gg-select"
                >
                  <Plus size={15} /> 新建项目
                </button>
              </div>
            )}
          </div>

          {tab === '团队项目' ? (
            <EmptyPanel
              icon={Layers3}
              title="团队项目尚未启用"
              detail="团队协作能力开放后，你的团队项目会显示在这里。"
            />
          ) : loadingState === 'loading' ? (
            <WorkspaceLoading />
          ) : loadingState === 'error' ? (
            <WorkspaceError message={loadError ?? '项目列表加载失败'} onRetry={loadProjects} />
          ) : (
            <>
              {refreshError && (
                <div role="alert" className="mt-5 flex items-center justify-between rounded-[12px] border border-amber-200 bg-amber-50 px-4 py-2.5 text-[12px] text-amber-800">
                  <span>{refreshError}</span>
                  <button type="button" onClick={() => void loadProjects()} className="font-medium hover:underline">
                    重试
                  </button>
                </div>
              )}

              {visibleProjects.length === 0 ? (
                <EmptyPanel
                  icon={FolderKanban}
                  title={query.trim() ? '没有匹配的项目' : '还没有项目'}
                  detail={query.trim() ? '换一个项目名称试试。' : '创建第一个项目，开始组织你的画布工作。'}
                  action={query.trim() ? undefined : openCreateDialog}
                />
              ) : (
                <>
                  <h2 className="mt-7 text-[15px] font-semibold text-gg-ink">继续工作</h2>
                  <div className="mt-3.5 grid grid-cols-3 gap-4 max-[1200px]:grid-cols-2">
                    {visibleProjects.map((project) => (
                      <ProjectCard
                        key={project.id}
                        project={project}
                      />
                    ))}
                  </div>

                  <h2 className="mt-8 text-[15px] font-semibold text-gg-ink">最近打开</h2>
                  {recentProjects.length > 0 ? (
                    <div className="mt-3 overflow-hidden rounded-[14px] border border-gg-line bg-gg-node">
                      {recentProjects.map((project, index) => (
                        <ProjectRow
                          key={project.id}
                          project={project}
                          divided={index > 0}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 rounded-[14px] border border-dashed border-gg-line bg-gg-node px-4 py-5 text-[12px] text-gg-muted">
                      打开项目后，它会出现在这里。
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </main>
      </div>

      {createOpen && (
        <CreateProjectDialog
          title={projectTitle}
          error={createError}
          creating={creating}
          onTitleChange={setProjectTitle}
          onCancel={closeCreateDialog}
          onSubmit={createProject}
        />
      )}
    </div>
  )
}

function ProjectCard({
  project,
}: {
  project: WorkspaceProject
}) {
  const unavailable = project.state === 'unavailable'
  const className = `group overflow-hidden rounded-[14px] border bg-gg-node transition-all duration-150 ${
    unavailable
      ? 'border-gg-line opacity-65'
      : 'border-gg-line hover:-translate-y-0.5 hover:border-gg-select hover:shadow-float'
  }`
  const content = (
    <>
      <ProjectPreview project={project} />
      <div className="px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <p className="truncate text-[13.5px] font-medium text-gg-ink">{project.title}</p>
        </div>
        <div className="mt-1.5 flex items-center gap-2 text-[11.5px] text-gg-muted">
          <span>{unavailable ? '暂时不可用' : '个人项目'}</span>
          <span aria-hidden="true">·</span>
          <span>{formatProjectTime(project.lastOpenedAt ?? project.updatedAt)}</span>
        </div>
      </div>
    </>
  )
  if (unavailable) {
    return (
      <div aria-disabled="true" className={className} title="项目当前不可用">
        {content}
      </div>
    )
  }
  return <Link to={projectHref(project.id)} className={className}>{content}</Link>
}

function ProjectPreview({ project }: { project: WorkspaceProject }) {
  const summary = project.summary
  return (
    <div className="flex aspect-[340/150] items-center justify-center border-b border-gg-line bg-gg-subtle/60 px-5">
      {summary ? (
        <div className="grid w-full max-w-[280px] grid-cols-3 gap-2">
          <SummaryMetric icon={ListTodo} value={summary.taskCount} label="任务" />
          <SummaryMetric icon={Boxes} value={summary.nodeCount} label="节点" />
          <SummaryMetric icon={Layers3} value={summary.collectionCount} label="集合" />
        </div>
      ) : (
        <div className="flex items-center gap-2 text-[12px] text-gg-muted">
          <FolderKanban size={17} /> 项目摘要暂不可用
        </div>
      )}
    </div>
  )
}

function SummaryMetric({
  icon: Icon,
  value,
  label,
}: {
  icon: typeof Boxes
  value: number
  label: string
}) {
  return (
    <span className="flex flex-col items-center rounded-[10px] border border-gg-line bg-white px-2 py-2.5">
      <Icon size={14} className="mb-1 text-gg-primary" />
      <strong className="text-[16px] font-semibold leading-5 text-gg-ink">{value}</strong>
      <span className="text-[10.5px] text-gg-muted">{label}</span>
    </span>
  )
}

function ProjectRow({
  project,
  divided,
}: {
  project: WorkspaceProject
  divided: boolean
}) {
  const unavailable = project.state === 'unavailable'
  const className = `flex items-center gap-3 px-4 py-3 transition-colors ${
    divided ? 'border-t border-gg-line ' : ''
  }${unavailable ? 'opacity-65' : 'hover:bg-gg-subtle'}`
  const content = (
    <>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-gg-subtle text-gg-primary">
        <FolderKanban size={15} strokeWidth={1.8} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-gg-ink">{project.title}</span>
      {project.summary && (
        <span className="hidden text-[11.5px] text-gg-muted min-[900px]:inline">
          {project.summary.taskCount} 个任务 · {project.summary.nodeCount} 个节点
        </span>
      )}
      <span className="w-[110px] text-right text-[11.5px] text-gg-muted">
        {unavailable ? '暂时不可用' : formatProjectTime(project.lastOpenedAt ?? project.updatedAt)}
      </span>
    </>
  )
  if (unavailable) {
    return <div aria-disabled="true" className={className}>{content}</div>
  }
  return <Link to={projectHref(project.id)} className={className}>{content}</Link>
}

function CreateProjectDialog({
  title,
  error,
  creating,
  onTitleChange,
  onCancel,
  onSubmit,
}: {
  title: string
  error: string | null
  creating: boolean
  onTitleChange: (title: string) => void
  onCancel: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  const dialogRef = useRef<HTMLFormElement>(null)
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-project-title"
        aria-describedby="create-project-detail"
        onSubmit={onSubmit}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel()
          if (event.key === 'Tab') keepFocusInside(event, dialogRef.current)
        }}
        className="w-full max-w-[420px] rounded-[16px] border border-gg-line bg-gg-node p-5 shadow-float"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="create-project-title" className="text-[15px] font-semibold text-gg-ink">新建项目</h2>
            <p id="create-project-detail" className="mt-1 text-[12px] leading-5 text-gg-muted">
              项目会拥有独立的画布、任务和产物。
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={creating}
            aria-label="关闭新建项目窗口"
            className="flex h-7 w-7 items-center justify-center rounded-[8px] text-gg-muted hover:bg-gg-subtle hover:text-gg-ink disabled:opacity-50"
          >
            <X size={15} />
          </button>
        </div>

        <label htmlFor="workspace-project-title" className="mt-5 block text-[12px] font-medium text-gg-ink">
          项目名称
        </label>
        <input
          id="workspace-project-title"
          autoFocus
          required
          maxLength={120}
          value={title}
          onChange={(event) => onTitleChange(event.target.value)}
          disabled={creating}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'create-project-error' : undefined}
          placeholder="例如：实验结果分析"
          className="mt-2 h-10 w-full rounded-[10px] border border-gg-line bg-white px-3 text-[13px] text-gg-ink outline-none transition-colors placeholder:text-[#98A2B3] focus:border-gg-primary disabled:bg-gg-subtle"
        />
        {error && (
          <p id="create-project-error" role="alert" className="mt-2 text-[11.5px] text-red-600">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={creating}
            className="h-9 rounded-[10px] border border-gg-line bg-white px-4 text-[13px] text-gg-ink hover:bg-gg-subtle disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={creating || !title.trim()}
            className="flex h-9 items-center gap-1.5 rounded-[10px] bg-gg-primary px-4 text-[13px] font-medium text-white hover:bg-gg-select disabled:cursor-not-allowed disabled:opacity-50"
          >
            {creating && <Loader2 size={14} className="animate-spin" />}
            {creating ? '正在创建' : '创建并打开'}
          </button>
        </div>
      </form>
    </div>
  )
}

function WorkspaceLoading() {
  return (
    <div role="status" aria-label="正在加载项目" className="mt-7">
      <div className="flex items-center gap-2 text-[13px] text-gg-muted">
        <Loader2 size={15} className="animate-spin" /> 正在加载项目…
      </div>
      <div className="gg-shimmer mt-4 grid grid-cols-3 gap-4 max-[1200px]:grid-cols-2" aria-hidden="true">
        {[0, 1, 2].map((item) => (
          <div key={item} className="h-[220px] rounded-[14px] border border-gg-line bg-gg-node p-4">
            <div className="h-[140px] rounded-[10px] bg-gg-subtle" />
            <div className="mt-4 h-3 w-2/3 rounded bg-gg-subtle" />
            <div className="mt-2 h-2.5 w-1/3 rounded bg-gg-subtle" />
          </div>
        ))}
      </div>
    </div>
  )
}

function WorkspaceError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="mt-12 flex flex-col items-center rounded-[14px] border border-gg-line bg-gg-node px-6 py-10 text-center">
      <FolderKanban size={24} className="text-gg-muted" />
      <h2 className="mt-3 text-[14px] font-semibold text-gg-ink">项目列表加载失败</h2>
      <p className="mt-1 max-w-md text-[12px] leading-5 text-gg-muted">{message}</p>
      <button
        type="button"
        onClick={() => void onRetry()}
        className="mt-4 flex h-9 items-center gap-1.5 rounded-[10px] bg-gg-primary px-4 text-[13px] font-medium text-white hover:bg-gg-select"
      >
        <RotateCcw size={14} /> 重试
      </button>
    </div>
  )
}

function EmptyPanel({
  icon: Icon,
  title,
  detail,
  action,
}: {
  icon: typeof FolderKanban
  title: string
  detail: string
  action?: () => void
}) {
  return (
    <section className="mt-12 flex flex-col items-center rounded-[14px] border border-dashed border-gg-line bg-gg-node px-6 py-12 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-[12px] bg-gg-subtle text-gg-muted">
        <Icon size={21} />
      </span>
      <h2 className="mt-3 text-[14px] font-semibold text-gg-ink">{title}</h2>
      <p className="mt-1 text-[12px] leading-5 text-gg-muted">{detail}</p>
      {action && (
        <button
          type="button"
          onClick={action}
          className="mt-4 flex h-9 items-center gap-1.5 rounded-[10px] bg-gg-primary px-4 text-[13px] font-medium text-white hover:bg-gg-select"
        >
          <Plus size={14} /> 新建项目
        </button>
      )}
    </section>
  )
}

function projectHref(projectId: string): string {
  return `/canvas?project=${encodeURIComponent(projectId)}`
}

function sortProjects(projects: WorkspaceProject[]): WorkspaceProject[] {
  return [...projects].sort((left, right) => {
    const rightTime = Date.parse(right.lastOpenedAt ?? right.updatedAt)
    const leftTime = Date.parse(left.lastOpenedAt ?? left.updatedAt)
    return rightTime - leftTime || left.title.localeCompare(right.title, 'zh-CN')
  })
}

function formatProjectTime(value: string): string {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return '时间未知'
  const date = new Date(time)
  const now = new Date()
  const day = 24 * 60 * 60 * 1_000
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const days = Math.round((startOfToday - startOfDate) / day)
  if (days === 0) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  if (days === 1) return '昨天'
  if (days > 1 && days < 7) return `${days} 天前`
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

function keepFocusInside(
  event: ReactKeyboardEvent<HTMLElement>,
  dialog: HTMLElement | null,
) {
  if (!dialog) return
  const focusable = [...dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hasAttribute('hidden'))
  if (focusable.length === 0) {
    event.preventDefault()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}
