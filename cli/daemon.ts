import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export interface EnsureDaemonInput {
  baseUrl: string
  fetch: typeof globalThis.fetch
  environment: NodeJS.ProcessEnv
  onStarted?: (url: string) => void
}

interface EnsureDaemonInternals {
  daemonPath?: string
  workingDirectory?: string
  accessFile?: (path: string) => Promise<void>
  spawnProcess?: typeof spawn
  sleep?: (milliseconds: number) => Promise<void>
}

export async function ensureDaemonAvailable(
  input: EnsureDaemonInput,
  internals: EnsureDaemonInternals = {},
): Promise<void> {
  if (await probe(input.baseUrl, input.fetch)) return
  const url = new URL(input.baseUrl)
  if (!isAutoStartable(url)) {
    throw new TypeError(`daemon unavailable at ${input.baseUrl}; automatic start is loopback-only`)
  }
  const daemonPath = internals.daemonPath
    ?? fileURLToPath(new URL('../dist-daemon/daemon/index.js', import.meta.url))
  const workingDirectory = internals.workingDirectory ?? process.cwd()
  const accessFile = internals.accessFile ?? access
  try {
    await accessFile(daemonPath)
  } catch {
    throw new TypeError('daemon executable is missing; run npm run build:daemon')
  }
  const args = [
    daemonPath,
    '--project-root',
    input.environment.GGAI_PROJECT_ROOT?.trim() || workingDirectory,
  ]
  args.push('--port', url.port || '80')
  const child = (internals.spawnProcess ?? spawn)(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    env: input.environment,
  })
  child.unref()
  const sleep = internals.sleep ?? ((milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  }))
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await sleep(100)
    if (await probe(input.baseUrl, input.fetch)) {
      input.onStarted?.(input.baseUrl)
      return
    }
  }
  child.kill()
  throw new TypeError(`daemon did not become ready at ${input.baseUrl}`)
}

async function probe(baseUrl: string, fetchImplementation: typeof globalThis.fetch) {
  try {
    const response = await fetchImplementation(new URL('/health', `${baseUrl}/`), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(500),
    })
    return response.ok
  } catch {
    return false
  }
}

function isAutoStartable(url: URL): boolean {
  return url.protocol === 'http:'
    && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
    && (url.pathname === '/' || url.pathname === '')
    && !url.username
    && !url.password
}
