export const DAEMON_URL = import.meta.env.VITE_GGAI_DAEMON_URL?.trim()
  || 'http://127.0.0.1:7380'
export const DAEMON_AGENT_ID = import.meta.env.VITE_GGAI_AGENT_ID?.trim() || 'codex'

export function artifactUrl(
  artifactPath: string,
  projectDir: string,
): string {
  const url = new URL('/artifacts', DAEMON_URL)
  url.searchParams.set('projectDir', projectDir)
  url.searchParams.set('path', artifactPath)
  return url.toString()
}

export function runArtifactUrl(
  runId: string,
  artifactId: string,
  projectDir: string,
): string {
  const url = new URL(
    `/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
    DAEMON_URL,
  )
  url.searchParams.set('projectDir', projectDir)
  return url.toString()
}

export function runArtifactMetadataUrl(
  runId: string,
  artifactId: string,
  projectDir: string,
): string {
  const url = new URL(
    `/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/metadata`,
    DAEMON_URL,
  )
  url.searchParams.set('projectDir', projectDir)
  return url.toString()
}
