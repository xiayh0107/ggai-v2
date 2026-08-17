import { describe, expect, it } from 'vitest'
import { emptyCanvasDocument } from '../src/canvas/model'
import { HeadlessCanvasClient } from './canvasClient'

describe('HeadlessCanvasClient', () => {
  it('accepts the daemon checkpoint extension but rejects unknown envelope fields', async () => {
    const envelope = {
      branch: 'main',
      revision: 1,
      updatedAt: '2026-08-17T00:00:00.000Z',
      lastMutationId: null,
      lastCheckpoint: null,
      document: emptyCanvasDocument(),
    }
    const accepted = new HeadlessCanvasClient({
      baseUrl: 'http://daemon.test',
      fetch: async () => new Response(JSON.stringify(envelope), { status: 200 }),
    })
    await expect(accepted.getCanvas({ projectDir: '/project', branch: 'main' }))
      .resolves.toMatchObject({ revision: 1 })

    const rejected = new HeadlessCanvasClient({
      baseUrl: 'http://daemon.test',
      fetch: async () => new Response(JSON.stringify({ ...envelope, leaked: true }), { status: 200 }),
    })
    await expect(rejected.getCanvas({ projectDir: '/project', branch: 'main' }))
      .rejects.toThrow('malformed')
  })
})
