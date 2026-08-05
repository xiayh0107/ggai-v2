import { useMemo } from 'react'
import CanvasV2Shell from '@/components/canvas-v2/CanvasV2Shell'
import { CanvasV2DaemonClient } from '@/canvas-v2/daemonClient'
import { canvasV2BranchFromSearch } from '@/canvas-v2/featureFlag'
import { CanvasV2Provider } from '@/canvas-v2/provider'
import { CanvasV2Store } from '@/canvas-v2/store'
import { DAEMON_PROJECT_DIR, DAEMON_URL } from '@/agent/config'

export default function CanvasV2Home() {
  const branch = canvasV2BranchFromSearch(window.location.search)
  const store = useMemo(() => {
    const client = new CanvasV2DaemonClient({ baseUrl: DAEMON_URL })
    return new CanvasV2Store({
      daemonBaseUrl: DAEMON_URL,
      scope: { projectDir: DAEMON_PROJECT_DIR, branch },
      client,
    })
  }, [branch])

  return (
    <CanvasV2Provider store={store}>
      <CanvasV2Shell />
    </CanvasV2Provider>
  )
}
