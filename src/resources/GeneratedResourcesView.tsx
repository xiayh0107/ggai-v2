import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import {
  ArrowLeft,
  ExternalLink,
  File,
  FileCode2,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Search,
} from 'lucide-react'
import {
  artifactViewerKindForMediaType,
  type CanvasArtifactViewerRequest,
} from '@/canvas/artifactViewerContext'
import CanvasArtifactViewer from '@/components/canvas/CanvasArtifactViewer'
import type {
  ProjectArtifactCatalogApi,
  ProjectArtifactResource,
} from './artifactCatalogClient'
import { resourceCanvasHref } from './resourceRoutes'
import type { WorkspaceProject } from '@/workspace/projectClient'

type ResourceFilter = 'all' | 'image' | 'text' | 'file'

const FILTERS: Array<{ id: ResourceFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'image', label: '图像' },
  { id: 'text', label: '文本与代码' },
  { id: 'file', label: '其他文件' },
]

const RESOURCE_CATALOG_PAGE_SIZE = 60

export default function GeneratedResourcesView({
  project,
  api,
  branch,
}: {
  project: WorkspaceProject
  api: ProjectArtifactCatalogApi
  branch?: string
}) {
  const [artifacts, setArtifacts] = useState<ProjectArtifactResource[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState<string | null>(null)
  const [partial, setPartial] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ResourceFilter>('all')
  const [refreshKey, setRefreshKey] = useState(0)
  const [viewer, setViewer] = useState<CanvasArtifactViewerRequest | null>(null)
  const loadMoreControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    loadMoreControllerRef.current?.abort()
    loadMoreControllerRef.current = null
    const controller = new AbortController()
    setLoadingMore(false)
    setLoadMoreError(null)
    setNextCursor(null)
    void api.list({
      projectDir: project.projectDir,
      ...(branch ? { branch } : {}),
      limit: RESOURCE_CATALOG_PAGE_SIZE,
      signal: controller.signal,
    }).then(
      (page) => {
        if (controller.signal.aborted) return
        setArtifacts(page.artifacts)
        setPartial(page.partial)
        setTruncated(page.truncated)
        setNextCursor(page.nextCursor)
        setStatus('ready')
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setMessage(error instanceof Error ? error.message : '资源列表暂时无法加载。')
        setStatus('error')
      },
    )
    return () => {
      controller.abort()
      loadMoreControllerRef.current?.abort()
    }
  }, [api, branch, project.projectDir, refreshKey])

  const refresh = () => {
    loadMoreControllerRef.current?.abort()
    loadMoreControllerRef.current = null
    setStatus('loading')
    setMessage(null)
    setLoadMoreError(null)
    setLoadingMore(false)
    setRefreshKey((value) => value + 1)
  }

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return
    loadMoreControllerRef.current?.abort()
    const controller = new AbortController()
    loadMoreControllerRef.current = controller
    setLoadingMore(true)
    setLoadMoreError(null)
    try {
      const page = await api.list({
        projectDir: project.projectDir,
        ...(branch ? { branch } : {}),
        limit: RESOURCE_CATALOG_PAGE_SIZE,
        cursor: nextCursor,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      setArtifacts((current) => mergeArtifactPages(current, page.artifacts))
      setPartial((current) => current || page.partial)
      setTruncated(page.truncated)
      setNextCursor(page.nextCursor)
    } catch (error) {
      if (controller.signal.aborted) return
      setLoadMoreError(error instanceof Error ? error.message : '更多资源暂时无法加载。')
    } finally {
      if (loadMoreControllerRef.current === controller) {
        loadMoreControllerRef.current = null
        if (!controller.signal.aborted) setLoadingMore(false)
      }
    }
  }

  const visibleArtifacts = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN')
    return artifacts.filter((artifact) => {
      if (filter !== 'all' && resourceKind(artifact.mediaType) !== filter) return false
      if (!normalized) return true
      return artifact.relativePath.toLocaleLowerCase('zh-CN').includes(normalized)
        || artifact.mediaType.toLocaleLowerCase('zh-CN').includes(normalized)
    })
  }, [artifacts, filter, query])

  const openArtifact = (artifact: ProjectArtifactResource) => {
    const title = artifactTitle(artifact)
    setViewer({
      title,
      kind: artifactViewerKindForMediaType(artifact.mediaType),
      artifact: {
        runId: artifact.runId,
        artifactId: artifact.artifactId,
        mediaType: artifact.mediaType,
        size: artifact.size,
        contentDigest: artifact.contentDigest,
        title,
        url: api.artifactUrl(project.projectDir, artifact),
      },
    })
  }

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
          <h1 className="truncate text-[14px] font-semibold">生成内容</h1>
          <p className="truncate text-[10.5px] text-gg-muted">
            资源库 · {project.title}{branch ? ` · ${branch}` : ''}
          </p>
        </div>
        <Link
          to="/resources"
          className="rounded-[9px] border border-gg-line bg-white px-3 py-1.5 text-[11.5px] text-gg-ink outline-none hover:bg-gg-subtle focus-visible:ring-2 focus-visible:ring-gg-primary/35"
        >
          资源中心
        </Link>
        <Link
          to={resourceCanvasHref(project.id, branch)}
          className="rounded-[9px] border border-gg-line bg-white px-3 py-1.5 text-[11.5px] text-gg-ink outline-none hover:bg-gg-subtle focus-visible:ring-2 focus-visible:ring-gg-primary/35"
        >
          返回画布
        </Link>
      </header>

      <main className="mx-auto w-full max-w-[1440px] px-6 py-6">
        <section className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-[20px] font-semibold">项目生成内容</h2>
            <p className="mt-1 max-w-[680px] text-[12px] leading-5 text-gg-muted">
              从画布移除节点只会移除画布上的引用。Agent 已生成的文件会继续保留在这里，可随时查看和下载。
            </p>
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={status === 'loading'}
            className="flex h-9 items-center gap-2 rounded-[9px] border border-gg-line bg-white px-3 text-[11.5px] outline-none hover:bg-gg-subtle disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-gg-primary/35"
          >
            {status === 'loading'
              ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              : <RefreshCw size={14} aria-hidden="true" />}
            刷新
          </button>
        </section>

        <section className="mb-5 flex flex-wrap items-center gap-3 rounded-[14px] border border-gg-line bg-white p-3">
          <label className="flex h-9 min-w-[240px] flex-1 items-center gap-2 rounded-[9px] border border-gg-line px-3 focus-within:ring-2 focus-within:ring-gg-primary/20">
            <Search size={14} className="text-gg-muted" aria-hidden="true" />
            <span className="sr-only">搜索资源</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索文件名或类型…"
              className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-gg-muted"
            />
          </label>
          <div role="group" aria-label="资源类型" className="flex flex-wrap gap-1">
            {FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
                className={`h-8 rounded-[8px] px-3 text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35 ${
                  filter === item.id
                    ? 'bg-gg-subtle font-medium text-gg-primary'
                    : 'text-gg-muted hover:bg-gg-subtle hover:text-gg-ink'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </section>

        {(partial || truncated) && (
          <div role="status" className="mb-4 rounded-[10px] border border-gg-line bg-white px-3 py-2 text-[11px] text-gg-muted">
            {partial && '部分资源不完整或未通过完整性检查；其余资源已正常显示。'}
            {partial && truncated && ' '}
            {truncated && '还有更多较早资源，可继续加载。'}
          </div>
        )}

        {status === 'loading' && artifacts.length === 0 && (
          <div role="status" className="flex min-h-[300px] items-center justify-center gap-2 text-[12px] text-gg-muted">
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            正在读取项目资源…
          </div>
        )}
        {status === 'error' && (
          <div role="alert" className="flex min-h-[300px] flex-col items-center justify-center gap-3 rounded-[16px] border border-gg-line bg-white p-8 text-center">
            <p className="text-[12px] text-gg-muted">{message}</p>
            <button
              type="button"
              onClick={refresh}
              className="rounded-[8px] bg-gg-subtle px-3 py-1.5 text-[11.5px] text-gg-primary"
            >
              重新加载
            </button>
          </div>
        )}
        {status === 'ready' && visibleArtifacts.length === 0 && (
          <div className="flex min-h-[300px] flex-col items-center justify-center rounded-[16px] border border-dashed border-gg-line bg-white p-8 text-center">
            <File size={24} className="mb-3 text-gg-muted" aria-hidden="true" />
            <p className="text-[13px] font-medium">{artifacts.length === 0 ? '还没有项目资源' : '没有匹配的资源'}</p>
            <p className="mt-1 text-[11px] leading-5 text-gg-muted">
              {artifacts.length === 0
                ? 'Agent 完成任务并生成文件后，资源会自动进入这里。'
                : '可以清空搜索词或切换资源类型。'}
            </p>
          </div>
        )}
        {visibleArtifacts.length > 0 && (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
            {visibleArtifacts.map((artifact) => {
              const title = artifactTitle(artifact)
              const url = api.artifactUrl(project.projectDir, artifact)
              return (
                <li
                  key={`${artifact.runId}:${artifact.artifactId}`}
                  className="group overflow-hidden rounded-[14px] border border-gg-line bg-white shadow-sm transition-shadow hover:shadow-float"
                >
                  <button
                    type="button"
                    aria-label={`预览 ${title}`}
                    onClick={() => openArtifact(artifact)}
                    className="block h-[150px] w-full overflow-hidden bg-gg-subtle outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gg-primary/35"
                  >
                    {artifact.mediaType.startsWith('image/') ? (
                      <img
                        src={url}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <span className="flex h-full flex-col items-center justify-center gap-2 text-gg-muted">
                        {resourceKind(artifact.mediaType) === 'text'
                          ? <FileCode2 size={26} aria-hidden="true" />
                          : <File size={26} aria-hidden="true" />}
                        <span className="max-w-[180px] truncate text-[10.5px]">{artifact.mediaType}</span>
                      </span>
                    )}
                  </button>
                  <div className="p-3">
                    <div className="flex items-start gap-2">
                      <span className="mt-0.5 text-gg-muted">
                        {artifact.mediaType.startsWith('image/')
                          ? <ImageIcon size={14} aria-hidden="true" />
                          : <File size={14} aria-hidden="true" />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <button
                          type="button"
                          title={artifact.relativePath}
                          onClick={() => openArtifact(artifact)}
                          className="block w-full truncate text-left text-[12px] font-medium outline-none hover:text-gg-primary focus-visible:text-gg-primary"
                        >
                          {title}
                        </button>
                        <p className="mt-1 truncate text-[10.5px] text-gg-muted">
                          {formatSize(artifact.size)} · 生成于 {formatDate(artifact.createdAt)}
                        </p>
                      </div>
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`在新标签页打开 ${title}`}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-gg-muted outline-none hover:bg-gg-subtle hover:text-gg-primary focus-visible:ring-2 focus-visible:ring-gg-primary/35"
                      >
                        <ExternalLink size={13} aria-hidden="true" />
                      </a>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        {(nextCursor || loadMoreError) && status !== 'error' && (
          <div className="mt-5 flex flex-col items-center gap-2">
            {loadMoreError && (
              <p role="alert" className="text-[11px] text-gg-danger">{loadMoreError}</p>
            )}
            {nextCursor && (
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="flex h-9 items-center gap-2 rounded-[9px] border border-gg-line bg-white px-4 text-[11.5px] text-gg-ink outline-none hover:bg-gg-subtle disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-gg-primary/35"
              >
                {loadingMore && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                {loadingMore ? '正在加载…' : loadMoreError ? '重试加载更多' : '加载更多'}
              </button>
            )}
          </div>
        )}
      </main>

      {viewer && <CanvasArtifactViewer request={viewer} onClose={() => setViewer(null)} />}
    </div>
  )
}

function resourceKind(mediaType: string): Exclude<ResourceFilter, 'all'> {
  if (mediaType.startsWith('image/')) return 'image'
  if (mediaType.startsWith('text/')
    || /^(?:application)\/(?:json|xml|javascript|typescript|x-yaml|yaml|toml|sql)$/u
      .test(mediaType)) return 'text'
  return 'file'
}

function artifactTitle(artifact: ProjectArtifactResource): string {
  return artifact.relativePath.split('/').at(-1) ?? artifact.relativePath
}

function mergeArtifactPages(
  current: ProjectArtifactResource[],
  next: ProjectArtifactResource[],
): ProjectArtifactResource[] {
  const seen = new Set(current.map((artifact) => `${artifact.runId}\0${artifact.artifactId}`))
  return [
    ...current,
    ...next.filter((artifact) => {
      const key = `${artifact.runId}\0${artifact.artifactId}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }),
  ]
}

function formatSize(size: number): string {
  if (size < 1_024) return `${size} B`
  if (size < 1_024 * 1_024) return `${(size / 1_024).toFixed(1)} KB`
  return `${(size / (1_024 * 1_024)).toFixed(1)} MB`
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestamp))
}
