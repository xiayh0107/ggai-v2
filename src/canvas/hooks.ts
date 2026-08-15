import { createContext, useContext, useSyncExternalStore } from 'react'
import type { CanvasProposalReview, CanvasTaskView } from './selectors'
import type { CanvasStore, CanvasStoreState } from './store'

export const CanvasContext = createContext<CanvasStore | null>(null)

export function useCanvasStore(): CanvasStore {
  const store = useContext(CanvasContext)
  if (!store) throw new Error('useCanvasStore must be used inside CanvasProvider')
  return store
}

export function useCanvasState(): CanvasStoreState {
  const store = useCanvasStore()
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

export function useCanvasTaskView(
  taskId: string,
  proposalReview?: CanvasProposalReview,
): CanvasTaskView | null {
  const store = useCanvasStore()
  useCanvasState()
  return store.selectTaskView(taskId, proposalReview)
}
