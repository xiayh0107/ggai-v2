import { useMemo } from 'react'
import CanvasShell from '@/components/canvas/CanvasShell'
import { CanvasDaemonClient } from '@/canvas/daemonClient'
import { canvasBranchFromSearch } from '@/canvas/scope'
import { CanvasProvider } from '@/canvas/provider'
import { CanvasTaskRunProvider } from '@/canvas/runProvider'
import { CanvasStore } from '@/canvas/store'
import { TaskRunHttpClient } from '@/agent/taskRunHttpClient'
import { DAEMON_URL } from '@/agent/config'

export interface CanvasHomeProps {
  projectId: string
  projectDir: string
  projectTitle: string
}

export default function CanvasHome({ projectId, projectDir, projectTitle }: CanvasHomeProps) {
  const branch = canvasBranchFromSearch(window.location.search)
  const store = useMemo(() => {
    const client = new CanvasDaemonClient({ baseUrl: DAEMON_URL })
    return new CanvasStore({
      daemonBaseUrl: DAEMON_URL,
      scope: { projectDir, branch },
      client,
    })
  }, [branch, projectDir])
  const taskRunClient = useMemo(() => new TaskRunHttpClient({ baseUrl: DAEMON_URL }), [])

  return (
    <CanvasProvider store={store}>
      <CanvasTaskRunProvider store={store} daemonClient={taskRunClient}>
        <CanvasShell projectId={projectId} projectTitle={projectTitle} />
      </CanvasTaskRunProvider>
    </CanvasProvider>
  )
}
