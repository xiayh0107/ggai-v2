import { FileQuestion, Globe, Image as ImageIcon } from 'lucide-react'
import type { CSSProperties } from 'react'
import type { CanvasNode } from '@/canvas/model'
import { MarkdownView } from '@/plugins/markdown'
import type { NodeContentTemplate } from './uiContracts'

export interface NodeTemplateViewProps {
  node: CanvasNode
  template: NodeContentTemplate
}

/**
 * The only renderer for non-artifact plugin content.
 *
 * Templates own content typography only. The Canvas owns the Node shell, header,
 * selection, empty/running surfaces, activity and actions.
 */
export default function NodeTemplateView({ node, template }: NodeTemplateViewProps) {
  if (template === 'document') return <DocumentTemplate node={node} />
  if (template === 'code') {
    return (
      <pre
        data-node-template="code"
        className="h-full overflow-auto whitespace-pre-wrap p-3 font-mono text-[11.5px] leading-5 text-gg-ink"
      >
        {contentText(node)}
      </pre>
    )
  }
  if (template === 'formula') {
    return (
      <div
        data-node-template="formula"
        className="flex h-full items-center justify-center px-4 font-serif text-[16px] italic tracking-wide text-gg-ink"
      >
        {contentText(node)}
      </div>
    )
  }
  if (template === 'link') {
    return (
      <div data-node-template="link" className="flex h-full min-h-0 flex-col justify-center gap-2 px-4">
        <div className="flex items-center gap-2 text-gg-primary">
          <Globe size={14} className="shrink-0" aria-hidden="true" />
          <span className="truncate text-[12px]">{node.title}</span>
        </div>
        {contentText(node) ? (
          <p className="line-clamp-5 text-[11.5px] leading-5 text-gg-muted">{contentText(node)}</p>
        ) : null}
      </div>
    )
  }
  if (template === 'table') return <TableTemplate node={node} />
  if (template === 'media') {
    return (
      <div data-node-template="media" className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-gg-muted">
        <ImageIcon size={30} strokeWidth={1.35} aria-hidden="true" />
        {contentText(node) ? <p className="text-[11.5px] leading-5">{contentText(node)}</p> : null}
      </div>
    )
  }
  if (template === 'file') {
    return (
      <div data-node-template="file" className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-gg-muted">
        <FileQuestion size={30} strokeWidth={1.35} aria-hidden="true" />
        <p className="text-[11.5px] leading-5">{contentText(node) || node.title}</p>
      </div>
    )
  }
  return (
    <div data-node-template="card" className="flex h-full items-center justify-center p-4 text-center text-[11.5px] leading-5 text-gg-ink">
      {contentText(node) || node.title}
    </div>
  )
}

function DocumentTemplate({ node }: { node: CanvasNode }) {
  const payload = node.payload ?? {}
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
    <div
      data-node-template="document"
      data-no-drag
      className="h-full cursor-text select-text overflow-auto p-3"
    >
      <MarkdownView text={contentText(node)} className={sizeClass} style={style} />
    </div>
  )
}

function TableTemplate({ node }: { node: CanvasNode }) {
  const rows = contentText(node)
    .split(/\r?\n/u)
    .filter(Boolean)
    .slice(0, 12)
    .map((row) => row.split(',').slice(0, 8))
  if (rows.length === 0) return null
  return (
    <div data-node-template="table" className="h-full overflow-auto p-3">
      <table className="w-full border-collapse text-[11px]">
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`${rowIndex}:${row.join('\u0000')}`}>
              {row.map((cell, cellIndex) => (
                <td key={`${cellIndex}:${cell}`} className="border border-gg-line px-2 py-1.5 text-gg-ink">
                  {cell.trim()}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function contentText(node: CanvasNode): string {
  if (node.text?.trim()) return node.text
  const content = node.payload?.content
  if (typeof content === 'string') return content
  if (node.payload && Object.keys(node.payload).length > 0) {
    return JSON.stringify(node.payload, null, 2)
  }
  return ''
}
