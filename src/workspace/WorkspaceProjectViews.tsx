import { useRef } from 'react'
import { Link } from 'react-router'
import {
  Boxes,
  FolderKanban,
  Layers3,
  ListTodo,
  Loader2,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { WorkspaceProject } from './projectClient'
import { projectHref } from './projectViewModel'

export type ProjectDeleteRequest = (
  project: WorkspaceProject,
  trigger: HTMLButtonElement | null,
) => void

export function ProjectCard({
  project,
  onRequestDelete,
}: {
  project: WorkspaceProject
  onRequestDelete: ProjectDeleteRequest
}) {
  const unavailable = project.state === 'unavailable'
  const className = `group relative overflow-hidden rounded-[14px] border bg-gg-node transition-all duration-150 ${
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
  return (
    <div className={className}>
      <Link to={projectHref(project.id)} className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gg-primary focus-visible:ring-inset">
        {content}
      </Link>
      {canDeleteProject(project) && (
        <ProjectActions project={project} onRequestDelete={onRequestDelete} />
      )}
    </div>
  )
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

export function ProjectRow({
  project,
  divided,
  onRequestDelete,
}: {
  project: WorkspaceProject
  divided: boolean
  onRequestDelete: ProjectDeleteRequest
}) {
  const unavailable = project.state === 'unavailable'
  const className = `flex items-center transition-colors ${
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
    return <div aria-disabled="true" className={`${className} gap-3 px-4 py-3`}>{content}</div>
  }
  return (
    <div className={className}>
      <Link
        to={projectHref(project.id)}
        className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gg-primary focus-visible:ring-inset"
      >
        {content}
      </Link>
      {canDeleteProject(project) && (
        <ProjectActions
          project={project}
          onRequestDelete={onRequestDelete}
          placement="row"
        />
      )}
    </div>
  )
}

function canDeleteProject(project: WorkspaceProject): boolean {
  return project.state === 'ready'
}

function ProjectActions({
  project,
  onRequestDelete,
  placement = 'card',
}: {
  project: WorkspaceProject
  onRequestDelete: ProjectDeleteRequest
  placement?: 'card' | 'row'
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-label={`打开“${project.title}”的项目操作`}
          className={placement === 'card'
            ? 'absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-[8px] border border-gg-line/80 bg-white/90 text-gg-muted shadow-sm hover:bg-white hover:text-gg-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gg-primary'
            : 'mr-3 flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-gg-muted hover:bg-white hover:text-gg-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gg-primary'}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <MoreHorizontal size={16} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[132px] border-gg-line bg-gg-node text-gg-ink"
      >
        <DropdownMenuItem
          variant="destructive"
          className="text-[12px]"
          onSelect={() => onRequestDelete(project, triggerRef.current)}
        >
          <Trash2 size={14} /> 删除项目
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function WorkspaceLoading() {
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

export function WorkspaceError({ message, onRetry }: { message: string; onRetry: () => void }) {
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

export function EmptyPanel({
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
