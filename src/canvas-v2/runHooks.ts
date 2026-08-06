import { createContext, useContext, useSyncExternalStore } from 'react'
import type {
  CanvasV2ProjectionReview,
  CanvasV2TaskRunLifecycle,
  CanvasV2TaskRunLifecycleSnapshot,
} from './runProvider'

export const CanvasV2TaskRunContext = createContext<CanvasV2TaskRunLifecycle | null>(null)

export function useCanvasV2TaskRuns(): CanvasV2TaskRunLifecycle {
  const lifecycle = useContext(CanvasV2TaskRunContext)
  if (!lifecycle) {
    throw new Error('useCanvasV2TaskRuns must be used inside CanvasV2TaskRunProvider')
  }
  return lifecycle
}

export function useCanvasV2TaskRunState(): CanvasV2TaskRunLifecycleSnapshot {
  const lifecycle = useCanvasV2TaskRuns()
  return useSyncExternalStore(
    lifecycle.subscribe,
    lifecycle.getSnapshot,
    lifecycle.getSnapshot,
  )
}

export function useCanvasV2ProjectionReview(
  taskId: string,
): CanvasV2ProjectionReview | null {
  const lifecycle = useCanvasV2TaskRuns()
  useCanvasV2TaskRunState()
  return lifecycle.getProjectionReviewForTask(taskId)
}

export function useCanvasV2SuggestedActions(taskId: string) {
  return useCanvasV2ProjectionReview(taskId)?.suggestedActions ?? []
}
