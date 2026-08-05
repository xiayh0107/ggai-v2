import { createContext, useContext, useSyncExternalStore } from 'react'
import type { CanvasProposalReviewV2, CanvasTaskViewV2 } from './selectors'
import type { CanvasV2Store, CanvasV2StoreState } from './store'

export const CanvasV2Context = createContext<CanvasV2Store | null>(null)

export function useCanvasV2Store(): CanvasV2Store {
  const store = useContext(CanvasV2Context)
  if (!store) throw new Error('useCanvasV2Store must be used inside CanvasV2Provider')
  return store
}

export function useCanvasV2State(): CanvasV2StoreState {
  const store = useCanvasV2Store()
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

export function useCanvasV2TaskView(
  taskId: string,
  proposalReview?: CanvasProposalReviewV2,
): CanvasTaskViewV2 | null {
  const store = useCanvasV2Store()
  useCanvasV2State()
  return store.selectTaskView(taskId, proposalReview)
}
