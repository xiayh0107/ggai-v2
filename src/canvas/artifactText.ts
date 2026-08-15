import { useEffect, useState } from 'react'

export type ArtifactTextState = {
  key: string
  status: 'loading' | 'ready' | 'error' | 'too-large'
  text?: string
}

interface ArtifactTextSource {
  runId: string
  artifactId: string
  contentDigest: string
  size: number
  url: string
}

/** 读取文本类产物内容：超过 maxBytes 不抓取，失败进入 error 态。 */
export function useArtifactText(
  artifact: ArtifactTextSource,
  maxBytes: number,
): ArtifactTextState {
  const artifactKey = `${artifact.runId}:${artifact.artifactId}:${artifact.contentDigest}`
  const [source, setSource] = useState<ArtifactTextState>(() => ({
    key: artifactKey,
    status: artifact.size > maxBytes ? 'too-large' : 'loading',
  }))

  useEffect(() => {
    if (artifact.size > maxBytes) return
    const abort = new AbortController()
    void fetch(artifact.url, { signal: abort.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`artifact content request failed (${response.status})`)
      return response.text()
    }).then(
      (text) => setSource({ key: artifactKey, status: 'ready', text }),
      () => {
        if (!abort.signal.aborted) setSource({ key: artifactKey, status: 'error' })
      },
    )
    return () => abort.abort()
  }, [artifact.size, artifact.url, artifactKey, maxBytes])

  return source.key === artifactKey
    ? source
    : {
        key: artifactKey,
        status: artifact.size > maxBytes ? 'too-large' : 'loading',
      }
}
