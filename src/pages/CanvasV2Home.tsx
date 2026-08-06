import { useMemo } from 'react'
import CanvasV2Shell from '@/components/canvas-v2/CanvasV2Shell'
import { CanvasV2DaemonClient } from '@/canvas-v2/daemonClient'
import { canvasV2BranchFromSearch } from '@/canvas-v2/scope'
import { CanvasV2Provider } from '@/canvas-v2/provider'
import { CanvasV2TaskRunProvider } from '@/canvas-v2/runProvider'
import { CanvasV2Store } from '@/canvas-v2/store'
import { DaemonClient } from '@/agent/daemonClient'
import { DAEMON_URL } from '@/agent/config'

export interface CanvasV2HomeProps {
  projectDir: string
  projectTitle: string
}

export default function CanvasV2Home({ projectDir, projectTitle }: CanvasV2HomeProps) {
  const branch = canvasV2BranchFromSearch(window.location.search)
  const store = useMemo(() => {
    const client = new CanvasV2DaemonClient({ baseUrl: DAEMON_URL })
    return new CanvasV2Store({
      daemonBaseUrl: DAEMON_URL,
      scope: { projectDir, branch },
      client,
    })
  }, [branch, projectDir])
  const taskRunClient = useMemo(() => new DaemonClient({ baseUrl: DAEMON_URL }), [])

  return (
    <CanvasV2Provider store={store}>
      <CanvasV2TaskRunProvider store={store} daemonClient={taskRunClient}>
        <CanvasV2Shell projectTitle={projectTitle} />
      </CanvasV2TaskRunProvider>
    </CanvasV2Provider>
  )
}
