import { ExternalLink, Eye, File as FileIcon } from 'lucide-react'
import type { CSSProperties } from 'react'
import { useArtifactText } from '@/canvas/artifactText'
import { useOpenCanvasArtifactViewer } from '@/canvas/artifactViewerContext'
import { MarkdownView } from '@/plugins/markdown'
import type {
  NodeArtifactViewProps,
  TrustedArtifactProjection,
} from './types'
import type { NodeContentTemplate } from './uiContracts'

const MAX_INLINE_CONTENT_BYTES = 1 * 1024 * 1024

export interface NodeArtifactTemplateViewProps extends NodeArtifactViewProps {
  template: NodeContentTemplate
}

/** Platform-owned artifact renderer selected by the same finite Node UI template. */
export default function NodeArtifactTemplateView({
  template,
  artifact,
  content,
  node,
}: NodeArtifactTemplateViewProps) {
  if (template === 'media' && artifact.mediaType.startsWith('image/')) {
    return <ImageArtifact artifact={artifact} content={content} node={node} />
  }
  if (template === 'document' && artifact.mediaType.startsWith('text/')) {
    return <TextArtifact artifact={artifact} content={content} node={node} />
  }
  if (template === 'code' && isTextLikeArtifact(artifact)) {
    return <CodeArtifact artifact={artifact} content={content} node={node} />
  }
  return <FileArtifact artifact={artifact} content={content} node={node} />
}

function FileArtifact({ artifact, content, node }: NodeArtifactViewProps) {
  const openViewer = useOpenCanvasArtifactViewer()
  const title = content.title ?? artifact.title
  const actionClassName = 'inline-flex items-center gap-1 rounded-[7px] border border-gg-line bg-white px-2.5 py-1.5 text-[10.5px] text-gg-primary outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35'
  return (
    <div data-node-artifact-template="file" className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-4 text-center">
      <FileIcon size={30} className="text-gg-muted" strokeWidth={1.35} aria-hidden="true" />
      <div className="min-w-0 max-w-full">
        <p className="truncate text-[12px] font-medium text-gg-ink">{title}</p>
        <p className="mt-1 text-[10.5px] text-gg-muted">
          {artifact.mediaType} · {formatArtifactSize(artifact.size)}
        </p>
      </div>
      {openViewer ? (
        <button
          type="button"
          data-no-drag
          onClick={() => openViewer({ artifact, kind: 'file', title, nodeId: node?.id })}
          className={actionClassName}
        >
          <Eye size={11} aria-hidden="true" />
          打开产物
        </button>
      ) : (
        <a href={artifact.url} target="_blank" rel="noreferrer" data-no-drag className={actionClassName}>
          <ExternalLink size={11} aria-hidden="true" />
          打开产物
        </a>
      )}
    </div>
  )
}

function ImageArtifact({ artifact, content, node }: NodeArtifactViewProps) {
  const openViewer = useOpenCanvasArtifactViewer()
  const title = content.title ?? artifact.title
  const image = (
    <img
      src={artifact.url}
      alt={title}
      className="h-full min-h-0 w-full object-contain"
      draggable={false}
      data-no-drag
    />
  )
  if (!openViewer) return <div data-node-artifact-template="image" className="h-full">{image}</div>
  return (
    <button
      type="button"
      data-node-artifact-template="image"
      title="打开产物查看面板"
      aria-label={`打开产物${title}`}
      data-no-drag
      onClick={() => openViewer({ artifact, kind: 'image', title, nodeId: node?.id })}
      className="block h-full min-h-0 w-full cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35"
    >
      {image}
    </button>
  )
}

function CodeArtifact({ artifact, content, node }: NodeArtifactViewProps) {
  const current = useArtifactText(artifact, MAX_INLINE_CONTENT_BYTES)
  return (
    <div data-node-artifact-template="code" className="flex h-full min-h-0 flex-col overflow-hidden">
      {current.status === 'ready' ? (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre p-3 font-mono text-[11.5px] leading-5 text-gg-ink">
          {current.text}
        </pre>
      ) : <ArtifactReadStatus status={current.status} kind="代码" />}
      <ArtifactFooter artifact={artifact} content={content} node={node} viewerKind="code" />
    </div>
  )
}

function TextArtifact({ artifact, content, node }: NodeArtifactViewProps) {
  const current = useArtifactText(artifact, MAX_INLINE_CONTENT_BYTES)
  const payload = node?.payload ?? {}
  const sizeClass = payload.heading === 1
    ? 'text-[19px] font-semibold'
    : payload.heading === 2
      ? 'text-[16px] font-semibold'
      : 'text-[12.5px]'
  const style: CSSProperties = {
    fontWeight: payload.bold === true ? 600 : undefined,
    fontStyle: payload.italic === true ? 'italic' : undefined,
  }
  return (
    <div data-node-artifact-template="text" className="flex h-full min-h-0 flex-col overflow-hidden">
      {current.status === 'ready' ? (
        <div data-no-drag className="min-h-0 flex-1 cursor-text select-text overflow-auto p-3">
          <MarkdownView text={current.text ?? ''} className={sizeClass} style={style} />
        </div>
      ) : <ArtifactReadStatus status={current.status} kind="文本" />}
      <ArtifactFooter artifact={artifact} content={content} node={node} viewerKind="text" />
    </div>
  )
}

function ArtifactReadStatus({
  status,
  kind,
}: {
  status: 'loading' | 'ready' | 'too-large' | 'error'
  kind: '文本' | '代码'
}) {
  const message = status === 'too-large'
    ? `${kind}过大，请打开产物查看`
    : status === 'error'
      ? `${kind}内容暂时无法读取`
      : `正在读取${kind}…`
  return (
    <div role="status" className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-[11px] text-gg-muted">
      {message}
    </div>
  )
}

function ArtifactFooter({
  artifact,
  content,
  node,
  viewerKind,
}: NodeArtifactViewProps & { viewerKind: 'text' | 'code' }) {
  const openViewer = useOpenCanvasArtifactViewer()
  const title = content.title ?? artifact.title
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-t border-gg-line bg-white px-3 py-2 text-[10px] text-gg-muted">
      <span className="min-w-0 truncate">{title}</span>
      {openViewer ? (
        <button
          type="button"
          data-no-drag
          onClick={() => openViewer({ artifact, kind: viewerKind, title, nodeId: node?.id })}
          className="shrink-0 rounded-[5px] px-1 text-gg-primary outline-none hover:bg-gg-subtle focus-visible:ring-2 focus-visible:ring-gg-primary/35"
        >
          打开产物
        </button>
      ) : (
        <a href={artifact.url} target="_blank" rel="noreferrer" data-no-drag className="shrink-0 text-gg-primary outline-none focus-visible:ring-2 focus-visible:ring-gg-primary/35">
          打开产物
        </a>
      )}
    </div>
  )
}

function isTextLikeArtifact(artifact: TrustedArtifactProjection): boolean {
  return artifact.mediaType.startsWith('text/')
    || artifact.title.toLowerCase().endsWith('.json')
    || artifact.title.toLowerCase().endsWith('.js')
    || artifact.title.toLowerCase().endsWith('.ts')
    || artifact.title.toLowerCase().endsWith('.py')
    || artifact.title.toLowerCase().endsWith('.r')
}

function formatArtifactSize(size: number): string {
  if (size < 1_024) return `${size} B`
  if (size < 1_024 * 1_024) return `${(size / 1_024).toFixed(1)} KB`
  return `${(size / (1_024 * 1_024)).toFixed(1)} MB`
}
