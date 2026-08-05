import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { atomicWriteText, isNodeError } from './atomic-file.js'
import { canonicalizePotentialPath, createProjectScope, isPathWithin } from './permissions.js'
import { ProtocolError } from './protocol.js'

export type AutomationMode = 'auto' | 'confirm'

export interface WorkspacePreferences {
  schemaVersion: 1
  automationMode: AutomationMode
}

const DEFAULT_PREFERENCES: WorkspacePreferences = {
  schemaVersion: 1,
  automationMode: 'confirm',
}

export class WorkspacePreferencesManager {
  readonly #projectRoot: string
  readonly #tails = new Map<string, Promise<void>>()
  #closing = false

  constructor(projectRoot: string) {
    this.#projectRoot = path.resolve(projectRoot)
  }

  async get(projectDirRequest = '.'): Promise<WorkspacePreferences> {
    const { projectDir, filePath } = await this.#resolve(projectDirRequest)
    this.#assertOpen()
    await this.#tails.get(projectDir)
    await assertPreferencesPath(projectDir, filePath)
    try {
      return parsePreferences(JSON.parse(await readTextNoFollow(filePath)))
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return { ...DEFAULT_PREFERENCES }
      throw error
    }
  }

  async put(
    projectDirRequest: string,
    input: { automationMode: unknown },
  ): Promise<WorkspacePreferences> {
    const { projectDir, filePath } = await this.#resolve(projectDirRequest)
    this.#assertOpen()
    const preferences = parsePreferences({
      schemaVersion: 1,
      automationMode: input.automationMode,
    })
    const previous = this.#tails.get(projectDir) ?? Promise.resolve()
    const persist = async () => {
      await assertPreferencesPath(projectDir, filePath)
      await atomicWriteText(filePath, `${JSON.stringify(preferences, null, 2)}\n`)
    }
    const next = previous.then(persist, persist)
    this.#tails.set(projectDir, next)
    void next.finally(() => {
      if (this.#tails.get(projectDir) === next) this.#tails.delete(projectDir)
    }).catch(() => undefined)
    await next
    return preferences
  }

  async close(): Promise<void> {
    this.#closing = true
    await Promise.allSettled(this.#tails.values())
  }

  async #resolve(projectDirRequest: string): Promise<{ projectDir: string; filePath: string }> {
    this.#assertOpen()
    const scope = await createProjectScope({
      projectRoot: this.#projectRoot,
      projectDir: projectDirRequest,
    })
    const filePath = path.join(scope.ggDir, 'runtime', 'preferences.json')
    await assertPreferencesPath(scope.projectDir, filePath)
    return {
      projectDir: scope.projectDir,
      filePath,
    }
  }

  #assertOpen(): void {
    if (this.#closing) {
      throw new ProtocolError('daemon is shutting down', 'daemon_shutting_down', 503)
    }
  }
}

async function assertPreferencesPath(projectDir: string, filePath: string): Promise<void> {
  const ggDir = path.join(projectDir, '.gg')
  const [canonicalGgDir, canonicalFile] = await Promise.all([
    canonicalizePotentialPath(ggDir),
    canonicalizePotentialPath(filePath),
  ])
  if (
    canonicalGgDir !== ggDir
    || canonicalFile !== filePath
    || !isPathWithin(ggDir, filePath)
    || !isPathWithin(canonicalGgDir, canonicalFile)
  ) {
    throw new ProtocolError(
      'unsafe managed path .gg/runtime/preferences.json',
      'unsafe_managed_path',
      403,
    )
  }
}

async function readTextNoFollow(filePath: string): Promise<string> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

function parsePreferences(value: unknown): WorkspacePreferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProtocolError('workspace preferences must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1) {
    throw new ProtocolError('workspace preferences schemaVersion must be 1')
  }
  if (record.automationMode !== 'auto' && record.automationMode !== 'confirm') {
    throw new ProtocolError('automationMode must be "auto" or "confirm"')
  }
  return { schemaVersion: 1, automationMode: record.automationMode }
}
