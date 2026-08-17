import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'
import {
  CUSTOM_NODE_MANIFEST_SCHEMA_VERSION,
  isCustomNodeManifest,
  validateCustomNodeManifest,
  type CustomNodeManifest,
} from '../src/node-studio/model.js'
import { EMPTY_NODE_PAYLOAD_SCHEMA } from '../src/plugins/nodeTypeContracts.js'
import { atomicWriteText, isNodeError, readExactFileBytes } from './atomic-file.js'
import { NodePayloadSchemaRegistry } from './nodePayloadSchemas.js'
import { snapshotCustomNodeType } from './nodeTypeSnapshots.js'
import type { NodeTypeSnapshot } from '../src/plugins/nodeTypeContracts.js'
import { canonicalizePotentialPath, isPathWithin } from './permissions.js'

const CATALOG_SCHEMA_VERSION = 2
const MAX_DEFINITIONS = 500
const MAX_CATALOG_BYTES = 2 * 1024 * 1024
const PAYLOAD_SCHEMAS = new NodePayloadSchemaRegistry()
PAYLOAD_SCHEMAS.add(EMPTY_NODE_PAYLOAD_SCHEMA)

interface NodeDefinitionDocument {
  schemaVersion: 2
  definitions: CustomNodeManifest[]
}

