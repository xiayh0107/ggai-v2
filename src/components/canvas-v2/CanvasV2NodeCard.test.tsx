// @vitest-environment jsdom
import { act } from 'react'
import type { ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FileQuestion } from 'lucide-react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CanvasNodeV2 } from '@/canvas-v2/model'
import { registerBuiltinPlugins } from '@/plugins/builtins'
import {
  getPlugin,
  listCreatablePlugins,
  registerPlugin,
  type NodePlugin,
  unregisterPlugin,
} from '@/plugins/types'
import CanvasV2NodeCard from './CanvasV2NodeCard'

const artifactId = `artifact_${'a'.repeat(64)}`
let root: Root | null = null
let container: HTMLDivElement | null = null

beforeAll(() => {
  registerBuiltinPlugins()
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
  vi.unstubAllGlobals()
})

afterAll(() => {
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

describe('CanvasV2NodeCard artifact projection', () => {
  it('renders a community-owned artifact view through its pure projector', async () => {
    const projected = vi.fn<NonNullable<NodePlugin['projectArtifact']>>((artifact) => ({
      title: `Projected ${artifact.title}`,
      payload: { digest: artifact.contentDigest },
    }))
    const plugin: NodePlugin = {
      id: '@tests/notebook-view',
      label: 'Notebook',
      desc: 'Notebook artifact view',
      icon: FileQuestion,
      defaultWidth: 320,
      initialPayload: () => ({}),
      isEmpty: () => false,
      views: {
        Empty: () => null,
        Content: () => null,
        Artifact: ({ artifact, content }) => (
          <div data-testid="community-artifact">
            {content.title} · {artifact.mediaType}
          </div>
        ),
      },
      instr: { placeholder: 'Use notebook', actions: [] },
      artifactClaims: [{ extensions: ['.ipynb'] }],
      projectArtifact: projected,
      demoResult: () => null,
    }
    registerPlugin(plugin)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: 2,
      runId: 'run-notebook',
      artifactId,
      mediaType: 'application/x-ipynb+json',
      size: 128,
      contentDigest: 'b'.repeat(64),
    }), { headers: { 'Content-Type': 'application/json' } })))

    try {
      await renderNode({
        id: 'node-notebook',
        type: plugin.id,
        frame: { x: 0, y: 0, w: 320, h: 220, z: 1 },
        title: 'Analysis notebook',
        artifactRefs: [{ runId: 'run-notebook', artifactId }],
        origin: { kind: 'user' },
      })

      expect(container?.querySelector('[data-testid="community-artifact"]')?.textContent)
        .toContain('Projected Analysis notebook · application/x-ipynb+json')
      expect(projected).toHaveBeenCalledTimes(1)
      expect(Object.keys(projected.mock.calls[0]![0]).sort()).toEqual([
        'artifactId',
        'contentDigest',
        'mediaType',
        'runId',
        'size',
        'title',
        'url',
      ])
    } finally {
      unregisterPlugin(plugin.id)
    }
  })

  it('keeps the generic file fallback renderable but out of creation menus', async () => {
    expect(getPlugin('file').views.Artifact).toBeTypeOf('function')
    expect(listCreatablePlugins().map(({ id }) => id)).not.toContain('file')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: 2,
      runId: 'run-file',
      artifactId,
      mediaType: 'application/octet-stream',
      size: 17,
      contentDigest: 'c'.repeat(64),
    }), { headers: { 'Content-Type': 'application/json' } })))

    await renderNode({
      id: 'node-file',
      type: 'file',
      frame: { x: 0, y: 0, w: 320, h: 220, z: 1 },
      title: 'unknown.bin',
      artifactRefs: [{ runId: 'run-file', artifactId }],
      origin: { kind: 'user' },
    })

    expect(container?.textContent).toContain('application/octet-stream')
    expect(container?.querySelector<HTMLAnchorElement>('a')?.href).toContain(
      `/runs/run-file/artifacts/${artifactId}`,
    )
  })

  it('renders verified R source bytes inside the code artifact view', async () => {
    const fetchArtifact = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/metadata')) {
        return new Response(JSON.stringify({
          schemaVersion: 2,
          runId: 'run-r-source',
          artifactId,
          mediaType: 'text/x-r',
          size: 45,
          contentDigest: 'd'.repeat(64),
        }), { headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('library(ggplot2)\nggplot(mtcars, aes(wt, mpg))', {
        headers: { 'Content-Type': 'text/x-r' },
      })
    })
    vi.stubGlobal('fetch', fetchArtifact)

    await renderNode({
      id: 'node-r-source',
      type: 'code',
      frame: { x: 0, y: 0, w: 360, h: 260, z: 1 },
      title: 'classic_scatter_plot.R',
      artifactRefs: [{ runId: 'run-r-source', artifactId }],
      origin: { kind: 'user' },
    })

    expect(container?.querySelector('pre')?.textContent).toContain('ggplot(mtcars')
    expect(fetchArtifact).toHaveBeenCalledTimes(2)
    expect(fetchArtifact.mock.calls.some(([input]) =>
      String(input).includes(`/runs/run-r-source/artifacts/${artifactId}?`))).toBe(true)
  })

  it('selects from the content surface while preserving nested controls', async () => {
    const onDragStart = vi.fn()
    await renderNode({
      id: 'node-clickable-body',
      type: 'text',
      frame: { x: 0, y: 0, w: 320, h: 220, z: 1 },
      title: 'Clickable body',
      text: 'Clicking this content opens its node-local prompt surface.',
      artifactRefs: [],
      origin: { kind: 'user' },
    }, onDragStart)

    act(() => {
      container?.querySelector('pre')?.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
      }))
    })
    expect(onDragStart).toHaveBeenCalledOnce()
    expect(onDragStart.mock.calls[0]?.[1]).toMatchObject({ id: 'node-clickable-body' })
  })
})

async function renderNode(
  node: CanvasNodeV2,
  onDragStart: NonNullable<ComponentProps<typeof CanvasV2NodeCard>['onDragStart']>
    = () => undefined,
): Promise<void> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <CanvasV2NodeCard
        node={node}
        projectDir="/project"
        selected={false}
        tabIndex={0}
        onFocus={() => undefined}
        onKeyDown={() => undefined}
        onDragStart={onDragStart}
        onResizeStart={() => undefined}
        registerFocusable={() => undefined}
      />,
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
