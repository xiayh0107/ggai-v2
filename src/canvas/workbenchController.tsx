/* eslint-disable react-refresh/only-export-components -- shared Canvas controller exports hooks */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { SkillAssetApi } from '@/skills/client'

export type CanvasWorkbenchSection = 'search' | 'nodes' | 'resources' | 'skills'

export interface CanvasWorkbenchController {
  readonly section: CanvasWorkbenchSection | null
  readonly skillApi: SkillAssetApi
  openSection(section: CanvasWorkbenchSection): void
  closeSection(): void
  toggleSection(section: CanvasWorkbenchSection): void
}

const CanvasWorkbenchControllerContext = createContext<CanvasWorkbenchController | null>(null)

export function CanvasWorkbenchControllerProvider({
  skillApi,
  initialSection = null,
  children,
}: {
  skillApi: SkillAssetApi
  initialSection?: CanvasWorkbenchSection | null
  children: ReactNode
}) {
  const [section, setSection] = useState<CanvasWorkbenchSection | null>(initialSection)
  const openSection = useCallback((next: CanvasWorkbenchSection) => setSection(next), [])
  const closeSection = useCallback(() => setSection(null), [])
  const toggleSection = useCallback((next: CanvasWorkbenchSection) => {
    setSection((current) => current === next ? null : next)
  }, [])
  const value = useMemo<CanvasWorkbenchController>(() => ({
    section,
    skillApi,
    openSection,
    closeSection,
    toggleSection,
  }), [closeSection, openSection, section, skillApi, toggleSection])

  return (
    <CanvasWorkbenchControllerContext.Provider value={value}>
      {children}
    </CanvasWorkbenchControllerContext.Provider>
  )
}

export function useOptionalCanvasWorkbenchController(): CanvasWorkbenchController | null {
  return useContext(CanvasWorkbenchControllerContext)
}

export function useCanvasWorkbenchController(): CanvasWorkbenchController {
  const controller = useOptionalCanvasWorkbenchController()
  if (!controller) throw new Error('Canvas Workbench controller is unavailable')
  return controller
}
