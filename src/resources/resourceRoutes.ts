export function generatedContentHref(projectId: string, branch?: string): string {
  const parameters = new URLSearchParams({ project: projectId })
  if (branch) parameters.set('branch', branch)
  return `/resources/generated?${parameters.toString()}`
}

export function resourceCanvasHref(projectId: string, branch?: string): string {
  const parameters = new URLSearchParams({ project: projectId })
  if (branch) parameters.set('branch', branch)
  return `/canvas?${parameters.toString()}`
}
