import { useEffect, useState } from 'react'
import { ExternalLink, File, FileText, Image as ImageIcon, Loader2, RefreshCw } from 'lucide-react'
import { Link } from 'react-router'
import {
  type ProjectArtifactCatalogApi,
  type ProjectArtifactResource,
} from '@/resources/artifactCatalogClient'
import { generatedContentHref } from '@/resources/resourceRoutes'

interface CanvasWorkbenchResourcesProps {
  api: ProjectArtifactCatalogApi
  projectId?: string
  projectDir: string
  branch: string
}

export default function CanvasWorkbenchResources({
  api,
  projectId,
  projectDir,
  branch,
}: CanvasWorkbenchResourcesProps) {
  const [artifacts, setArtifacts] = useState<ProjectArtifactResource[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    void api.list({
      projectDir,
      branch,
      limit: 24,
      signal: controller.signal,
    }).then(
      (page) => {
        if (controller.signal.aborted) return
        setArtifacts(page.artifacts)
        setStatus('ready')
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setStatus('error')
        setMessage(error instanceof Error ? error.message : '项目资源暂时无法读取')
      },
    )
    return () => controller.abort()
  }, [api, attempt, branch, projectDir])

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-medium text-gg-ink">最近生成内容</p>
          <p className="mt-0.5 text-[9.5px] text-gg-muted">来自已完成运行的可信资源</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setStatus('loading')
            setMessage('')
            setAttempt((value) => value + 1)
          }}
          disabled={status === 'loading'}
          aria-label="刷新项目资源"
          className="flex h-8 w-8 items-center justify-center rounded-[8px] text-gg-muted outline-none hover:bg-gg-subtle hover:text-gg-ink disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-gg-primary/35"
        >
          <RefreshCw size={13} className={status === 'loading' ? 'animate-spin' : ''} aria-hidden="true" />
        </button>
      </div>

      {status === 'loading' && artifacts.length === 0 && (
        <p role="status" className="flex min-h-32 items-center justify-center gap-2 text-[10.5px] text-gg-muted">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" /> 正在读取项目资源…
        </p>
      )}
      {status === 'error' && (
        <div role="alert" className="rounded-[12px] border border-red-200 p-3 text-[10.5px] leading-4 text-red-700">
          <p>{message}</p>
          <button
            type="button"
            onClick={() => {
              setStatus('loading')
              setMessage('')
              setAttempt((value) => value + 1)
            }}
            className="mt-2 text-gg-primary outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35"
          >
            重试
          </button>
        </div>
      )}
      {status === 'ready' && artifacts.length === 0 && (
        <div className="rounded-[12px] border border-dashed border-gg-line px-4 py-7 text-center">
          <LibraryEmptyState />
        </div>
      )}

      <div className="grid grid-cols-2 gap-2" aria-label="最近项目资源">
        {artifacts.map((artifact) => (
          <a
            key={`${artifact.runId}:${artifact.artifactId}`}
            href={api.artifactUrl(projectDir, artifact)}
            target="_blank"
            rel="noreferrer"
            aria-label={`打开资源 ${artifactTitle(artifact)}`}
            className="group overflow-hidden rounded-[11px] border border-gg-line bg-white text-left outline-none hover:border-gg-primary focus-visible:ring-2 focus-visible:ring-gg-primary/35"
          >
            <span className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-gg-bg text-gg-muted">
              {artifact.mediaType.startsWith('image/')
                ? (
                    <img
                      src={api.artifactUrl(projectDir, artifact)}
                      alt=""
                      className="h-full w-full object-cover transition-transform group-hover:scale-[1.02]"
                    />
                  )
                : artifact.mediaType.startsWith('text/')
                  ? <FileText size={22} aria-hidden="true" />
                  : <File size={22} aria-hidden="true" />}
            </span>
            <span className="flex items-center gap-1.5 px-2 py-2">
              {artifact.mediaType.startsWith('image/') && (
                <ImageIcon size={11} className="shrink-0 text-gg-muted" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1 truncate text-[9.5px] text-gg-ink">
                {artifactTitle(artifact)}
              </span>
              <ExternalLink size={10} className="shrink-0 text-gg-muted" aria-hidden="true" />
            </span>
          </a>
        ))}
      </div>

      <div className="rounded-[11px] border border-gg-line p-3 text-[9.5px] leading-4 text-gg-muted">
        工作台只展示 daemon 已验证的生成内容。导入、重新放置与资源删除仍由资源库负责。
      </div>
      {projectId ? (
        <Link
          to={generatedContentHref(projectId, branch)}
          className="flex h-9 w-full items-center justify-center gap-1.5 rounded-[9px] border border-gg-line bg-white text-[10.5px] font-medium text-gg-ink outline-none hover:border-gg-primary hover:text-gg-primary focus-visible:ring-2 focus-visible:ring-gg-primary/35"
        >
          打开完整资源库 <ExternalLink size={11} aria-hidden="true" />
        </Link>
      ) : (
        <p className="text-center text-[9.5px] text-gg-muted">当前项目没有可用于导航的项目标识。</p>
      )}
    </div>
  )
}

function LibraryEmptyState() {
  return (
    <>
      <LibraryIcon />
      <p className="mt-2 text-[10.5px] font-medium text-gg-ink">还没有生成内容</p>
      <p className="mt-1 text-[9.5px] leading-4 text-gg-muted">完成一次 Agent 任务后，资源会出现在这里。</p>
    </>
  )
}

function LibraryIcon() {
  return <File size={20} className="mx-auto text-gg-muted" aria-hidden="true" />
}

function artifactTitle(artifact: ProjectArtifactResource): string {
  const segment = artifact.relativePath.split('/').filter(Boolean).at(-1)
  return segment || artifact.artifactId
}
