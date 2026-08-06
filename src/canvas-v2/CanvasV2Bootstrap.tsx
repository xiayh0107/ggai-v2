import { useEffect, useState, type ReactNode } from 'react'
import type { CanvasV2DaemonCapabilities } from './daemonClient'

export interface CanvasV2CapabilityClient {
  getCapabilities(): Promise<CanvasV2DaemonCapabilities>
}

export type CanvasV2BootstrapFailureReason =
  | 'daemon-v1-diagnostic'
  | 'reset-required'
  | 'probe-failed'

export interface CanvasV2BootstrapFailure {
  reason: CanvasV2BootstrapFailureReason
  message?: string
}

export interface CanvasV2BootstrapProps {
  client: CanvasV2CapabilityClient
  children: ReactNode
  loading?: ReactNode
  blocked?: (failure: CanvasV2BootstrapFailure, retry: () => void) => ReactNode
}

type BootstrapState =
  | { status: 'checking' }
  | { status: 'ready' }
  | { status: 'blocked'; failure: CanvasV2BootstrapFailure }

/** V2-only capability boundary. It never imports or mounts the V1 React tree. */
export function CanvasV2Bootstrap({
  client,
  children,
  loading,
  blocked,
}: CanvasV2BootstrapProps) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<BootstrapState>({ status: 'checking' })

  useEffect(() => {
    let active = true
    void client.getCapabilities().then(
      (capabilities) => {
        if (!active) return
        if (capabilities.resetRequired) {
          setState({ status: 'blocked', failure: { reason: 'reset-required' } })
        } else if (capabilities.model !== 'v2') {
          setState({ status: 'blocked', failure: { reason: 'daemon-v1-diagnostic' } })
        } else {
          setState({ status: 'ready' })
        }
      },
      (error: unknown) => {
        if (!active) return
        setState({
          status: 'blocked',
          failure: {
            reason: 'probe-failed',
            message: error instanceof Error ? error.message : String(error),
          },
        })
      },
    )
    return () => {
      active = false
    }
  }, [attempt, client])

  if (state.status === 'checking') return loading ?? null
  if (state.status === 'ready') return children
  const retry = () => {
    setState({ status: 'checking' })
    setAttempt((current) => current + 1)
  }
  return blocked?.(state.failure, retry) ?? (
    <main role="alert">
      Canvas V2 暂不可用。请运行 npm run canvas:v2:reset -- --apply 后重试。
    </main>
  )
}
