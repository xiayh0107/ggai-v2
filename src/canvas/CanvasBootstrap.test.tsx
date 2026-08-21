// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  CanvasBootstrap,
  type CanvasBootstrapFailureReason,
  type CanvasCapabilityClient,
} from './CanvasBootstrap'
import {
  CanvasSchemaMismatchError,
  type CanvasDaemonCapabilities,
} from './daemonClient'

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

function capabilities(initializationRequired = false): CanvasDaemonCapabilities {
  return {
    canvas: true,
    schemaVersion: 3,
    initializationRequired,
  }
}

async function renderBoundary(client: CanvasCapabilityClient) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <CanvasBootstrap
        client={client}
        loading={<div data-state="checking" />}
        blocked={(failure, retry) => (
          <div data-state="blocked" data-reason={failure.reason}>
            <span>{failure.message}</span>
            <button type="button" onClick={retry}>重试</button>
          </div>
        )}
      >
        <div data-state="canvas" />
      </CanvasBootstrap>,
    )
  })
  return container
}

function reason(host: HTMLElement): CanvasBootstrapFailureReason | null {
  return host.querySelector('[data-state="blocked"]')
    ?.getAttribute('data-reason') as CanvasBootstrapFailureReason | null
}

describe('Canvas bootstrap', () => {
  it('mounts Canvas after confirming daemon capabilities', async () => {
    const host = await renderBoundary({
      getCapabilities: async () => capabilities(),
    })

    expect(host.querySelector('[data-state="canvas"]')).not.toBeNull()
    expect(host.querySelector('[data-state="blocked"]')).toBeNull()
  })

  it('blocks an incompatible daemon that still reports root initialization', async () => {
    const host = await renderBoundary({
      getCapabilities: async () => capabilities(true),
    })

    expect(reason(host)).toBe('daemon-incompatible')
    expect(host.querySelector('[data-state="canvas"]')).toBeNull()
  })

  it('blocks a leftover daemon that still advertises a stale Canvas schema', async () => {
    const host = await renderBoundary({
      getCapabilities: async () => {
        throw new CanvasSchemaMismatchError(2)
      },
    })

    expect(reason(host)).toBe('daemon-stale')
    expect(host.textContent).toContain('Daemon Canvas schema is 2, expected 3')
    expect(host.querySelector('[data-state="canvas"]')).toBeNull()
  })

  it('keeps both canvas trees unmounted when probing fails and can retry', async () => {
    const getCapabilities = vi.fn()
      .mockRejectedValueOnce(new Error('daemon offline'))
      .mockResolvedValueOnce(capabilities())
    const host = await renderBoundary({ getCapabilities })

    expect(reason(host)).toBe('probe-failed')
    expect(host.textContent).toContain('daemon offline')

    await act(async () => {
      host.querySelector('button')?.click()
    })

    expect(getCapabilities).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[data-state="canvas"]')).not.toBeNull()
  })
})
