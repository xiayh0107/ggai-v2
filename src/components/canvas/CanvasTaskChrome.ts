import { nodeHasVisibleContent } from '@/canvas/contextComposer'
import type { CanvasTaskView } from '@/canvas/selectors'

export interface CanvasTaskChromeOptions {
  selectedTask: boolean
  compoundSelectedTask: boolean
}

export interface CanvasTaskChromeState {
  collapsed: boolean
  compact: boolean
  runActive: boolean
  generatingPhase: boolean
  chromelessSingleNode: boolean
  slimMultiNodeChrome: boolean
  noTopChrome: boolean
  captionChrome: boolean
  liteTaskChrome: boolean
}

/**
 * Single source of truth for whether a Task has visible chrome above its outputs.
 * Edge routing must use the same result as the Task renderer or wires can target
 * a title strip that is not actually mounted.
 */
export function canvasTaskChromeState(
  view: Pick<
    CanvasTaskView,
    'containerKind' | 'ghosts' | 'nodes' | 'presentation' | 'status'
  >,
  options: CanvasTaskChromeOptions,
): CanvasTaskChromeState {
  const collapsed = view.presentation === 'collapsed'
  const compact = view.presentation === 'compact'
  const runActive = view.status.kind === 'queued'
    || view.status.kind === 'generating'
    || view.status.kind === 'needs-attention'
  const generatingPhase = !collapsed
    && !compact
    && (view.ghosts.length > 0 || runActive)
    && view.nodes.every((node) => !nodeHasVisibleContent(node))
  const chromelessSingleNode = view.containerKind === 'title-strip'
    && !collapsed
    && !compact
    && !options.compoundSelectedTask
    && view.nodes.length === 1
  const slimMultiNodeChrome = view.containerKind === 'output-frame'
    && !collapsed
    && !compact
    && !options.selectedTask
    && !options.compoundSelectedTask
    && !generatingPhase

  return {
    collapsed,
    compact,
    runActive,
    generatingPhase,
    chromelessSingleNode,
    slimMultiNodeChrome,
    noTopChrome: chromelessSingleNode || generatingPhase,
    captionChrome: slimMultiNodeChrome,
    liteTaskChrome: chromelessSingleNode || slimMultiNodeChrome,
  }
}
