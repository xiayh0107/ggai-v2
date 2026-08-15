import { File, Image, Loader2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type {
  ProjectArtifactCatalogApi,
  ProjectArtifactResource,
} from '@/resources/artifactCatalogClient'
import {
  artifactKey,
  artifactTitle,
  MAX_COMPOSER_ATTACHMENTS,
} from '@/canvas/attachments'

export interface CanvasAttachmentPickerProps {
  api: Pick<ProjectArtifactCatalogApi, 'list'>
  projectDir: string
  branch: string
  selected: ProjectArtifactResource[]
  onChange: (attachments: ProjectArtifactResource[]) => void
  onClose: () => void
}

/** Project-scoped resource chooser. It owns catalog loading, limits, and resource identity. */
export default function CanvasAttachmentPicker({
  api,
  projectDir,
  branch,
  selected,
  onChange,
  onClose,
}: CanvasAttachmentPickerProps) {
  const [resources, setResources] = useState<ProjectArtifactResource[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void api.list({ projectDir, branch, limit: 60, signal: controller.signal }).then(
      (page) => {
        setResources(page.artifacts)
        setLoading(false)
      },
      (cause) => {
        if (controller.signal.aborted) return
        setLoadError(cause instanceof Error ? cause.message : '资源加载失败')
        setLoading(false)
      },
    )
    return () => controller.abort()
  }, [api, branch, projectDir])

  const selectedKeys = new Set(selected.map(artifactKey))
  return (
    <div
      role="dialog"
      aria-label="添加附件"
      className="absolute bottom-[calc(100%+8px)] left-0 z-50 w-[min(360px,calc(100vw-48px))] rounded-[14px] border border-gg-line bg-white p-2.5 shadow-float"
    >
      <div className="mb-2 flex items-start justify-between gap-3 px-1">
        <div>
          <p className="text-[11px] font-semibold text-gg-ink">添加附件</p>
          <p className="text-[9.5px] text-gg-muted">从资源库的生成内容中选择 · 最多 12 个</p>
        </div>
        <button
          type="button"
          aria-label="关闭附件选择"
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded-[7px] text-gg-muted outline-none hover:bg-gg-subtle focus-visible:ring-2 focus-visible:ring-gg-primary/30"
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>
      <div className="max-h-52 space-y-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center gap-2 px-2 py-5 text-[10.5px] text-gg-muted">
            <Loader2 size={13} className="animate-spin motion-reduce:animate-none" />
            正在读取生成内容…
          </div>
        )}
        {!loading && loadError && (
          <p role="alert" className="px-2 py-4 text-[10.5px] text-[#B42318]">{loadError}</p>
        )}
        {!loading && !loadError && resources.length === 0 && (
          <p className="px-2 py-5 text-[10.5px] text-gg-muted">当前分支还没有可用的生成内容</p>
        )}
        {!loading && resources.map((resource) => {
          const key = artifactKey(resource)
          const checked = selectedKeys.has(key)
          const limitReached = !checked && selected.length >= MAX_COMPOSER_ATTACHMENTS
          return (
            <button
              key={key}
              type="button"
              role="checkbox"
              aria-checked={checked}
              disabled={limitReached}
              onClick={() => onChange(checked
                ? selected.filter((candidate) => artifactKey(candidate) !== key)
                : [...selected, resource])}
              className={`flex w-full items-center gap-2 rounded-[9px] px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/30 disabled:opacity-40 ${
                checked ? 'bg-[#EAF1FD]' : 'hover:bg-gg-subtle'
              }`}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-white text-gg-muted">
                <AttachmentTypeIcon mediaType={resource.mediaType} size={14} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[10.5px] font-medium text-gg-ink">
                  {artifactTitle(resource)}
                </span>
                <span className="block truncate text-[9px] text-gg-muted">
                  {resource.mediaType} · {formatBytes(resource.size)}
                </span>
              </span>
              <span className={`h-4 w-4 shrink-0 rounded-full border ${
                checked
                  ? 'border-gg-primary bg-gg-primary shadow-[inset_0_0_0_3px_white]'
                  : 'border-gg-line'
              }`} aria-hidden="true" />
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function AttachmentTypeIcon({ mediaType, size }: { mediaType: string; size: number }) {
  return mediaType.startsWith('image/')
    ? <Image size={size} aria-hidden="true" />
    : <File size={size} aria-hidden="true" />
}

function formatBytes(size: number): string {
  if (size < 1_024) return `${size} B`
  if (size < 1_024 * 1_024) return `${Math.round(size / 1_024)} KB`
  return `${(size / (1_024 * 1_024)).toFixed(1)} MB`
}
