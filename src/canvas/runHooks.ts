import { createContext, useContext, useSyncExternalStore } from 'react'
import type {
  CanvasProjectionReview,
  CanvasTaskRunLifecycle,
  CanvasTaskRunLifecycleSnapshot,
} from './runProvider'

export const CanvasTaskRunContext = createContext<CanvasTaskRunLifecycle | null>(null)

export function useCanvasTaskRuns(): CanvasTaskRunLifecycle {
  const lifecycle = useContext(CanvasTaskRunContext)
  if (!lifecycle) {
    throw new Error('useCanvasTaskRuns must be used inside CanvasTaskRunProvider')
  }
  return lifecycle
}

export function useCanvasTaskRunState(): CanvasTaskRunLifecycleSnapshot {
  const lifecycle = useCanvasTaskRuns()
  return useSyncExternalStore(
    lifecycle.subscribe,
    lifecycle.getSnapshot,
    lifecycle.getSnapshot,
  )
}

export function useCanvasProjectionReview(
  taskId: string,
): CanvasProjectionReview | null {
  const lifecycle = useCanvasTaskRuns()
  useCanvasTaskRunState()
  return lifecycle.getProjectionReviewForTask(taskId)
}

export function useCanvasSuggestedActions(taskId: string) {
  return useCanvasProjectionReview(taskId)?.suggestedActions ?? []
}
