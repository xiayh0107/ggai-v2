import {
  useEffect,
  type ReactNode,
} from 'react'
import { CanvasV2Context } from './hooks'
import type { CanvasV2Store } from './store'

export interface CanvasV2ProviderProps {
  store: CanvasV2Store
  children: ReactNode
}

export function CanvasV2Provider({ store, children }: CanvasV2ProviderProps) {
  useEffect(() => {
    void store.load()
    return () => store.dispose()
  }, [store])

  return (
    <CanvasV2Context.Provider value={store}>
      {children}
    </CanvasV2Context.Provider>
  )
}
