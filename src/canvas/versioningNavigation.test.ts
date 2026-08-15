// @vitest-environment jsdom
import { act } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  canvasBranchNavigationHref,
  useCanvasBranchNavigation,
} from './versioningNavigation'

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

describe('Canvas branch navigation', () => {
  it('updates only the branch search parameter', () => {
    expect(canvasBranchNavigationHref(
      'http://localhost:3000/canvas?project=project_root&branch=main#viewport',
      'feature/chart',
    )).toBe(
      'http://localhost:3000/canvas?project=project_root&branch=feature%2Fchart#viewport',
    )
  })

  it('offers a test seam while committing a full scope reload URL', () => {
    const commit = vi.fn()
    function Harness() {
      const navigate = useCanvasBranchNavigation(commit)
      return createElement(
        'button',
        { type: 'button', onClick: () => navigate('restore/chart') },
        '切换',
      )
    }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => root?.render(createElement(Harness)))

    act(() => container?.querySelector('button')?.click())

    expect(commit).toHaveBeenCalledOnce()
    expect(new URL(commit.mock.calls[0]![0]).searchParams.get('branch')).toBe('restore/chart')
  })
})
