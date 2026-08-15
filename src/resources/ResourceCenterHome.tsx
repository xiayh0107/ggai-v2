import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { Link } from 'react-router'
import {
  ArrowLeft,
  Boxes,
  ChevronRight,
  File,
  FolderOpen,
  HardDrive,
  Loader2,
  RefreshCw,
  Server,
  Sparkles,
  WandSparkles,
} from 'lucide-react'
import {
  getPluginRegistryVersion,
  listEnabledPlugins,
  listPlugins,
  subscribePlugins,
} from '@/plugins/types'
import { generatedContentHref } from './resourceRoutes'
import type {
  WorkspaceProject,
  WorkspaceProjectApi,
} from '@/workspace/projectClient'

type ResourceCenterState =
  | { status: 'loading'; projects: WorkspaceProject[] }
  | { status: 'ready'; projects: WorkspaceProject[] }
  | { status: 'error'; projects: WorkspaceProject[] }

export default function ResourceCenterHome({
  client,
}: {
  client: Pick<WorkspaceProjectApi, 'list'>
}) {
  useSyncExternalStore(subscribePlugins, getPluginRegistryVersion, getPluginRegistryVersion)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<ResourceCenterState>({ status: 'loading', projects: [] })

  useEffect(() => {
    const controller = new AbortController()
    void client.list(controller.signal).then(
      (projects) => {
        if (controller.signal.aborted) return
        setState({
          status: 'ready',
          projects: projects
            .filter((project) => project.state === 'ready')
            .sort((left, right) => projectRecency(right) - projectRecency(left)),
        })
      },
      () => {
        if (controller.signal.aborted) return
        setState({ status: 'error', projects: [] })
      },
    )
    return () => controller.abort()
  }, [attempt, client])

  const plugins = listPlugins()
  const enabledPlugins = listEnabledPlugins()

  return (
    <div className="min-h-screen bg-gg-bg text-gg-ink">
      <header className="sticky top-0 z-20 flex h-[58px] items-center gap-3 border-b border-gg-line bg-white px-5">
        <Link
          to="/"
          aria-label="返回工作空间"
          className="flex h-8 w-8 items-center justify-center rounded-[8px] text-gg-muted outline-none hover:bg-gg-subtle hover:text-gg-ink focus-visible:ring-2 focus-visible:ring-gg-primary/35"
        >
          <ArrowLeft size={17} aria-hidden="true" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[14px] font-semibold">资源库</h1>
          <p className="truncate text-[10.5px] text-gg-muted">文件、数据、节点能力与运行环境的统一入口</p>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1180px] px-6 py-7">
        <section>
          <h2 className="text-[20px] font-semibold">资源中心</h2>
          <p className="mt-1 max-w-[720px] text-[12px] leading-5 text-gg-muted">
            管理工作空间中的可复用内容与能力。生成内容按项目保存，移出画布后仍可在这里找到。
          </p>
        </section>

        <ResourceDomainSection title="文件与数据" description="项目内容、外部文件与同步入口">
          <ResourceDomainCard
            icon={FolderOpen}
            title="生成内容"
            description="查看 Agent 在各项目中生成的图像、文本、代码与其他文件。"
            available
            trailing={state.status === 'ready' ? `${state.projects.length} 个项目` : undefined}
          >
            {state.status === 'loading' && (
              <p role="status" className="flex items-center gap-2 text-[11px] text-gg-muted">
                <Loader2 size={13} className="animate-spin" aria-hidden="true" /> 正在读取项目…
              </p>
            )}
            {state.status === 'error' && (
              <div role="alert" className="flex items-center justify-between gap-3 text-[11px] text-gg-muted">
                <span>项目暂时无法读取。</span>
                <button
                  type="button"
                  onClick={() => {
                    setState({ status: 'loading', projects: [] })
                    setAttempt((current) => current + 1)
                  }}
                  className="shrink-0 text-gg-primary outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35"
                >
                  重试
                </button>
              </div>
            )}
            {state.status === 'ready' && state.projects.length === 0 && (
              <p className="text-[11px] leading-5 text-gg-muted">
                还没有可用项目。创建项目并完成生成任务后，内容会出现在这里。
              </p>
            )}
            {state.status === 'ready' && state.projects.length > 0 && (
              <div className="flex flex-wrap gap-2" aria-label="按项目查看生成内容">
                {state.projects.map((project) => (
                  <Link
                    key={project.id}
                    to={generatedContentHref(project.id)}
                    className="flex h-8 max-w-full items-center gap-1.5 rounded-[8px] border border-gg-line bg-white px-2.5 text-[11px] text-gg-ink outline-none hover:border-gg-primary hover:text-gg-primary focus-visible:ring-2 focus-visible:ring-gg-primary/35"
                  >
                    <span className="max-w-[180px] truncate">{project.title}</span>
                    <ChevronRight size={12} className="shrink-0" aria-hidden="true" />
                  </Link>
                ))}
              </div>
            )}
          </ResourceDomainCard>
          <ResourceDomainCard
            icon={File}
            title="项目文件"
            description="统一管理导入到项目的文件与数据。"
          />
          <ResourceDomainCard
            icon={RefreshCw}
            title="同步"
            description="跨设备同步资源与版本快照。"
          />
          <ResourceDomainCard
            icon={HardDrive}
            title="文件系统"
            description="挂载本地目录与外部存储。"
          />
        </ResourceDomainSection>

        <ResourceDomainSection title="节点能力" description="管理可在画布中使用的节点类型">
          <ResourceDomainCard
            icon={WandSparkles}
            title="任务 Skills"
            description="导入和管理可绑定到节点类型与节点实例的专属任务能力。"
            available
            href="/resources/skills"
          />
          <ResourceDomainCard
            icon={Sparkles}
            title="节点工作台"
            description="进入节点工作台，构建、预览并调试可跨项目复用的节点。"
            available
            trailing={`${enabledPlugins.length}/${plugins.length} 已启用`}
            href="/node-studio"
          />
        </ResourceDomainSection>

        <ResourceDomainSection title="计算与部署" description="连接任务执行与发布环境">
          <ResourceDomainCard
            icon={Boxes}
            title="计算集群"
            description="接入集群执行批量生成任务。"
          />
          <ResourceDomainCard
            icon={Server}
            title="服务器"
            description="管理远程服务器与部署目标。"
          />
        </ResourceDomainSection>
      </main>
    </div>
  )
}

