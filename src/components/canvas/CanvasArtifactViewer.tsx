import { Copy, MessageSquareText, Trash2, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useArtifactText } from '@/canvas/artifactText'
import type { CanvasArtifactViewerRequest } from '@/canvas/artifactViewerContext'
import type { CanvasNode } from '@/canvas/model'
import { MarkdownView } from '@/plugins/markdown'
import { getPlugin } from '@/plugins/types'
import CanvasRightDrawer from './CanvasRightDrawer'

const MAX_VIEWER_TEXT_BYTES = 2 * 1024 * 1024

function formatViewerSize(size: number): string {
  if (size < 1_024) return `${size} B`
  if (size < 1_024 * 1_024) return `${(size / 1_024).toFixed(1)} KB`
  return `${(size / (1_024 * 1_024)).toFixed(1)} MB`
}

/** 专属产物查看：统一走右侧抽屉面板，文本全文渲染 / 代码等宽 / 图片大图 / 文件外链。 */
export default function CanvasArtifactViewer({
  request,
  node,
  controlsLocked = false,
  nodeActions = [],
  onToggleNodeMark,
  onNodeAction,
  onFocusComposer,
  onDuplicate,
  onDelete,
  onClose,
}: {
  request: CanvasArtifactViewerRequest
  /** 产物来源节点：面板工具条完整同步该节点的浮动工具条，正文套用其格式标记。 */
  node?: CanvasNode
  /** 所属 Task 仍持有控制权时，查看器只展示产物，不暴露第二套节点操作。 */
  controlsLocked?: boolean
  nodeActions?: string[]
  onToggleNodeMark?: (markId: string) => void
  onNodeAction?: (prompt: string) => void
  onFocusComposer?: () => void
  onDuplicate?: () => void
  onDelete?: () => void
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const { artifact, title } = request
  const marks = node ? getPlugin(node.type).instr.marksFor?.(node) ?? [] : []
  // 与选择工具条同一规则：有标记按钮的类型（文本）不再重复显示指令 chips。
  const showActions = marks.length === 0 && nodeActions.length > 0 && Boolean(onNodeAction)

  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  return (
    <CanvasRightDrawer
      ariaLabel={`产物查看：${title}`}
      testId="canvas-artifact-viewer"
      onClose={onClose}
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-gg-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-gg-ink">{title}</p>
          <p className="mt-0.5 truncate text-[10.5px] text-gg-muted">
            {artifact.mediaType} · {formatViewerSize(artifact.size)}
          </p>
        </div>
        <a
          href={artifact.url}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 rounded-[8px] px-2.5 py-1.5 text-[11px] text-gg-primary outline-none hover:bg-gg-subtle focus-visible:ring-2 focus-visible:ring-gg-primary/35"
        >
          在新标签页打开
        </a>
        <button
          ref={closeRef}
          type="button"
          aria-label="关闭产物查看面板"
          onClick={onClose}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-gg-muted outline-none hover:bg-gg-subtle hover:text-gg-ink focus-visible:ring-2 focus-visible:ring-gg-primary/35"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      {node && !controlsLocked && (
        <div
          role="group"
          aria-label="节点工具条"
          data-testid="canvas-viewer-toolbar"
          className="flex shrink-0 flex-wrap items-center gap-1 border-b border-gg-line bg-white px-4 py-2"
        >
          {onFocusComposer && (
            <button
              type="button"
              aria-label="打开节点提示词控件"
              title="打开节点提示词控件"
              onClick={onFocusComposer}
              className="flex h-7 w-7 items-center justify-center rounded-[8px] bg-gg-subtle text-gg-primary outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35"
            >
              <MessageSquareText size={14} aria-hidden="true" />
            </button>
          )}
          {marks.length > 0 && onToggleNodeMark && (
            <>
              <span className="mx-0.5 h-4 w-px bg-gg-line" aria-hidden="true" />
              {marks.map((mark) => {
                const MarkIcon = mark.icon
                return (
                  <button
                    key={mark.id}
                    type="button"
                    title={mark.title}
                    aria-label={mark.title}
                    aria-pressed={mark.active}
                    data-node-mark={mark.id}
                    onClick={() => onToggleNodeMark(mark.id)}
                    className={`flex h-7 w-7 items-center justify-center rounded-[8px] outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35 ${
                      mark.active
                        ? 'bg-gg-subtle text-gg-primary'
                        : 'text-gg-ink hover:bg-gg-subtle'
                    }`}
                  >
                    <MarkIcon size={14} aria-hidden="true" />
                  </button>
                )
              })}
            </>
          )}
          {showActions && (
            <>
              <span className="mx-0.5 h-4 w-px bg-gg-line" aria-hidden="true" />
              {nodeActions.slice(0, 5).map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  title="填入提示词，不会自动运行"
                  onClick={() => onNodeAction?.(prompt)}
                  className="flex h-7 items-center rounded-[8px] px-2 text-[11px] text-gg-ink outline-none hover:bg-gg-subtle hover:text-gg-primary focus-visible:ring-2 focus-visible:ring-gg-primary/35"
                >
                  {prompt}
                </button>
              ))}
            </>
          )}
          {onDuplicate && (
            <button
              type="button"
              aria-label="复制所选节点"
              title="复制节点"
              onClick={onDuplicate}
              className="flex h-7 w-7 items-center justify-center rounded-[8px] text-gg-ink outline-none hover:bg-gg-subtle focus-visible:ring-2 focus-visible:ring-gg-primary/35"
            >
              <Copy size={14} aria-hidden="true" />
            </button>
          )}
          {onDelete && (
            <>
              <span className="mx-0.5 h-4 w-px bg-gg-line" aria-hidden="true" />
              <button
                type="button"
                aria-label="从画布移除所选节点"
                title="从画布移除"
                onClick={onDelete}
                className="flex h-7 w-7 items-center justify-center rounded-[8px] text-gg-muted outline-none hover:bg-gg-subtle hover:text-gg-danger focus-visible:ring-2 focus-visible:ring-gg-primary/35"
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto bg-gg-subtle">
        <CanvasArtifactViewerBody request={request} node={node} />
      </div>
    </CanvasRightDrawer>
  )
}

function CanvasArtifactViewerBody({
  request,
  node,
}: {
  request: CanvasArtifactViewerRequest
  node?: CanvasNode
}) {
  const { artifact, kind, title } = request
  // 非文本类产物不抓取内容（maxBytes 0 → 直接 too-large，不发请求）。
  const text = useArtifactText(
    artifact,
    kind === 'text' || kind === 'code' ? MAX_VIEWER_TEXT_BYTES : 0,
  )

  if (kind === 'image') {
    return (
      <div className="flex min-h-full items-center justify-center p-4">
        <img
          src={artifact.url}
          alt={title}
          className="max-h-full max-w-full rounded-[10px] bg-white object-contain"
          draggable={false}
        />
      </div>
    )
  }
  if (kind === 'file') {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-[12px] text-gg-muted">该类型暂不支持内联查看</p>
        <a
          href={artifact.url}
          target="_blank"
          rel="noreferrer"
          className="rounded-[8px] bg-white px-3 py-1.5 text-[11.5px] text-gg-primary outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35"
        >
          在新标签页打开
        </a>
      </div>
    )
  }
  if (text.status !== 'ready') {
    const message = text.status === 'too-large'
      ? '产物过大，请在新标签页打开查看'
      : text.status === 'error'
        ? '产物内容暂时无法读取'
        : '正在读取产物…'
    return (
      <div role="status" className="flex min-h-full items-center justify-center p-8 text-[12px] text-gg-muted">
        {message}
      </div>
    )
  }
  if (kind === 'text') {
    // 与节点内联视图一致：工具条的格式标记（粗体 / 斜体 / 标题）在查看面板正文同样生效。
    const payload = node?.payload ?? {}
    const textCls = payload.heading === 1
      ? 'text-[19px] font-semibold'
      : payload.heading === 2
        ? 'text-[16px] font-semibold'
        : 'text-[13px]'
    const textStyle: React.CSSProperties = {
      fontWeight: payload.bold === true ? 600 : undefined,
      fontStyle: payload.italic === true ? 'italic' : undefined,
    }
    return (
      <div className="p-5">
        <MarkdownView text={text.text ?? ''} className={textCls} style={textStyle} />
      </div>
    )
  }
  return (
    <pre className="min-h-full whitespace-pre bg-[#0F172A] p-5 font-mono text-[11.5px] leading-5 text-[#E2E8F0]">
      {text.text}
    </pre>
  )
}
