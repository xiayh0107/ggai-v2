const ENABLED_VALUES = new Set(['1', 'true'])

export function isCanvasV2FrontendEnabled(value: unknown): boolean {
  return typeof value === 'string' && ENABLED_VALUES.has(value.trim().toLowerCase())
}

export const CANVAS_V2_FRONTEND_ENABLED = isCanvasV2FrontendEnabled(
  import.meta.env.VITE_GGAI_CANVAS_MODEL_V2,
)

export function canvasV2BranchFromSearch(search: string): string {
  const candidate = new URLSearchParams(search).get('branch')?.trim()
  return candidate || 'main'
}
