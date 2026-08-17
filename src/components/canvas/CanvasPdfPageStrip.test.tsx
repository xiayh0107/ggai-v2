// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import CanvasPdfPageStrip from './CanvasPdfPageStrip'

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

it('loads only the selected PDF page and exposes generation state', async () => {
  const pending: Array<{
    input: RequestInfo | URL
    resolve: (response: Response) => void
  }> = []
  const fetch = vi.fn((input: RequestInfo | URL) => new Promise<Response>((resolve) => {
    pending.push({ input, resolve })
  }))
  const responseFor = (input: RequestInfo | URL) => {
    const pageNumber = Number(new URL(String(input)).searchParams.get('page'))
    return Response.json({
      schemaVersion: 1,
      page: {
        importId: 'pdf_import_test', pageNumber,
        viewport: { width: 612, height: 792, rotation: 0, unit: 'pt' },
        text: { itemCount: 1, summary: `Page ${pageNumber}` },
        annotations: { count: 0, subtypes: [] },
        preview: { runId: `preview-${pageNumber}`, artifactId: `artifact_${'a'.repeat(64)}` },
      },
    })
  }
  vi.stubGlobal('fetch', fetch)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(
    <CanvasPdfPageStrip importId="pdf_import_test" pageCount={300} projectDir="." />,
  ))
  expect(host.querySelector('[aria-label="正在生成页面预览"]')).not.toBeNull()
  await act(async () => {
    pending[0]!.resolve(responseFor(pending[0]!.input))
    await Promise.resolve()
  })
  expect(host.querySelector('img')?.getAttribute('alt') ?? '').toContain('第 1 页')
  expect(host.textContent).toContain('1 / 300 页')
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[aria-label="下一页"]')?.click()
    await Promise.resolve()
    pending[1]!.resolve(responseFor(pending[1]!.input))
    await Promise.resolve()
  })
  expect(host.textContent).toContain('2 / 300 页')
  expect(fetch).toHaveBeenCalledTimes(2)
  act(() => root.unmount())
})
