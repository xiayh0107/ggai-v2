import { describe, expect, it } from 'vitest'
import {
  canonicalizeCanvasV2Selection,
  mergeSelectionV2,
  nextRovingKeyV2,
  normalizedBoundsV2,
  screenToWorldV2,
  selectionFromMarqueeV2,
  updateSelectionV2,
  zoomCameraAtV2,
} from './interaction'
import { emptyCanvasDocumentV2, type CanvasDocumentV2 } from './model'

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

describe('Canvas V2 canonical selection hierarchy', () => {
  it('lets a selected Task absorb its output Nodes regardless of input order', () => {
    const document = selectionHierarchyDocument()

    expect(canonicalizeCanvasV2Selection(document, [
      { kind: 'node', id: 'member-output' },
      { kind: 'task', id: 'member-task' },
      { kind: 'node', id: 'outside-node' },
      { kind: 'node', id: 'member-output' },
    ])).toEqual([
      { kind: 'task', id: 'member-task' },
      { kind: 'node', id: 'outside-node' },
    ])
  })

  it('lets a selected Collection absorb direct members and member Task outputs', () => {
    const document = selectionHierarchyDocument()

    expect(canonicalizeCanvasV2Selection(document, [
      { kind: 'node', id: 'member-output' },
      { kind: 'node', id: 'loose-member' },
      { kind: 'task', id: 'member-task' },
      { kind: 'collection', id: 'collection-1' },
      { kind: 'task', id: 'outside-task' },
    ])).toEqual([
      { kind: 'collection', id: 'collection-1' },
      { kind: 'task', id: 'outside-task' },
    ])
  })

  it('removes invalid and duplicate references while preserving survivor order', () => {
    const document = selectionHierarchyDocument()

    expect(canonicalizeCanvasV2Selection(document, [
      { kind: 'node', id: 'outside-node' },
      { kind: 'task', id: 'missing-task' },
      { kind: 'node', id: 'outside-node' },
      { kind: 'collection', id: 'missing-collection' },
      { kind: 'task', id: 'outside-task' },
      { kind: 'node', id: 'missing-node' },
    ])).toEqual([
      { kind: 'node', id: 'outside-node' },
      { kind: 'task', id: 'outside-task' },
    ])
  })

  it('drops Nodes hidden by a collapsed Task unless the Task is selected', () => {
    const document = selectionHierarchyDocument()

    expect(canonicalizeCanvasV2Selection(document, [
      { kind: 'node', id: 'outside-output' },
      { kind: 'node', id: 'outside-node' },
    ], { collapsedTaskIds: ['outside-task'] })).toEqual([
      { kind: 'node', id: 'outside-node' },
    ])
    expect(canonicalizeCanvasV2Selection(document, [
      { kind: 'node', id: 'outside-output' },
      { kind: 'task', id: 'outside-task' },
    ], { collapsedTaskIds: ['outside-task'] })).toEqual([
      { kind: 'task', id: 'outside-task' },
    ])
  })

  it('drops every member hidden by a collapsed Collection unless it is selected', () => {
    const document = selectionHierarchyDocument()
    const hiddenMembers = [
      { kind: 'task' as const, id: 'member-task' },
      { kind: 'node' as const, id: 'member-output' },
      { kind: 'node' as const, id: 'loose-member' },
      { kind: 'node' as const, id: 'outside-node' },
    ]

    expect(canonicalizeCanvasV2Selection(document, hiddenMembers, {
      collapsedCollectionIds: ['collection-1'],
    })).toEqual([
      { kind: 'node', id: 'outside-node' },
    ])
    expect(canonicalizeCanvasV2Selection(document, [
      ...hiddenMembers,
      { kind: 'collection', id: 'collection-1' },
    ], { collapsedCollectionIds: ['collection-1'] })).toEqual([
      { kind: 'node', id: 'outside-node' },
      { kind: 'collection', id: 'collection-1' },
    ])
  })
})

function selectionHierarchyDocument(): CanvasDocumentV2 {
  const document = emptyCanvasDocumentV2()
  document.collections.push({
    id: 'collection-1',
    title: 'Research set',
    anchor: { x: 40, y: 40 },
  })
  document.tasks.push(
    {
      id: 'member-task',
      title: 'Collection task',
      goal: 'Create a chart',
      anchor: { x: 100, y: 120 },
      collectionId: 'collection-1',
      origin: { kind: 'user' },
    },
    {
      id: 'outside-task',
      title: 'Outside task',
      goal: 'Create a report',
      anchor: { x: 800, y: 120 },
      origin: { kind: 'user' },
    },
  )
  document.nodes.push(
    {
      id: 'member-output',
      type: 'file',
      frame: { x: 120, y: 240, w: 300, h: 200, z: 1 },
      title: 'Task output',
      artifactRefs: [],
      homeTaskId: 'member-task',
      origin: { kind: 'user' },
    },
    {
      id: 'loose-member',
      type: 'file',
      frame: { x: 460, y: 240, w: 300, h: 200, z: 1 },
      title: 'Loose collection member',
      artifactRefs: [],
      collectionId: 'collection-1',
      origin: { kind: 'user' },
    },
    {
      id: 'outside-output',
      type: 'file',
      frame: { x: 840, y: 240, w: 300, h: 200, z: 1 },
      title: 'Outside task output',
      artifactRefs: [],
      homeTaskId: 'outside-task',
      origin: { kind: 'user' },
    },
    {
      id: 'outside-node',
      type: 'file',
      frame: { x: 1200, y: 240, w: 300, h: 200, z: 1 },
      title: 'Outside node',
      artifactRefs: [],
      origin: { kind: 'user' },
    },
  )
  return document
}
