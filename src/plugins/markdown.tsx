import type { CSSProperties, ReactNode } from 'react'

/**
 * 轻量 Markdown 渲染：覆盖 AI 输出最常见的语法
 * （标题 / 加粗 / 斜体 / 删除线 / 行内代码 / 代码块 / 链接 / 列表 / 引用 / 表格 / 分割线）。
 * 输出纯 React 元素，不经过 innerHTML，天然免 XSS；
 * 链接仅放行 http(s) / mailto，其余协议降级为 #。
 */

const INLINE_RE =
  /(`[^`\n]+`)|(\*\*[^\n]+?\*\*)|(\*[^*\n]+?\*)|(_[^_\n]+?_)|(~~[^~\n]+?~~)|(\[[^\]\n]+?\]\([^)\n]+?\))/g

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let index = 0
  for (const match of text.matchAll(INLINE_RE)) {
    const start = match.index
    if (start > last) out.push(text.slice(last, start))
    const token = match[0]
    const key = `${keyPrefix}-${index++}`
    if (token.startsWith('`')) {
      out.push(
        <code key={key} className="rounded-[4px] bg-gg-subtle px-1 py-px font-mono text-[0.85em] text-gg-ink">
          {token.slice(1, -1)}
        </code>,
      )
    } else if (token.startsWith('**')) {
      out.push(<strong key={key} className="font-semibold">{renderInline(token.slice(2, -2), key)}</strong>)
    } else if (token.startsWith('~~')) {
      out.push(<s key={key} className="text-gg-muted">{token.slice(2, -2)}</s>)
    } else if (token.startsWith('*') || token.startsWith('_')) {
      out.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>)
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      const href = link?.[2] ?? ''
      const safe = /^(https?:|mailto:)/iu.test(href) ? href : '#'
      out.push(
        <a
          key={key}
          href={safe}
          target="_blank"
          rel="noreferrer"
          data-no-drag
          className="text-gg-primary underline decoration-gg-line underline-offset-2 transition-colors hover:decoration-gg-primary"
        >
          {link?.[1] ?? token}
        </a>,
      )
    }
    last = start + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const HEADING_CLASS: Record<number, string> = {
  1: 'text-[17px] font-semibold',
  2: 'text-[15px] font-semibold',
  3: 'text-[13.5px] font-semibold',
  4: 'text-[13.5px] font-semibold',
}

const UL_RE = /^\s*[-*+]\s+/
const OL_RE = /^\s*\d+\.\s+/
const QUOTE_RE = /^\s*>\s?/
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/
const TABLE_SEP_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/
const FENCE_RE = /^\s*```/
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const HEADING_RE = /^(#{1,4})\s+(.*)$/
const TASK_RE = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/

function isBlockStart(line: string): boolean {
  return FENCE_RE.test(line)
    || HEADING_RE.test(line)
    || HR_RE.test(line)
    || QUOTE_RE.test(line)
    || UL_RE.test(line)
    || OL_RE.test(line)
    || TABLE_ROW_RE.test(line)
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
}

function renderBlocks(text: string): ReactNode[] {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let key = 0
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }

    // 代码块
    if (FENCE_RE.test(line)) {
      const buf: string[] = []
      i++
      while (i < lines.length && !FENCE_RE.test(lines[i])) { buf.push(lines[i]); i++ }
      i++ // 跳过收尾 fence（缺失时也不影响渲染）
      blocks.push(
        <pre
          key={key++}
          className="overflow-x-auto rounded-[8px] bg-gg-subtle px-2.5 py-2 font-mono text-[11.5px] leading-[18px] text-gg-ink"
        >
          <code>{buf.join('\n')}</code>
        </pre>,
      )
      continue
    }

    // 标题
    const heading = HEADING_RE.exec(line)
    if (heading) {
      const level = heading[1].length
      blocks.push(
        <p key={key++} className={HEADING_CLASS[level] ?? HEADING_CLASS[4]}>
          {renderInline(heading[2], `h${key}`)}
        </p>,
      )
      i++
      continue
    }

    // 分割线
    if (HR_RE.test(line)) {
      blocks.push(<hr key={key++} className="border-gg-line" />)
      i++
      continue
    }

    // 引用块
    if (QUOTE_RE.test(line)) {
      const buf: string[] = []
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        buf.push(lines[i].replace(QUOTE_RE, ''))
        i++
      }
      blocks.push(
        <div key={key++} className="space-y-1 border-l-2 border-gg-line pl-2.5 text-gg-muted">
          {buf.map((quoteLine, index) => (
            <p key={index}>{renderInline(quoteLine, `q${key}-${index}`)}</p>
          ))}
        </div>,
      )
      continue
    }

    // 无序列表（含任务列表）
    if (UL_RE.test(line)) {
      const items: string[] = []
      while (i < lines.length && UL_RE.test(lines[i])) { items.push(lines[i]); i++ }
      blocks.push(
        <ul key={key++} className="list-disc space-y-0.5 pl-4">
          {items.map((item, index) => {
            const task = TASK_RE.exec(item)
            if (task) {
              return (
                <li key={index} className="list-none -ml-4 flex items-start gap-1.5">
                  <span className={`shrink-0 ${task[1] === ' ' ? 'text-gg-muted' : 'text-gg-success'}`}>
                    {task[1] === ' ' ? '☐' : '☑'}
                  </span>
                  <span>{renderInline(task[2], `t${key}-${index}`)}</span>
                </li>
              )
            }
            return <li key={index}>{renderInline(item.replace(UL_RE, ''), `u${key}-${index}`)}</li>
          })}
        </ul>,
      )
      continue
    }

    // 有序列表
    if (OL_RE.test(line)) {
      const items: string[] = []
      while (i < lines.length && OL_RE.test(lines[i])) { items.push(lines[i]); i++ }
      blocks.push(
        <ol key={key++} className="list-decimal space-y-0.5 pl-4">
          {items.map((item, index) => (
            <li key={index}>{renderInline(item.replace(OL_RE, ''), `o${key}-${index}`)}</li>
          ))}
        </ol>,
      )
      continue
    }

    // 表格（需要下一行是分隔行）
    if (TABLE_ROW_RE.test(line) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const header = splitTableRow(line)
      i += 2 // 跳过表头与分隔行
      const rows: string[][] = []
      while (i < lines.length && TABLE_ROW_RE.test(lines[i])) {
        rows.push(splitTableRow(lines[i]))
        i++
      }
      blocks.push(
        <div key={key++} className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px] leading-5">
            <thead>
              <tr>
                {header.map((cell, index) => (
                  <th key={index} className="border border-gg-line bg-gg-subtle px-2 py-1 text-left font-medium text-gg-ink">
                    {renderInline(cell, `th${key}-${index}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className="border border-gg-line px-2 py-1 text-gg-ink">
                      {renderInline(cell, `td${key}-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }

    // 普通段落：聚合连续的非块级行，保留换行
    const buf: string[] = []
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      buf.push(lines[i])
      i++
    }
    blocks.push(
      <p key={key++}>
        {buf.map((paragraphLine, index) => (
          <span key={index}>
            {index > 0 && <br />}
            {renderInline(paragraphLine, `p${key}-${index}`)}
          </span>
        ))}
      </p>,
    )
  }
  return blocks
}

/** 文本节点的 Markdown 预览视图（阅读态） */
export function MarkdownView({
  text,
  className = '',
  style,
}: {
  text: string
  className?: string
  style?: CSSProperties
}) {
  return (
    <div className={`space-y-2 leading-6 text-gg-ink ${className}`} style={style}>
      {renderBlocks(text)}
    </div>
  )
}
