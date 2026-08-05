import type { CanvasPointV2 } from './model.js'

export interface CanvasV2LayoutBounds {
  x: number
  y: number
  w: number
  h: number
}

/** Shared by trusted materialization and transient ghost projection. */
export const TASK_OUTPUT_LAYOUT_V2 = Object.freeze({
  columns: 2,
  offsetX: 48,
  offsetY: 96,
  width: 400,
  height: 256,
  columnGap: 56,
  rowGap: 48,
})

export const TASK_CHROME_LAYOUT_V2 = Object.freeze({
  cardWidth: 360,
  cardHeight: 156,
  compactHeight: 80,
  collapsedWidth: 360,
  collapsedHeight: 72,
  titleStripWidth: 400,
  titleStripHeight: 64,
})

export function taskOutputFrameV2(
  anchor: CanvasPointV2,
  index: number,
): CanvasV2LayoutBounds {
  const column = index % TASK_OUTPUT_LAYOUT_V2.columns
  const row = Math.floor(index / TASK_OUTPUT_LAYOUT_V2.columns)
  return {
    x: anchor.x + TASK_OUTPUT_LAYOUT_V2.offsetX
      + column * (TASK_OUTPUT_LAYOUT_V2.width + TASK_OUTPUT_LAYOUT_V2.columnGap),
    y: anchor.y + TASK_OUTPUT_LAYOUT_V2.offsetY
      + row * (TASK_OUTPUT_LAYOUT_V2.height + TASK_OUTPUT_LAYOUT_V2.rowGap),
    w: TASK_OUTPUT_LAYOUT_V2.width,
    h: TASK_OUTPUT_LAYOUT_V2.height,
  }
}
