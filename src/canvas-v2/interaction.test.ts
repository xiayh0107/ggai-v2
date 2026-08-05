import { describe, expect, it } from 'vitest'
import {
  mergeSelectionV2,
  nextRovingKeyV2,
  normalizedBoundsV2,
  screenToWorldV2,
  selectionFromMarqueeV2,
  updateSelectionV2,
  zoomCameraAtV2,
} from './interaction'

describe('Canvas V2 interaction geometry', () => {
  it('converts through an offset viewport and keeps the zoom anchor fixed', () => {
    const viewport = { left: 52, top: 80, width: 800, height: 600 }
    const camera = { x: 100, y: 60, zoom: 1 }
    const point = { clientX: 352, clientY: 290 }

    expect(screenToWorldV2(point, camera, viewport)).toEqual({ x: 200, y: 150 })
    const zoomed = zoomCameraAtV2(camera, viewport, point, 1.5)
    expect(zoomed).toEqual({ x: 0, y: -15, zoom: 1.5 })
    expect(screenToWorldV2(point, zoomed, viewport)).toEqual({ x: 200, y: 150 })
  })

  it('normalizes marquee geometry and selects every intersecting typed entity', () => {
    const marquee = normalizedBoundsV2({ x: 220, y: 180 }, { x: 20, y: 30 })
    expect(marquee).toEqual({ x: 20, y: 30, w: 200, h: 150 })
    expect(selectionFromMarqueeV2([
      { target: { kind: 'task', id: 'task-a' }, bounds: { x: 40, y: 40, w: 80, h: 50 } },
      { target: { kind: 'node', id: 'node-a' }, bounds: { x: 200, y: 170, w: 80, h: 80 } },
      { target: { kind: 'node', id: 'node-b' }, bounds: { x: 300, y: 300, w: 40, h: 40 } },
    ], marquee)).toEqual([
      { kind: 'task', id: 'task-a' },
      { kind: 'node', id: 'node-a' },
    ])
  })

  it('supports additive toggle selection and stable marquee union', () => {
    const task = { kind: 'task' as const, id: 'task-a' }
    const node = { kind: 'node' as const, id: 'node-a' }
    expect(updateSelectionV2([], task, false)).toEqual([task])
    expect(updateSelectionV2([task], node, true)).toEqual([task, node])
    expect(updateSelectionV2([task, node], task, true)).toEqual([node])
    expect(mergeSelectionV2([task], [task, node])).toEqual([task, node])
  })

  it('wraps a roving tabindex order with arrows and supports Home/End', () => {
    const keys = ['task:a', 'node:a', 'task:b']
    expect(nextRovingKeyV2(keys, 'task:a', 'ArrowLeft')).toBe('task:b')
    expect(nextRovingKeyV2(keys, 'task:b', 'ArrowRight')).toBe('task:a')
    expect(nextRovingKeyV2(keys, 'node:a', 'Home')).toBe('task:a')
    expect(nextRovingKeyV2(keys, 'node:a', 'End')).toBe('task:b')
    expect(nextRovingKeyV2(keys, 'node:a', 'Enter')).toBe('node:a')
  })
})
