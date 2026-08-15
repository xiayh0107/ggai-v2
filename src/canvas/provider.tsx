import {
  useEffect,
  type ReactNode,
} from 'react'
import { CanvasContext } from './hooks'
import type { CanvasStore } from './store'

export interface CanvasProviderProps {
  store: CanvasStore
  children: ReactNode
}

export function CanvasProvider({ store, children }: CanvasProviderProps) {
  useEffect(() => {
    void store.load()
    return () => store.dispose()
  }, [store])

  return (
    <CanvasContext.Provider value={store}>
      {children}
    </CanvasContext.Provider>
  )
}
