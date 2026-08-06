// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  CanvasModelGateV2,
  type CanvasV2CapabilityClient,
  type CanvasV2IncompatibilityReason,
} from './CanvasModelGateV2'
import type { CanvasV2DaemonCapabilities } from './daemonClient'

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
  vi.restoreAllMocks()
})

afterAll(() => {
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

async function renderGate(
  frontendEnabled: boolean,
  client: CanvasV2CapabilityClient,
): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <CanvasModelGateV2
        frontendEnabled={frontendEnabled}
        client={client}
        legacy={<div data-mode="legacy" />}
        next={<div data-mode="v2" />}
        loading={<div data-mode="checking" />}
        incompatible={(reason: CanvasV2IncompatibilityReason) => (
          <div data-mode="incompatible" data-reason={reason} />
        )}
      />,
    )
  })
  return container
}

function capabilities(model: 'v1' | 'v2'): CanvasV2DaemonCapabilities {
  return {
    canvasModelV1: model === 'v1',
    canvasModelV2: model === 'v2',
    model,
    schemaVersion: model === 'v2' ? 2 : 1,
    resetRequired: false,
  }
}

describe('Canvas V2 model gate', () => {
  it('mounts V1 only after confirming that the daemon is also V1', async () => {
    const getCapabilities = vi.fn(async () => capabilities('v1'))
    const host = await renderGate(false, { getCapabilities })

    await vi.waitFor(() => expect(host.querySelector('[data-mode="legacy"]')).not.toBeNull())
    expect(getCapabilities).toHaveBeenCalledOnce()
  })

  it('blocks a V1 frontend from mounting against a V2 daemon', async () => {
    const host = await renderGate(false, {
      getCapabilities: async () => capabilities('v2'),
    })

    await vi.waitFor(() => {
      expect(host.querySelector('[data-mode="incompatible"]')?.getAttribute('data-reason'))
        .toBe('frontend-v1-daemon-v2')
    })
    expect(host.querySelector('[data-mode="legacy"]')).toBeNull()
  })

  it('mounts V2 only after both frontend and daemon capabilities agree', async () => {
    const host = await renderGate(true, {
      getCapabilities: async () => capabilities('v2'),
    })

    await vi.waitFor(() => expect(host.querySelector('[data-mode="v2"]')).not.toBeNull())
    expect(host.querySelector('[data-mode="legacy"]')).toBeNull()
  })

  it('blocks instead of falling back to V1 when the daemon lacks V2', async () => {
    const host = await renderGate(true, {
      getCapabilities: async () => capabilities('v1'),
    })

    await vi.waitFor(() => {
      expect(host.querySelector('[data-mode="incompatible"]')?.getAttribute('data-reason'))
        .toBe('frontend-v2-daemon-v1')
    })
    expect(host.querySelector('[data-mode="legacy"]')).toBeNull()
    expect(host.querySelector('[data-mode="v2"]')).toBeNull()
  })

  it('blocks both stores when the daemon capability probe fails', async () => {
    const host = await renderGate(true, {
      getCapabilities: async () => { throw new Error('offline') },
    })

    await vi.waitFor(() => {
      expect(host.querySelector('[data-mode="incompatible"]')?.getAttribute('data-reason'))
        .toBe('probe-failed')
    })
    expect(host.querySelector('[data-mode="legacy"]')).toBeNull()
    expect(host.querySelector('[data-mode="v2"]')).toBeNull()
  })
})
