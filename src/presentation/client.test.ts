import { describe, expect, it, vi } from 'vitest'
import { PresentationExportClient } from './client'

describe('PresentationExportClient', () => {
  it('submits only presentation identity and export mode', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain('/exports/pptx')
      expect(JSON.parse(String(init?.body))).toEqual({
        presentationNodeId: 'presentation', mode: 'hybrid',
      })
      return Response.json({
        schemaVersion: 1,
        export: {
          runId: 'export-run',
          pptx: { runId: 'export-run', artifactId: `artifact_${'a'.repeat(64)}` },
          diagnostics: { runId: 'export-run', artifactId: `artifact_${'b'.repeat(64)}` },
          provenance: { runId: 'export-run', artifactId: `artifact_${'c'.repeat(64)}` },
          diagnosticCount: 0,
        },
      })
    })
    const client = new PresentationExportClient('http://daemon.test', fetch)
    await expect(client.export({
      projectDir: '.', branch: 'main', presentationNodeId: 'presentation', mode: 'hybrid',
    })).resolves.toMatchObject({ runId: 'export-run' })
  })
})
