import type { WorkspaceProject } from './projectClient'

export function projectHref(projectId: string): string {
  return `/canvas?project=${encodeURIComponent(projectId)}`
}

export function sortProjects(projects: WorkspaceProject[]): WorkspaceProject[] {
  return [...projects].sort((left, right) => {
    const rightTime = Date.parse(right.lastOpenedAt ?? right.updatedAt)
    const leftTime = Date.parse(left.lastOpenedAt ?? left.updatedAt)
    return rightTime - leftTime || left.title.localeCompare(right.title, 'zh-CN')
  })
}
