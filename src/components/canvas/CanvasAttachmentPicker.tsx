import { File, Image, Loader2, X } from 'lucide-react'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { createPortal } from 'react-dom'
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

interface FloatingPosition {
  left: number
  top: number
}

const VIEWPORT_MARGIN = 16
const TRIGGER_GAP = 8

/**
 * Project-scoped resource chooser. It owns catalog loading, limits, resource
 * identity and a viewport-aware portal so Canvas shells cannot clip it.
 */
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
  const [position, setPosition] = useState<FloatingPosition | null>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLElement | null>(null)

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

  useLayoutEffect(() => {
    const picker = pickerRef.current
    if (!picker) return
    triggerRef.current = findExpandedAttachmentTrigger()

    const updatePosition = () => {
      const popup = pickerRef.current
      if (!popup) return
      const trigger = triggerRef.current ?? findExpandedAttachmentTrigger()
      triggerRef.current = trigger
      const width = popup.offsetWidth
      const height = popup.offsetHeight
      const viewportWidth = globalThis.innerWidth
      const viewportHeight = globalThis.innerHeight

      if (!trigger) {
        setPosition({
          left: Math.max(VIEWPORT_MARGIN, Math.round((viewportWidth - width) / 2)),
          top: Math.max(VIEWPORT_MARGIN, Math.round((viewportHeight - height) / 2)),
        })
        return
      }

      const rect = trigger.getBoundingClientRect()
      const availableAbove = rect.top - VIEWPORT_MARGIN - TRIGGER_GAP
      const availableBelow = viewportHeight - rect.bottom - VIEWPORT_MARGIN - TRIGGER_GAP
      const placeAbove = availableAbove >= height || availableAbove >= availableBelow
      const preferredTop = placeAbove
        ? rect.top - TRIGGER_GAP - height
        : rect.bottom + TRIGGER_GAP
      const maxTop = Math.max(VIEWPORT_MARGIN, viewportHeight - VIEWPORT_MARGIN - height)
      const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - VIEWPORT_MARGIN - width)
      setPosition({
        left: clamp(rect.left, VIEWPORT_MARGIN, maxLeft),
        top: clamp(preferredTop, VIEWPORT_MARGIN, maxTop),
      })
    }

    updatePosition()
    const frame = requestAnimationFrame(updatePosition)
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(updatePosition)
    resizeObserver?.observe(picker)
    globalThis.addEventListener('resize', updatePosition)
    globalThis.addEventListener('scroll', updatePosition, true)
    return () => {
      cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
      globalThis.removeEventListener('resize', updatePosition)
      globalThis.removeEventListener('scroll', updatePosition, true)
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
      triggerRef.current?.focus()
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (pickerRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [onClose])

  const selectedKeys = new Set(selected.map(artifactKey))
  const style: CSSProperties = position
    ? { left: position.left, top: position.top }
    : { left: VIEWPORT_MARGIN, top: VIEWPORT_MARGIN, visibility: 'hidden' }

  return createPortal(
    <div
      ref={pickerRef}
      role="dialog"
      aria-label="添加附件"
      style={style}
      className="fixed z-[100] w-[min(360px,calc(100vw-48px))] rounded-[14px] border border-gg-line bg-white p-2.5 shadow-float"
    >
      <div className="mb-2 flex items-start justify-between gap-3 px-1">
        <div>
          <p className="text-[11px] font-semibold text-gg-ink">添加附件</p>
          <p className="text-[9.5px] text-gg-muted">从资源库的生成内容中选择 · 最多 12 个</p>
        </div>
        <button
          type="button"
          aria-label="关闭附件选择"
          onClick={() => {
            onClose()
            triggerRef.current?.focus()
          }}
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
    </div>,
    document.body,
  )
}

export function AttachmentTypeIcon({ mediaType, size }: { mediaType: string; size: number }) {
  return mediaType.startsWith('image/')
    ? <Image size={size} aria-hidden="true" />
    : <File size={size} aria-hidden="true" />
}

function findExpandedAttachmentTrigger(): HTMLElement | null {
  const active = document.activeElement
  if (active instanceof HTMLElement
    && active.matches('[aria-haspopup="dialog"][aria-expanded="true"]')) {
    return active
  }
  return [...document.querySelectorAll<HTMLElement>(
    '[aria-haspopup="dialog"][aria-expanded="true"]',
  )].find((element) => element.getClientRects().length > 0) ?? null
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

function formatBytes(size: number): string {
  if (size < 1_024) return `${size} B`
  if (size < 1_024 * 1_024) return `${Math.round(size / 1_024)} KB`
  return `${(size / (1_024 * 1_024)).toFixed(1)} MB`
}
