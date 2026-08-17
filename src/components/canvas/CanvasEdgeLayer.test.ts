import { describe, expect, it } from 'vitest'
import type { CanvasTaskView } from '@/canvas/selectors'
import {
  edgeCurvePath,
  edgeDraftCurvePath,
  taskInteractionBounds,
} from './CanvasEdgeLayer.utils'

describe('edgeCurvePath', () => {
  it('uses horizontal control points for a horizontal connection', () => {
    const result = edgeCurvePath(
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 300, y: 20, w: 100, h: 50 },
    )

    expect(result.axis).toBe('horizontal')
    expect(result.from).toEqual({ x: 100, y: 25 })
    expect(result.to).toEqual({ x: 300, y: 45 })
    expect(result.path).toBe('M 100 25 C 170 25, 230 45, 300 45')
  })

  it('uses vertical control points for a vertical connection', () => {
    const result = edgeCurvePath(
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 20, y: 200, w: 100, h: 50 },
    )

    expect(result.axis).toBe('vertical')
    expect(result.from).toEqual({ x: 50, y: 50 })
    expect(result.to).toEqual({ x: 70, y: 200 })
    expect(result.path).toBe('M 50 50 C 50 102.5, 70 147.5, 70 200')
  })

  it('keeps a draft wire on the spatial port where the drag started', () => {
    const from = { x: 100, y: 200, w: 300, h: 240 }
    const tip = { x: 600, y: 350, w: 1, h: 1 }

    const topDraft = edgeDraftCurvePath(from, tip, 'top')
    const rightDraft = edgeDraftCurvePath(from, tip, 'right')

    expect(topDraft.from).toEqual({ x: 250, y: 200 })
    expect(topDraft.axis).toBe('vertical')
    expect(topDraft.path).toMatch(/^M 250 200 C 250 147\.325,/)
    expect(rightDraft.from).toEqual({ x: 400, y: 320 })
    expect(rightDraft.axis).toBe('horizontal')
    expect(rightDraft.path).toMatch(/^M 400 320 C 470\.175 320,/)
  })

  it('curves toward the destination when the edge runs in reverse', () => {
    const result = edgeCurvePath(
      { x: 300, y: 200, w: 100, h: 50 },
      { x: 0, y: 0, w: 100, h: 50 },
    )

    expect(result.axis).toBe('horizontal')
    expect(result.path).toBe('M 300 225 C 230 225, 170 25, 100 25')
  })

  it('flags reversed edges so labels can stay upright', () => {
    const forward = edgeCurvePath(
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 300, y: 20, w: 100, h: 50 },
    )
    const rightToLeft = edgeCurvePath(
      { x: 300, y: 20, w: 100, h: 50 },
      { x: 0, y: 0, w: 100, h: 50 },
    )
    const bottomToTop = edgeCurvePath(
      { x: 0, y: 300, w: 400, h: 50 },
      { x: 20, y: 0, w: 40, h: 50 },
    )

    expect(forward.reversed).toBe(false)
    expect(rightToLeft.reversed).toBe(true)
    expect(bottomToTop.reversed).toBe(true)
  })

  it('anchors a ghost-only active task to its visible output surface', () => {
    const ghostFrame = { x: 148, y: 216, w: 400, h: 256 }
    const view: Pick<
      CanvasTaskView,
      'task' | 'nodes' | 'ghosts' | 'containerKind' | 'presentation'
    > = {
      task: {
        id: 'task-running',
        title: '生成内容',
        goal: '生成内容',
        anchor: { x: 100, y: 120 },
        origin: { kind: 'user' },
      },
      nodes: [],
      ghosts: [{
        key: 'pending-output:task-running',
        title: '生成结果',
        phase: 'writing',
        provisional: true,
        frame: ghostFrame,
      }],
      containerKind: 'title-strip',
      presentation: 'expanded',
    }

    expect(taskInteractionBounds(view)).toEqual(ghostFrame)
  })
})
