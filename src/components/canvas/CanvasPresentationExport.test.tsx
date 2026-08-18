// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import CanvasPresentationExport from './CanvasPresentationExport'

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

it('exports the selected mode and exposes diagnostics with the download', async () => {
  let resolveFetch!: (response: Response) => void
  let requestInit: RequestInit | undefined
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toContain('/exports/pptx')
    requestInit = init
    return new Promise<Response>((resolve) => { resolveFetch = resolve })
  })
  const response = () => Response.json({
      schemaVersion: 1,
      export: {
        runId: 'export-run',
        pptx: { runId: 'export-run', artifactId: `artifact_${'a'.repeat(64)}` },
        diagnostics: { runId: 'export-run', artifactId: `artifact_${'b'.repeat(64)}` },
        provenance: { runId: 'export-run', artifactId: `artifact_${'c'.repeat(64)}` },
        diagnosticCount: 2,
      },
    })
  vi.stubGlobal('fetch', fetch)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(
    <CanvasPresentationExport
      nodeId="presentation"
      projectDir="."
      branch="main"
      defaultMode="fidelity"
    />,
  ))
  await act(async () => {
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('导出 PPTX'))?.click()
    await Promise.resolve()
    resolveFetch(response())
    await Promise.resolve()
  })
  expect(JSON.parse(String(requestInit?.body))).toMatchObject({ mode: 'fidelity' })
  expect(host.querySelector('a')).not.toBeNull()
  expect(host.textContent).toContain('2 条诊断')
  act(() => root.unmount())
})
