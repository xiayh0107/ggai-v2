// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { CanvasNode } from '@/canvas/model'
import NodeTemplateView from './NodeTemplateView'

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

describe('NodeTemplateView', () => {
  it('renders built-in and Agent-defined content through the same finite templates', () => {
    const node = makeNode('指标,方案 A,方案 B\n成本,低,高')
    render(<NodeTemplateView node={node} template="table" />)
    expect(container?.querySelector('[data-node-template="table"]')).toBeTruthy()
    expect(container?.querySelectorAll('td')).toHaveLength(6)
    expect(container?.textContent).toContain('方案 A')
  })

  it('does not create Node shell, empty or running chrome', () => {
    render(<NodeTemplateView node={makeNode('正文')} template="document" />)
    expect(container?.querySelector('[data-canvas-entity]')).toBeNull()
    expect(container?.querySelector('[data-testid="canvas-generating-surface"]')).toBeNull()
    expect(container?.querySelector('header')).toBeNull()
  })
})

function render(node: React.ReactNode) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root?.render(node))
}

function makeNode(text: string): CanvasNode {
  return {
    id: 'node-template-test',
    type: '@tests/template',
    frame: { x: 0, y: 0, w: 320, h: 240, z: 0 },
    title: 'Template test',
    text,
    payload: {},
    artifactRefs: [],
    origin: { kind: 'user' },
  }
}
