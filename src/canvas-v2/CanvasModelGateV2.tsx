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

export type CanvasV2IncompatibilityReason = 'unsupported' | 'probe-failed'

export function CanvasModelGateV2(props: CanvasModelGateV2Props) {
  if (!props.frontendEnabled) return props.legacy
  return <EnabledCanvasModelGateV2 {...props} />
}

function EnabledCanvasModelGateV2({
  client,
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
        if (active) setMode(capabilities.canvasModelV2 ? 'ready' : 'unsupported')
      },
      () => {
        if (active) setMode('probe-failed')
      },
    )
    return () => {
      active = false
    }
  }, [client])

  if (mode === 'checking') return loading ?? null
  if (mode === 'ready') return next
  return incompatible?.(mode) ?? <DefaultCanvasV2Incompatibility reason={mode} />
}

function DefaultCanvasV2Incompatibility({ reason }: { reason: CanvasV2IncompatibilityReason }) {
  return (
    <main role="alert">
      Canvas V2 已启用，但 daemon
      {reason === 'unsupported' ? ' 不支持 canvasModelV2。' : ' 能力探测失败。'}
    </main>
  )
}
