import { accessSync, constants } from 'node:fs'
import path from 'node:path'

export const DEFAULT_VITE_HOST = 'localhost'
export const DEFAULT_VITE_PORT = 3000

function parsePort(value) {
  if (!/^\d+$/u.test(value ?? '')) {
    throw new Error(`Vite --port must be an integer from 1 to 65535, received ${value || '(empty)'}`)
  }
  const port = Number(value)
  if (port < 1 || port > 65_535) {
    throw new Error(`Vite --port must be an integer from 1 to 65535, received ${value}`)
  }
  return port
}

/** Parse only the Vite options that determine the browser Origin. */
export function parseViteServerOptions(args) {
  let host = DEFAULT_VITE_HOST
  let port = DEFAULT_VITE_PORT

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--') break

    if (argument === '--port') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) throw new Error('Vite --port requires a value')
      port = parsePort(value)
      index += 1
    } else if (argument.startsWith('--port=')) {
      port = parsePort(argument.slice('--port='.length))
    } else if (argument === '--host') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) host = '0.0.0.0'
      else {
        host = value
        index += 1
      }
    } else if (argument.startsWith('--host=')) {
      host = argument.slice('--host='.length) || '0.0.0.0'
    }
  }

  return { host, port }
}

function originForHost(host, port) {
  const normalized = host.trim().replace(/^\[|\]$/gu, '')
  if (!normalized || /[\s/?#@]/u.test(normalized)) {
    throw new Error(`Vite --host is not a valid hostname: ${host || '(empty)'}`)
  }
  const hostname = normalized.includes(':') ? `[${normalized}]` : normalized
  try {
    return new URL(`http://${hostname}:${port}`).origin
  } catch {
    throw new Error(`Vite --host is not a valid hostname: ${host}`)
  }
}

/** Exact origins that the loopback daemon should accept for this Vite process. */
export function viteBrowserOrigins(args) {
  const { host, port } = parseViteServerOptions(args)
  const origins = new Set([
    originForHost('localhost', port),
    originForHost('127.0.0.1', port),
    originForHost('::1', port),
  ])
  const normalizedHost = host.trim().replace(/^\[|\]$/gu, '')
  if (normalizedHost && normalizedHost !== '::') {
    origins.add(originForHost(normalizedHost, port))
  }
  return [...origins]
}

function isExecutable(filename) {
  try {
    accessSync(filename, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Absolute Codex locations checked when PATH has no usable bin directory. */
const WELL_KNOWN_CODEX_PATHS = [
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
]

/**
 * Reuse an existing Codex installation without installing or copying it.
 * GUI launchers can put a stale /usr/local npm shim before Homebrew in PATH,
 * so prefer a Codex executable managed beside an existing `brew` executable.
 * GUI-launched processes (e.g. a desktop preview starting `npm run dev`) may
 * also have a minimal PATH without any package-manager bin directory, so fall
 * back to well-known absolute install locations before the bare command name.
 * GGAI_CODEX_COMMAND always wins and is the portable explicit override.
 */
export function resolveCodexCommand({
  explicitCommand,
  pathValue = '',
  platform = process.platform,
  executable = isExecutable,
} = {}) {
  const explicit = explicitCommand?.trim()
  if (explicit) return explicit
  if (platform === 'win32') return 'codex'

  const directories = pathValue.split(path.delimiter).filter(Boolean)
  for (const directory of directories) {
    const brew = path.join(directory, 'brew')
    const codex = path.join(directory, 'codex')
    if (executable(brew) && executable(codex)) return codex
  }
  for (const directory of directories) {
    const codex = path.join(directory, 'codex')
    if (executable(codex)) return codex
  }
  if (platform === 'darwin' || platform === 'linux') {
    for (const codex of WELL_KNOWN_CODEX_PATHS) {
      if (executable(codex)) return codex
    }
  }
  return 'codex'
}
