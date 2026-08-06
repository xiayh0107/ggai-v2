import { runArtifactMetadataUrl, runArtifactUrl } from './config'
import type { TrustedArtifactProjectionV2 } from '@/plugins/types'

export interface LoadArtifactProjectionV2Input {
  runId: string
  artifactId: string
  projectDir: string
  title: string
  signal?: AbortSignal
  fetch?: typeof globalThis.fetch
}

/** Loads only daemon-verified manifest metadata; artifact bytes remain lazy. */
export async function loadArtifactProjectionV2(
  input: LoadArtifactProjectionV2Input,
): Promise<TrustedArtifactProjectionV2> {
  const fetchImplementation = input.fetch ?? globalThis.fetch
  const response = await fetchImplementation(runArtifactMetadataUrl(
    input.runId,
    input.artifactId,
    input.projectDir,
  ), { signal: input.signal })
  if (!response.ok) throw new Error(`artifact metadata request failed (${response.status})`)
  const value: unknown = await response.json()
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'schemaVersion',
      'runId',
      'artifactId',
      'mediaType',
      'size',
      'contentDigest',
    ])
    || value.schemaVersion !== 2
    || value.runId !== input.runId
    || value.artifactId !== input.artifactId
    || typeof value.mediaType !== 'string'
    || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+*-]+$/u.test(value.mediaType)
    || !Number.isSafeInteger(value.size)
    || (value.size as number) < 0
    || typeof value.contentDigest !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.contentDigest)) {
    throw new TypeError('artifact metadata response is invalid')
  }
  return {
    runId: input.runId,
    artifactId: input.artifactId,
    mediaType: value.mediaType,
    size: value.size as number,
    contentDigest: value.contentDigest,
    title: input.title,
    url: runArtifactUrl(input.runId, input.artifactId, input.projectDir),
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
