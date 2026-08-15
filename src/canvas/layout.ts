import type { CanvasPoint } from './model.js'

export interface CanvasLayoutBounds {
  x: number
  y: number
  w: number
  h: number
}

/** Shared by trusted materialization and transient ghost projection. */
export const TASK_OUTPUT_LAYOUT = Object.freeze({
  columns: 2,
  offsetX: 48,
  offsetY: 96,
  width: 400,
  height: 256,
  columnGap: 56,
  rowGap: 48,
})

export const TASK_CHROME_LAYOUT = Object.freeze({
  cardWidth: 360,
  cardHeight: 156,
  compactHeight: 80,
  collapsedWidth: 360,
  collapsedHeight: 72,
  titleStripWidth: 400,
  titleStripHeight: 64,
})

export const COLLECTION_CHROME_LAYOUT = Object.freeze({
  collapsedWidth: 380,
  collapsedHeight: 84,
  minimumWidth: 420,
  minimumHeight: 160,
})

export function taskOutputFrame(
  anchor: CanvasPoint,
  index: number,
): CanvasLayoutBounds {
  const column = index % TASK_OUTPUT_LAYOUT.columns
  const row = Math.floor(index / TASK_OUTPUT_LAYOUT.columns)
  return {
    x: anchor.x + TASK_OUTPUT_LAYOUT.offsetX
      + column * (TASK_OUTPUT_LAYOUT.width + TASK_OUTPUT_LAYOUT.columnGap),
    y: anchor.y + TASK_OUTPUT_LAYOUT.offsetY
      + row * (TASK_OUTPUT_LAYOUT.height + TASK_OUTPUT_LAYOUT.rowGap),
    w: TASK_OUTPUT_LAYOUT.width,
    h: TASK_OUTPUT_LAYOUT.height,
  }
}
