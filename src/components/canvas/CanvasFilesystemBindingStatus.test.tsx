// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import CanvasFilesystemBindingStatus from './CanvasFilesystemBindingStatus'

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

it('shows an explicit conflict without offering timestamp overwrite', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    schemaVersion: 1,
    binding: {
      bindingId: 'binding-test', projectId: 'project', canvasBranch: 'main',
      nodeId: 'node', rootId: 'root', relativePath: 'note.md', kind: 'file',
      mode: 'bidirectional', baseDigest: 'a', canvasDigest: 'b', diskDigest: 'c',
      state: 'conflict', updatedAt: '2026-08-17T00:00:00.000Z',
    },
  })))
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(
    <CanvasFilesystemBindingStatus bindingId="binding-test" projectDir="." branch="main" />,
  ))
  await vi.waitFor(() => expect(host.textContent).toContain('Canvas 与磁盘均已修改'))
  expect(host.textContent).not.toContain('最后修改时间')
  expect(host.querySelector('button')?.hasAttribute('disabled')).toBe(true)
  act(() => root.unmount())
})
