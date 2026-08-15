import { describe, expect, it, vi } from 'vitest'
import { SkillAssetClient } from './client'

const digest = 'a'.repeat(64)
const importedAt = '2026-08-11T12:00:00.000Z'
const asset = {
  schemaVersion: 1,
  skillId: '@workspace/image-direction',
  revision: 1,
  digest,
  title: 'Image direction',
  description: 'Direct the image Node.',
  entrypoint: 'SKILL.md',
  fileCount: 1,
  totalBytes: 42,
  importedAt,
  archived: false,
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('SkillAssetClient', () => {
  it('uses strict management routes and forwards AbortSignal', async () => {
    const signal = new AbortController().signal
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ schemaVersion: 1, assets: [asset], typeBindings: [] }))
      .mockResolvedValueOnce(jsonResponse({ schemaVersion: 1, asset }))
      .mockResolvedValueOnce(jsonResponse({
        schemaVersion: 1,
        binding: {
          schemaVersion: 1,
          nodeType: 'image',
          revision: 1,
          skills: [{ skillId: asset.skillId, revision: 1, digest }],
          updatedAt: importedAt,
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        schemaVersion: 1,
        archivedSkillId: asset.skillId,
      }))
    const client = new SkillAssetClient({ baseUrl: 'http://127.0.0.1:9444/', fetch })

    await expect(client.list(signal)).resolves.toMatchObject({ assets: [{ title: 'Image direction' }] })
    await expect(client.import({
      sourcePath: '/tmp/image-direction',
      skillId: asset.skillId,
      expectedRevision: 0,
      signal,
    })).resolves.toMatchObject({ revision: 1, digest })
    await expect(client.updateTypeBindings({
      nodeType: 'image',
      expectedRevision: 0,
      skills: [{ skillId: asset.skillId, revision: 1, digest }],
      signal,
    })).resolves.toMatchObject({ nodeType: 'image', revision: 1 })
    await expect(client.archive(asset.skillId, signal)).resolves.toBe(asset.skillId)

    expect(fetch.mock.calls.map(([request]) => String(request))).toEqual([
      'http://127.0.0.1:9444/skill-assets',
      'http://127.0.0.1:9444/skill-assets/import',
      'http://127.0.0.1:9444/skill-bindings/types/image',
      `http://127.0.0.1:9444/skill-assets/${encodeURIComponent(asset.skillId)}`,
    ])
    expect(fetch.mock.calls.every(([, init]) => init?.signal === signal)).toBe(true)
  })

  it('rejects widened envelopes and preserves typed daemon errors', async () => {
    const widened = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({
      schemaVersion: 1,
      assets: [],
      typeBindings: [],
      sourcePath: '/tmp/private',
    }))
    await expect(new SkillAssetClient({ baseUrl: 'http://localhost', fetch: widened }).list())
      .rejects.toThrow(/catalog response is invalid/u)

    const conflict = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({
      error: {
        code: 'skill_asset_conflict',
        message: 'A newer revision exists.',
      },
    }, 409))
    const request = new SkillAssetClient({ baseUrl: 'http://localhost', fetch: conflict })
      .import({
        sourcePath: '/tmp/image-direction',
        skillId: asset.skillId,
        expectedRevision: 0,
      })
    await expect(request).rejects.toMatchObject({
      status: 409,
      code: 'skill_asset_conflict',
      message: 'A newer revision exists.',
    })
  })
})
