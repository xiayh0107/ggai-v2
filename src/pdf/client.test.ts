import { describe, expect, it, vi } from 'vitest'
import { PdfImportClient } from './client'

describe('PdfImportClient', () => {
  it('requests one lazy page without materializing page nodes', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('page=3')
      return Response.json({
        schemaVersion: 1,
        page: {
          importId: 'pdf_import_test', pageNumber: 3,
          viewport: { width: 612, height: 792, rotation: 0, unit: 'pt' },
          text: { itemCount: 0, summary: '' }, annotations: { count: 0, subtypes: [] },
          preview: { runId: 'preview-run', artifactId: `artifact_${'a'.repeat(64)}` },
        },
      })
    })
    const client = new PdfImportClient('http://daemon.test', fetch)
    await expect(client.page({
      projectDir: '.', importId: 'pdf_import_test', pageNumber: 3,
    })).resolves.toMatchObject({ pageNumber: 3 })
    expect(fetch).toHaveBeenCalledOnce()
  })
})
