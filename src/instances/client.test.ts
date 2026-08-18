import { describe, expect, it, vi } from 'vitest'
import { InstanceClient } from './client'

describe('InstanceClient', () => {
  it('loads only resolved data for an opaque instance identity', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('/instances/instance/resolved')
      return Response.json({ schemaVersion: 1, resolved: { nodes: [], edges: [] } })
    })
    const client = new InstanceClient('http://daemon.test', fetch)
    await expect(client.resolved({ projectDir: '.', branch: 'main', nodeId: 'instance' }))
      .resolves.toEqual({ nodes: [], edges: [] })
  })
})