export class NodeDefinitionCatalog {
  readonly projectRoot: string
  readonly workspaceDir: string
  readonly filePath: string
  #operationTail: Promise<void> = Promise.resolve()

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot)
    this.workspaceDir = path.join(this.projectRoot, '.gg', 'workspace')
    this.filePath = path.join(this.workspaceDir, 'node-definitions.json')
  }

  list(): Promise<CustomNodeManifest[]> {
    return this.#exclusive(async () => structuredClone((await this.#read()).definitions))
  }

  listSnapshots(): Promise<NodeTypeSnapshot[]> {
    return this.#exclusive(async () => (await this.#read()).definitions
      .map(snapshotCustomNodeType))
  }

  upsert(input: unknown): Promise<CustomNodeManifest> {
    return this.#exclusive(async () => {
      const manifest = parseManifest(input)
      const document = await this.#read()
      const latest = document.definitions
        .filter((item) => item.id === manifest.id)
        .sort((left, right) => right.revision - left.revision)[0]
      if ((latest?.revision ?? 0) !== manifest.revision) {
        throw new TypeError('node definition revision conflict')
      }
      const next = { ...manifest, revision: manifest.revision + 1 }
      const definitions = [...document.definitions, next]
      if (definitions.length > MAX_DEFINITIONS) {
        throw new TypeError(`node definition catalog exceeds ${MAX_DEFINITIONS} entries`)
      }
      await this.#write({ schemaVersion: CATALOG_SCHEMA_VERSION, definitions })
      return structuredClone(next)
    })
  }

  delete(id: string): Promise<boolean> {
    return this.#exclusive(async () => {
      const document = await this.#read()
      if (document.definitions.some((item) => item.id === id && item.installed)) {
        throw new TypeError('installed node definitions cannot be deleted')
      }
      const definitions = document.definitions.filter((item) => item.id !== id)
      if (definitions.length === document.definitions.length) return false
      await this.#write({ schemaVersion: CATALOG_SCHEMA_VERSION, definitions })
      return true
    })
  }

  async #read(): Promise<NodeDefinitionDocument> {
    if (!await this.#assertSafeWorkspace(false)) {
      return { schemaVersion: CATALOG_SCHEMA_VERSION, definitions: [] }
    }
    let raw: string
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
      const metadata = await handle.stat()
      if (!metadata.isFile() || metadata.size > MAX_CATALOG_BYTES) {
        throw new TypeError('node definition catalog is not a safe regular file')
      }
      raw = new TextDecoder('utf-8', { fatal: true }).decode(
        await readExactFileBytes(handle, metadata.size, MAX_CATALOG_BYTES),
      )
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        return { schemaVersion: CATALOG_SCHEMA_VERSION, definitions: [] }
      }
      throw error
    } finally {
      await handle?.close().catch(() => undefined)
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_CATALOG_BYTES) {
      throw new TypeError('node definition catalog is too large')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new TypeError('node definition catalog is invalid JSON', { cause: error })
    }
    if (isRecord(parsed) && parsed.schemaVersion === 1 && Array.isArray(parsed.definitions)) {
      await unlinkCurrentCatalog(this.filePath)
      return { schemaVersion: CATALOG_SCHEMA_VERSION, definitions: [] }
    }
    if (!isRecord(parsed)
      || parsed.schemaVersion !== CATALOG_SCHEMA_VERSION
      || !Array.isArray(parsed.definitions)
      || parsed.definitions.length > MAX_DEFINITIONS) {
      throw new TypeError('node definition catalog has an invalid envelope')
    }
    const definitions = parsed.definitions.map(parseManifest)
    if (new Set(definitions.map((item) => `${item.id}@${item.revision}`)).size !== definitions.length) {
      throw new TypeError('node definition catalog contains duplicate revisions')
    }
    return { schemaVersion: CATALOG_SCHEMA_VERSION, definitions }
  }

  async #write(document: NodeDefinitionDocument): Promise<void> {
    const raw = `${JSON.stringify(document, null, 2)}\n`
    if (Buffer.byteLength(raw, 'utf8') > MAX_CATALOG_BYTES) {
      throw new TypeError('node definition catalog is too large')
    }
    await this.#assertSafeWorkspace(true)
    await atomicWriteText(this.filePath, raw)
    await this.#assertSafeWorkspace(false)
  }

  async #assertSafeWorkspace(create: boolean): Promise<boolean> {
    const canonicalProject = await realpath(this.projectRoot)
    const expectedWorkspace = path.join(canonicalProject, '.gg', 'workspace')
    const expectedFile = path.join(expectedWorkspace, 'node-definitions.json')
    const canonicalWorkspace = await canonicalizePotentialPath(this.workspaceDir)
    const canonicalFile = await canonicalizePotentialPath(this.filePath)
    if (canonicalWorkspace !== expectedWorkspace
      || canonicalFile !== expectedFile
      || !isPathWithin(canonicalProject, canonicalWorkspace)
      || !isPathWithin(canonicalWorkspace, canonicalFile)) {
      throw new TypeError('node definition catalog path resolves through a symlink')
    }
    if (create) await mkdir(this.workspaceDir, { recursive: true, mode: 0o700 })
    try {
      const info = await lstat(this.workspaceDir)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new TypeError('node definition workspace must be a real directory')
      }
      return true
    } catch (error) {
      if (!create && isNodeError(error, 'ENOENT')) return false
      throw error
    }
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation, operation)
    this.#operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

async function unlinkCurrentCatalog(filePath: string): Promise<void> {
  const info = await lstat(filePath)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new TypeError('old node definition catalog is not a safe regular file')
  }
  await unlink(filePath)
}

function parseManifest(input: unknown): CustomNodeManifest {
  if (!isCustomNodeManifest(input)) throw new TypeError('node definition manifest is malformed')
  const manifest = structuredClone(input)
  if (manifest.schemaVersion !== CUSTOM_NODE_MANIFEST_SCHEMA_VERSION) {
    throw new TypeError('node definition schema version is unsupported')
  }
  const errors = validateCustomNodeManifest(manifest)
  if (errors.length > 0) throw new TypeError(errors.join('; '))
  const payload = PAYLOAD_SCHEMAS.validate(manifest.initialPayloadSchema, manifest.initialPayload)
  if (!payload.valid) {
    throw new TypeError(`initial payload failed schema validation: ${JSON.stringify(payload.errors)}`)
  }
  return manifest
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
