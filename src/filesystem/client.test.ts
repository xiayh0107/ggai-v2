import { describe, expect, it, vi } from 'vitest'
import { FilesystemClient } from './client'

describe('FilesystemClient', () => {
  it('saves a binding with an empty semantic-free request body', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain('/filesystem/bindings/binding-test/save')
      expect(init).toEqual(expect.objectContaining({ method: 'POST', body: '{}' }))
      return Response.json({
        schemaVersion: 1,
        binding: { bindingId: 'binding-test', state: 'clean' },
      })
    })
    const client = new FilesystemClient('http://daemon.test', fetch)
    await expect(client.save('.', 'main', 'binding-test')).resolves.toMatchObject({ state: 'clean' })
  })
})
