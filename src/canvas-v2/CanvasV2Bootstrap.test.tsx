// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  CanvasV2Bootstrap,
  type CanvasV2BootstrapFailureReason,
  type CanvasV2CapabilityClient,
} from './CanvasV2Bootstrap'
import type { CanvasV2DaemonCapabilities } from './daemonClient'

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  vi.restoreAllMocks()
})

afterAll(() => {
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT
})

function capabilities(model: 'v1' | 'v2', resetRequired = false): CanvasV2DaemonCapabilities {
  return {
    canvasModelV1: model === 'v1',
    canvasModelV2: model === 'v2',
    model,
    schemaVersion: model === 'v2' ? 2 : 1,
    resetRequired,
  }
}

async function renderBoundary(client: CanvasV2CapabilityClient) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <CanvasV2Bootstrap
        client={client}
        loading={<div data-state="checking" />}
        blocked={(failure, retry) => (
          <div data-state="blocked" data-reason={failure.reason}>
            <span>{failure.message}</span>
            <button type="button" onClick={retry}>重试</button>
          </div>
        )}
      >
        <div data-state="v2" />
      </CanvasV2Bootstrap>,
    )
  })
  return container
}

function reason(host: HTMLElement): CanvasV2BootstrapFailureReason | null {
  return host.querySelector('[data-state="blocked"]')
    ?.getAttribute('data-reason') as CanvasV2BootstrapFailureReason | null
}

describe('Canvas V2 bootstrap', () => {
  it('mounts only the V2 tree after confirming V2 daemon capabilities', async () => {
    const host = await renderBoundary({
      getCapabilities: async () => capabilities('v2'),
    })

    expect(host.querySelector('[data-state="v2"]')).not.toBeNull()
    expect(host.querySelector('[data-state="blocked"]')).toBeNull()
  })

  it('blocks an explicitly diagnostic V1 daemon without mounting a legacy tree', async () => {
    const host = await renderBoundary({
      getCapabilities: async () => capabilities('v1'),
    })

    expect(reason(host)).toBe('daemon-v1-diagnostic')
    expect(host.querySelector('[data-state="v2"]')).toBeNull()
    expect(host.querySelector('[data-state="legacy"]')).toBeNull()
  })

  it('distinguishes a missing reset marker from a capability mismatch', async () => {
    const host = await renderBoundary({
      getCapabilities: async () => capabilities('v2', true),
    })

    expect(reason(host)).toBe('reset-required')
    expect(host.querySelector('[data-state="v2"]')).toBeNull()
  })

  it('keeps both canvas trees unmounted when probing fails and can retry', async () => {
    const getCapabilities = vi.fn()
      .mockRejectedValueOnce(new Error('daemon offline'))
      .mockResolvedValueOnce(capabilities('v2'))
    const host = await renderBoundary({ getCapabilities })

    expect(reason(host)).toBe('probe-failed')
    expect(host.textContent).toContain('daemon offline')

    await act(async () => {
      host.querySelector('button')?.click()
    })

    expect(getCapabilities).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[data-state="v2"]')).not.toBeNull()
  })
})
