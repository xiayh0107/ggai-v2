import { useEffect, useState, type ReactNode } from 'react'
import {
  CanvasSchemaMismatchError,
  type CanvasDaemonCapabilities,
} from './daemonClient'

export interface CanvasCapabilityClient {
  getCapabilities(): Promise<CanvasDaemonCapabilities>
}

export type CanvasBootstrapFailureReason =
  | 'daemon-incompatible'
  | 'daemon-stale'
  | 'probe-failed'

export interface CanvasBootstrapFailure {
  reason: CanvasBootstrapFailureReason
  message?: string
}

export interface CanvasBootstrapProps {
  client: CanvasCapabilityClient
  children: ReactNode
  loading?: ReactNode
  blocked?: (failure: CanvasBootstrapFailure, retry: () => void) => ReactNode
}

type BootstrapState =
  | { status: 'checking' }
  | { status: 'ready' }
  | { status: 'blocked'; failure: CanvasBootstrapFailure }

function canvasBootstrapFailureFromError(error: unknown): CanvasBootstrapFailure {
  if (error instanceof CanvasSchemaMismatchError) {
    return { reason: 'daemon-stale', message: error.message }
  }
  return {
    reason: 'probe-failed',
    message: error instanceof Error ? error.message : String(error),
  }
}

/** Capability boundary for the single rolling Canvas implementation. */
export function CanvasBootstrap({
  client,
  children,
  loading,
  blocked,
}: CanvasBootstrapProps) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<BootstrapState>({ status: 'checking' })

  useEffect(() => {
    let active = true
    void client.getCapabilities().then(
      (capabilities) => {
        if (!active) return
        if (capabilities.initializationRequired) {
          setState({ status: 'blocked', failure: { reason: 'daemon-incompatible' } })
        } else {
          setState({ status: 'ready' })
        }
      },
      (error: unknown) => {
        if (!active) return
        setState({
          status: 'blocked',
          failure: canvasBootstrapFailureFromError(error),
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
      Canvas 暂不可用。请重启本地应用后重试。
    </main>
  )
}
