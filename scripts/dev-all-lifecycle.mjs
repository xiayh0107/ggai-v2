import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

/** Must match `CanvasDaemonCapabilities.schemaVersion` in src/canvas/daemonClient.ts. */
export const EXPECTED_CANVAS_SCHEMA_VERSION = 3
export const WORKSPACE_DAEMON_LOCK_RELATIVE = path.join(
  '.gg',
  'workspace',
  'runtime',
  'daemon.lock',
)

export function parseDaemonHealth(value) {
  if (!isRecord(value) || !isRecord(value.capabilities) || !isRecord(value.canvas)) return null
  const schemaVersion = value.canvas.schemaVersion
  const projectRoot = value.projectRoot
  const initializationRequired = value.canvas.initializationRequired
  if (value.capabilities.canvas !== true
    || !Number.isSafeInteger(schemaVersion)
    || typeof projectRoot !== 'string'
    || projectRoot.length === 0
    || (initializationRequired !== undefined && typeof initializationRequired !== 'boolean')) {
    return null
  }
  return {
    schemaVersion,
    projectRoot,
    initializationRequired: initializationRequired === true,
  }
}

export function isCurrentCanvasHealth(health) {
  return health !== null
    && health.schemaVersion === EXPECTED_CANVAS_SCHEMA_VERSION
    && health.initializationRequired === false
}

export function sameProjectRoot(left, right) {
  return resolveProjectRoot(left) === resolveProjectRoot(right)
}

export function classifyDaemonOccupant(probe, projectRoot) {
  if (probe.kind === 'empty') return { action: 'start' }
  if (probe.kind !== 'ggai') {
    return {
      action: 'abort',
      message: '该端口已被其他本地服务占用，请先停止它，或设置 GGAI_DAEMON_PORT 后再运行 npm run dev。',
    }
  }
  if (!sameProjectRoot(probe.health.projectRoot, projectRoot)) {
    return {
      action: 'abort',
      message: `该端口上的 daemon 属于另一个项目（${probe.health.projectRoot}），不会自动替换。`,
    }
  }
  return {
    action: 'replace',
    health: probe.health,
    reason: isCurrentCanvasHealth(probe.health) ? 'owned' : 'stale',
  }
}

export function parseLeasePid(contents) {
  let value
  try {
    value = JSON.parse(String(contents))
  } catch {
    return null
  }
  if (!isRecord(value) || !Number.isSafeInteger(value.pid) || value.pid <= 1) return null
  return value.pid
}

export function readWorkspaceDaemonPid(
  projectRoot,
  { exists = existsSync, readFile = readFileSync } = {},
) {
  const filePath = path.join(projectRoot, WORKSPACE_DAEMON_LOCK_RELATIVE)
  if (!exists(filePath)) return null
  try {
    return parseLeasePid(readFile(filePath, 'utf8'))
  } catch {
    return null
  }
}

export async function probeDaemonHealth(
  baseUrl,
  fetchImplementation = globalThis.fetch,
  timeoutMs = 500,
) {
  try {
    const response = await fetchImplementation(new URL('/health', `${baseUrl}/`), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return { kind: 'occupied-unknown', status: response.status }
    const health = parseDaemonHealth(await response.json())
    if (!health) return { kind: 'occupied-unknown', status: response.status }
    return { kind: 'ggai', health }
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return { kind: 'occupied-unknown' }
    }
    return { kind: 'empty' }
  }
}

export async function waitUntilPortFree(probe, {
  sleep = delay,
  timeoutMs = 10_000,
  intervalMs = 100,
} = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await probe()).kind === 'empty') return true
    await sleep(intervalMs)
  }
  return false
}

export async function waitForCurrentDaemon(probe, {
  isDaemonAlive = () => true,
  sleep = delay,
  timeoutMs = 15_000,
  intervalMs = 100,
} = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isDaemonAlive()) {
      throw new Error('daemon 在就绪前退出，请检查上方 [daemon] 日志。')
    }
    const result = await probe()
    if (result.kind === 'ggai' && isCurrentCanvasHealth(result.health)) return result.health
    await sleep(intervalMs)
  }
  throw new Error(`daemon 未在 ${timeoutMs}ms 内提供 Canvas schema ${EXPECTED_CANVAS_SCHEMA_VERSION}。`)
}

export async function stopOwnedDaemon(pid, {
  kill = (target, signal) => process.kill(target, signal),
  isAlive = processIsAlive,
  probe,
  sleep = delay,
  timeoutMs = 10_000,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    throw new Error('无法安全停止占用端口的 daemon：锁文件 PID 无效。')
  }
  if (!isAlive(pid)) return true
  try {
    kill(pid, 'SIGINT')
  } catch (error) {
    if (!isAlive(pid)) return true
    throw error
  }
  return await waitUntilPortFree(probe, { sleep, timeoutMs })
}

function resolveProjectRoot(value) {
  try {
    return realpathSync(value)
  } catch {
    return path.resolve(value)
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
