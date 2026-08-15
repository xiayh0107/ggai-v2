import { useMemo } from 'react'
import { Link } from 'react-router'
import { DAEMON_URL } from '@/agent/config'
import { canvasBranchFromSearch, canvasProjectIdFromSearch } from '@/canvas/scope'
import GeneratedResourcesView from '@/resources/GeneratedResourcesView'
import ResourceCenterHome from '@/resources/ResourceCenterHome'
import SkillResourceManager from '@/resources/SkillResourceManager'
import {
  ProjectArtifactCatalogClient,
  type ProjectArtifactCatalogApi,
} from '@/resources/artifactCatalogClient'
import {
  SkillAssetClient,
  type SkillAssetApi,
} from '@/skills/client'
import {
  WorkspaceProjectClient,
  type WorkspaceProjectApi,
} from '@/workspace/projectClient'
import { CanvasProjectBootstrap } from './Home'

export {
  GeneratedResourcesView as ResourceLibraryContent,
  ResourceCenterHome,
}

/** Route composition only; resource providers own their own loading and presentation. */
export default function ResourceLibrary({
  projectClient: injectedProjectClient,
  artifactApi: injectedArtifactApi,
  skillApi: injectedSkillApi,
}: {
  projectClient?: Pick<WorkspaceProjectApi, 'list' | 'open'>
  artifactApi?: ProjectArtifactCatalogApi
  skillApi?: SkillAssetApi
} = {}) {
  const projectClient = useMemo(
    () => injectedProjectClient ?? new WorkspaceProjectClient({ baseUrl: DAEMON_URL }),
    [injectedProjectClient],
  )
  const artifactApi = useMemo(
    () => injectedArtifactApi ?? new ProjectArtifactCatalogClient({ baseUrl: DAEMON_URL }),
    [injectedArtifactApi],
  )
  const skillApi = useMemo(
    () => injectedSkillApi ?? new SkillAssetClient({ baseUrl: DAEMON_URL }),
    [injectedSkillApi],
  )
  if (window.location.pathname === '/resources/skills') {
    return <SkillResourceManager api={skillApi} />
  }
  const parameters = new URLSearchParams(window.location.search)
  const projectRequested = parameters.has('project')
  const generatedView = window.location.pathname === '/resources/generated'
    || parameters.get('view') === 'generated'
    || (parameters.get('view') === null && projectRequested)
  if (!generatedView || !projectRequested) {
    return <ResourceCenterHome client={projectClient} />
  }

  let projectId: string
  try {
    projectId = canvasProjectIdFromSearch(window.location.search)
  } catch {
    return <ResourceLibraryUnavailable message="这个资源库地址没有包含有效的项目标识。" />
  }

  return (
    <CanvasProjectBootstrap client={projectClient} projectId={projectId}>
      {(project) => (
        <GeneratedResourcesView
          key={project.id}
          project={project}
          api={artifactApi}
          branch={parameters.has('branch')
            ? canvasBranchFromSearch(window.location.search)
            : undefined}
        />
      )}
    </CanvasProjectBootstrap>
  )
}

function ResourceLibraryUnavailable({ message }: { message: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gg-bg p-8 text-center">
      <div className="rounded-[16px] border border-gg-line bg-white p-8">
        <p className="text-[13px] font-medium text-gg-ink">资源库无法打开</p>
        <p className="mt-2 text-[11.5px] text-gg-muted">{message}</p>
        <Link to="/" className="mt-4 inline-block text-[11.5px] text-gg-primary">返回工作空间</Link>
      </div>
    </main>
  )
}