function ResourceDomainSection({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section className="mt-8">
      <div className="mb-3">
        <h3 className="text-[14px] font-semibold">{title}</h3>
        <p className="mt-0.5 text-[11px] text-gg-muted">{description}</p>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
        {children}
      </div>
    </section>
  )
}

function ResourceDomainCard({
  icon: Icon,
  title,
  description,
  available = false,
  trailing,
  href,
  children,
}: {
  icon: typeof File
  title: string
  description: string
  available?: boolean
  trailing?: string
  href?: string
  children?: ReactNode
}) {
  const body = (
    <>
      <div className="flex items-start gap-3">
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] ${
          available ? 'bg-gg-subtle text-gg-primary' : 'bg-gg-subtle text-gg-muted'
        }`}>
          <Icon size={17} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-[12.5px] font-medium">{title}</h4>
            {available
              ? trailing && <span className="shrink-0 text-[10.5px] text-gg-muted">{trailing}</span>
              : <span className="shrink-0 rounded-full border border-gg-line px-2 py-0.5 text-[10px] text-gg-muted">规划中</span>}
          </div>
          <p className="mt-1 text-[11px] leading-5 text-gg-muted">{description}</p>
        </div>
      </div>
      {children && <div className="mt-3 border-t border-gg-line pt-3">{children}</div>}
    </>
  )
  const className = `rounded-[14px] border border-gg-line bg-white p-4 ${
    href ? 'outline-none transition-colors hover:border-gg-primary focus-visible:ring-2 focus-visible:ring-gg-primary/35' : ''
  }`
  return href
    ? <Link to={href} className={className}>{body}</Link>
    : <article className={className}>{body}</article>
}

function projectRecency(project: WorkspaceProject): number {
  return Date.parse(project.lastOpenedAt ?? project.updatedAt)
}
