import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { useNavigate } from 'react-router'
import {
  Compass,
  FolderKanban,
  FolderOpen,
  Home,
  Layers3,
  LayoutGrid,
  Plus,
  Search,
  Settings,
  Wrench,
} from 'lucide-react'
import { DAEMON_URL } from '@/agent/config'
import {
  CreateProjectDialog,
  DeleteProjectDialog,
} from '@/workspace/WorkspaceProjectDialogs'
import {
  EmptyPanel,
  ProjectCard,
  ProjectRow,
  WorkspaceError,
  WorkspaceLoading,
} from '@/workspace/WorkspaceProjectViews'
import {
  WorkspaceProjectClient,
  isManagedWorkspaceProjectId,
  type WorkspaceProject,
  type WorkspaceProjectApi,
} from '@/workspace/projectClient'
import { workspaceProjectErrorMessage } from '@/workspace/projectMessages'
import { projectHref, sortProjects } from '@/workspace/projectViewModel'

const NAV = [
  { key: 'workspace', label: '工作空间', icon: Home, available: true },
  { key: 'node-studio', label: '节点工作台', icon: Wrench, available: true },
  { key: 'discover', label: '发现灵感', icon: Compass, available: false },
  { key: 'templates', label: '模板中心', icon: LayoutGrid, available: false },
  { key: 'assets', label: '资源库', icon: FolderOpen, available: true },
  { key: 'settings', label: '设置', icon: Settings, available: false },
] as const

type WorkspaceTab = '个人' | '团队项目'
type LoadingState = 'loading' | 'ready' | 'error'

export interface WorkspaceProps {
  projectClient?: WorkspaceProjectApi
}

/** Workspace route coordinator; cards, dialogs and presentation live in the workspace domain. */
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
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceProject | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const listControllerRef = useRef<AbortController | null>(null)
  const createControllerRef = useRef<AbortController | null>(null)
  const deleteControllerRef = useRef<AbortController | null>(null)
  const loadedOnceRef = useRef(false)
  const createTriggerRef = useRef<HTMLElement | null>(null)
  const deleteFocusTargetRef = useRef<HTMLElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const loadProjects = useCallback(async () => {
    listControllerRef.current?.abort()
    const controller = new AbortController()
    listControllerRef.current = controller
    if (!loadedOnceRef.current) setLoadingState('loading')
    setRefreshError(null)
    try {
      const listed = await client.list(controller.signal)
      const next = sortProjects(listed.filter((project) =>
        isManagedWorkspaceProjectId(project.id)))
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
      deleteControllerRef.current?.abort()
    }
  }, [loadProjects])

  useEffect(() => {
    if (deleteOpen) return
    const focusTarget = deleteFocusTargetRef.current
    if (!focusTarget) return
    deleteFocusTargetRef.current = null
    const frame = window.requestAnimationFrame(() => {
      if (focusTarget.isConnected) {
        focusTarget.focus()
      } else {
        searchInputRef.current?.focus()
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [deleteOpen])

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
    createTriggerRef.current = globalThis.document.activeElement instanceof HTMLElement
      ? globalThis.document.activeElement
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

  const openDeleteDialog = (
    project: WorkspaceProject,
    trigger: HTMLButtonElement | null,
  ) => {
    if (project.state !== 'ready' || !isManagedWorkspaceProjectId(project.id)) return
    deleteFocusTargetRef.current = trigger
    setDeleteTarget(project)
    setDeleteConfirmation('')
    setDeleteError(null)
    setDeleteOpen(true)
  }

  const closeDeleteDialog = () => {
    if (deleting) return
    setDeleteOpen(false)
    setDeleteConfirmation('')
    setDeleteError(null)
  }

  const deleteProject = async () => {
    const project = deleteTarget
    if (
      !project
      || deleting
      || project.state !== 'ready'
      || !isManagedWorkspaceProjectId(project.id)
      || deleteConfirmation !== project.title
    ) return

    listControllerRef.current?.abort()
    deleteControllerRef.current?.abort()
    const controller = new AbortController()
    deleteControllerRef.current = controller
    setDeleting(true)
    setDeleteError(null)
    try {
      const deletedProjectId = await client.delete(project.id, controller.signal)
      if (controller.signal.aborted) return
      setProjects((current) => current.filter((entry) => entry.id !== deletedProjectId))
      deleteFocusTargetRef.current = searchInputRef.current
      setDeleteOpen(false)
      setDeleteConfirmation('')
      setDeleteError(null)
    } catch (error) {
      if (!controller.signal.aborted) {
        setDeleteError(workspaceProjectErrorMessage(
          error,
          '项目删除失败，请稍后重试。',
        ))
      }
    } finally {
      if (deleteControllerRef.current === controller) {
        deleteControllerRef.current = null
        if (!controller.signal.aborted) setDeleting(false)
      }
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
              aria-current={key === 'workspace' ? 'page' : undefined}
              onClick={() => {
                if (key === 'node-studio') navigate('/node-studio')
                else if (key === 'assets') navigate('/resources')
              }}
              title={available ? undefined : '尚未开放'}
              className={`flex items-center gap-2.5 rounded-[10px] px-3 py-2 text-left text-[13px] ${
                available
                  ? key === 'workspace'
                    ? 'bg-[#EAF1FD] font-medium text-gg-primary'
                    : 'text-gg-muted hover:bg-gg-subtle hover:text-gg-ink'
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
                    ref={searchInputRef}
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
                        onRequestDelete={openDeleteDialog}
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
                          onRequestDelete={openDeleteDialog}
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

      <DeleteProjectDialog
        open={deleteOpen}
        project={deleteTarget}
        confirmation={deleteConfirmation}
        error={deleteError}
        deleting={deleting}
        onOpenChange={(open) => {
          if (!open) closeDeleteDialog()
        }}
        onConfirmationChange={(value) => {
          setDeleteConfirmation(value)
          setDeleteError(null)
        }}
        onConfirm={() => void deleteProject()}
      />
    </div>
  )
}
