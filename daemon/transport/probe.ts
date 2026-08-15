import { spawn } from 'node:child_process'
import { accessSync, constants, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

export interface ProbeResult {
  found: boolean
  code: number | null
  output: string
  binaryPath?: string
}

export interface ProbeRequirement {
  label: string
  options: string[]
}

export function resolveExecutable(command: string): string | undefined {
  const hasPathSeparator = command.includes('/') || command.includes('\\')
  const extensions = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)]
    : ['']
  const directories = hasPathSeparator
    ? ['']
    : (process.env.PATH ?? '').split(path.delimiter)
  const baseCommand = hasPathSeparator ? path.resolve(command) : command

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = hasPathSeparator
        ? `${baseCommand}${extension}`
        : path.resolve(directory || '.', `${baseCommand}${extension}`)
      try {
        accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
        try {
          return realpathSync(candidate)
        } catch {
          return candidate
        }
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return undefined
}

export async function runProbe(
  command: string,
  args: string[],
  timeoutMs = 4_000,
): Promise<ProbeResult> {
  const binaryPath = resolveExecutable(command)
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    let timer: NodeJS.Timeout | null = null
    const child = spawn(binaryPath ?? command, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    })
    const finish = (result: ProbeResult) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ ...result, binaryPath })
    }
    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString('utf8')}`.slice(-16_384)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish({ found: error.code !== 'ENOENT', code: null, output: error.message })
    })
    child.once('close', (code) => finish({ found: true, code, output: output.trim() }))
    timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish({ found: true, code: null, output: 'probe timed out' })
    }, timeoutMs)
    timer.unref()
  })
}

export function lastUsefulLine(output: string): string | undefined {
  return output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).at(-1)
}

export function compatibilityError(
  probes: ProbeResult[],
  requirements: ProbeRequirement[],
): string | undefined {
  const failed = probes.find((probe) => probe.code !== 0)
  if (failed) return failed.output || 'capability probe failed'
  const missing = probes.flatMap((probe, index) => {
    const tokens = new Set(probe.output.match(/--?[A-Za-z0-9][A-Za-z0-9-]*/gu) ?? [])
    return (requirements[index]?.options ?? [])
      .filter((option) => !tokens.has(option))
      .map((option) => `${requirements[index]?.label ?? 'CLI'} ${option}`)
  })
  return missing.length > 0 ? `missing required CLI capabilities: ${missing.join(', ')}` : undefined
}
