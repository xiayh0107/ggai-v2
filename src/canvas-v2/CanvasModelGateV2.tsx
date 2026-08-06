import { useEffect, useState, type ReactNode } from 'react'
import type { CanvasV2DaemonCapabilities } from './daemonClient'

export interface CanvasV2CapabilityClient {
  getCapabilities(): Promise<CanvasV2DaemonCapabilities>
}

export interface CanvasModelGateV2Props {
  frontendEnabled: boolean
  client: CanvasV2CapabilityClient
  legacy: ReactNode
  next: ReactNode
  loading?: ReactNode
  incompatible?: (reason: CanvasV2IncompatibilityReason) => ReactNode
}

export type CanvasV2IncompatibilityReason =
  | 'frontend-v2-daemon-v1'
  | 'frontend-v1-daemon-v2'
  | 'probe-failed'

export function CanvasModelGateV2(props: CanvasModelGateV2Props) {
  return <CheckedCanvasModelGate {...props} />
}

function CheckedCanvasModelGate({
  frontendEnabled,
  client,
  legacy,
  next,
  loading,
  incompatible,
}: CanvasModelGateV2Props) {
  const [mode, setMode] = useState<'checking' | 'ready' | CanvasV2IncompatibilityReason>(
    'checking',
  )

  useEffect(() => {
    let active = true
    void client.getCapabilities().then(
      (capabilities) => {
        if (!active) return
        if (frontendEnabled) {
          setMode(capabilities.model === 'v2' ? 'ready' : 'frontend-v2-daemon-v1')
        } else {
          setMode(capabilities.model === 'v1' ? 'ready' : 'frontend-v1-daemon-v2')
        }
      },
      () => {
        if (active) setMode('probe-failed')
      },
    )
    return () => {
      active = false
    }
  }, [client, frontendEnabled])

  if (mode === 'checking') return loading ?? null
  if (mode === 'ready') return frontendEnabled ? next : legacy
  return incompatible?.(mode) ?? <DefaultCanvasV2Incompatibility reason={mode} />
}

function DefaultCanvasV2Incompatibility({ reason }: { reason: CanvasV2IncompatibilityReason }) {
  return (
    <main role="alert">
      Canvas V2 已启用，但 daemon
      {reason === 'frontend-v2-daemon-v1'
        ? ' 正在运行 Canvas V1。'
        : reason === 'frontend-v1-daemon-v2'
          ? ' 已切换到 Canvas V2，而前端仍是 V1。'
          : ' 能力探测失败。'}
    </main>
  )
}
