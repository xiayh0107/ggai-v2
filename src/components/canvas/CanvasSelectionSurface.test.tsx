// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PortDefinition } from '@/plugins/nodeTypeContracts'
import { CanvasSelectionToolbar } from './CanvasSelectionSurface'

const ports: PortDefinition[] = [{
  key: 'content-in',
  direction: 'input',
  schema: 'ggai://value/text',
  cardinality: 'one',
}, {
  key: 'content',
  direction: 'output',
  schema: 'ggai://value/text',
  cardinality: 'one',
  materialization: 'tray',
}]

afterEach(() => {
  document.body.replaceChildren()
})

describe('CanvasSelectionToolbar data ports', () => {
  it('renders named typed ports and forwards the exact declaration', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onDataPort = vi.fn()
    act(() => root.render(
      <CanvasSelectionToolbar
        bounds={{ x: 10, y: 20, w: 300, h: 200 }}
        camera={{ x: 0, y: 0, zoom: 1 }}
        compound={false}
        canSaveCollection={false}
        dataPorts={ports}
        onDataPort={onDataPort}
        onFocusComposer={() => undefined}
        onClear={() => undefined}
      />,
    ))

    const output = host.querySelector<HTMLButtonElement>(
      '[data-node-data-port="content"][data-port-direction="output"]',
    )
    const input = host.querySelector<HTMLButtonElement>(
      '[data-node-data-port="content-in"][data-port-direction="input"]',
    )
    expect(output?.title).toContain('ggai://value/text')
    act(() => output?.click())
    act(() => input?.click())
    expect(onDataPort.mock.calls).toEqual([[ports[1]], [ports[0]]])
    act(() => root.unmount())
  })
})
