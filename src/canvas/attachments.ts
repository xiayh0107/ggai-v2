import type { ProjectArtifactResource } from '@/resources/artifactCatalogClient'

export const MAX_COMPOSER_ATTACHMENTS = 12

export function artifactKey(
  artifact: Pick<ProjectArtifactResource, 'runId' | 'artifactId'>,
): string {
  return `${artifact.runId}\u0000${artifact.artifactId}`
}

export function artifactTitle(artifact: ProjectArtifactResource): string {
  return artifact.relativePath.split('/').at(-1) || '生成内容'
}
