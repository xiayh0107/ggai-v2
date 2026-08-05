// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MarkdownView } from './markdown'

let root: Root | null = null
let container: HTMLDivElement | null = null

async function render(text: string) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(<MarkdownView text={text} />))
}

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
})

describe('MarkdownView', () => {
  it('renders headings, emphasis, inline code and links', async () => {
    await render('## 标题\n这是 **加粗** 和 *斜体* 与 `code`，见 [文档](https://example.com)。')
    const html = container!.innerHTML
    expect(container!.textContent).toContain('标题')
    expect(html).toContain('<strong')
    expect(html).toContain('<em')
    expect(html).toContain('<code')
    const link = container!.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://example.com')
    expect(link?.getAttribute('target')).toBe('_blank')
  })

  it('renders lists, quotes and code fences', async () => {
    await render('- 第一项\n- 第二项\n\n> 引用一句\n\n```\nconst a = 1\n```')
    expect(container!.querySelectorAll('ul li')).toHaveLength(2)
    expect(container!.textContent).toContain('引用一句')
    expect(container!.querySelector('pre code')?.textContent).toContain('const a = 1')
  })

  it('renders pipe tables with header separation', async () => {
    await render('| 名称 | 数值 |\n| --- | --- |\n| 甲 | 1 |\n| 乙 | 2 |')
    expect(container!.querySelectorAll('th')).toHaveLength(2)
    expect(container!.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(container!.textContent).toContain('乙')
  })

  it('never emits raw HTML and downgrades unsafe link protocols', async () => {
    await render('<img src=x onerror=alert(1)> 与 [点击](javascript:alert(1))')
    expect(container!.querySelector('img')).toBeNull()
    expect(container!.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(container!.querySelector('a')?.getAttribute('href')).toBe('#')
  })

  it('keeps plain text readable with line breaks', async () => {
    await render('第一行\n第二行')
    expect(container!.querySelector('br')).not.toBeNull()
    expect(container!.textContent).toContain('第一行')
    expect(container!.textContent).toContain('第二行')
  })
})
