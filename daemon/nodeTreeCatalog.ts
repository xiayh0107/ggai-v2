import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import {
  NODE_TREE_DEFINITION_SCHEMA_VERSION,
  type NodeTreeDefinition,
} from '../src/instances/contracts.js'
import { atomicWriteText, isNodeError } from './atomic-file.js'
import { canonicalizePotentialPath, isPathWithin } from './permissions.js'

const MAX_CATALOG_BYTES = 64 * 1024 * 1024
const MAX_DEFINITIONS = 2_000

interface CatalogDocument {
  schemaVersion: 1
  definitions: NodeTreeDefinition[]
}

export class NodeTreeCatalog {
  readonly projectRoot: string
  readonly filePath: string
  #tail: Promise<void> = Promise.resolve()

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot)
    this.filePath = path.join(this.projectRoot, '.gg', 'workspace', 'node-tree-definitions.json')
  }

  list(): Promise<NodeTreeDefinition[]> {
    return this.#exclusive(async () => structuredClone((await this.#read()).definitions))
  }

  get(definitionId: string, revision?: number): Promise<NodeTreeDefinition | null> {
    return this.#exclusive(async () => {
      const matches = (await this.#read()).definitions
        .filter((definition) => definition.definitionId === definitionId
          && (revision === undefined || definition.revision === revision))
        .sort((left, right) => right.revision - left.revision)
      return matches[0] ? structuredClone(matches[0]) : null
    })
  }

  append(input: Omit<NodeTreeDefinition, 'schemaVersion' | 'revision' | 'digest' | 'createdAt'> & {
    expectedRevision: number
  }): Promise<NodeTreeDefinition> {
    return this.#exclusive(async () => {
      const document = await this.#read()
      const latest = document.definitions
        .filter((definition) => definition.definitionId === input.definitionId)
        .sort((left, right) => right.revision - left.revision)[0]
      if ((latest?.revision ?? 0) !== input.expectedRevision) {
        throw new TypeError('NodeTreeDefinition revision conflict')
      }
      const unsigned = {
        schemaVersion: NODE_TREE_DEFINITION_SCHEMA_VERSION,
        definitionId: input.definitionId,
        revision: input.expectedRevision + 1,
        title: input.title,
        rootKey: input.rootKey,
        nodes: structuredClone(input.nodes),
        edges: structuredClone(input.edges),
        overrideAllowlist: [...input.overrideAllowlist],
        exposedPorts: structuredClone(input.exposedPorts),
        createdAt: new Date().toISOString(),
      }
      const definition: NodeTreeDefinition = {
        ...unsigned,
        digest: definitionDigest(unsigned),
      }
      validateDefinition(definition)
      if (document.definitions.length >= MAX_DEFINITIONS) {
        throw new TypeError('NodeTreeDefinition catalog is full')
      }
      document.definitions.push(definition)
      await this.#write(document)
      return structuredClone(definition)
    })
  }

  async #read(): Promise<CatalogDocument> {
    await this.#assertSafePath()
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
      const info = await handle.stat()
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_CATALOG_BYTES) {
        throw new Error('NodeTreeDefinition catalog is unsafe or too large')
      }
      const value = JSON.parse(await handle.readFile('utf8')) as unknown
      if (!isRecord(value) || value.schemaVersion !== 1
        || !Array.isArray(value.definitions) || value.definitions.length > MAX_DEFINITIONS) {
        throw new Error('NodeTreeDefinition catalog is invalid')
      }
      const definitions = value.definitions.map((definition) => {
        validateDefinition(definition)
        return structuredClone(definition) as NodeTreeDefinition
      })
      const identities = definitions.map((definition) =>
        `${definition.definitionId}\0${definition.revision}`)
      if (new Set(identities).size !== identities.length) {
        throw new Error('NodeTreeDefinition catalog has duplicate revisions')
      }
      return { schemaVersion: 1, definitions }
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return { schemaVersion: 1, definitions: [] }
      throw error
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  async #write(document: CatalogDocument): Promise<void> {
    document.definitions.sort((left, right) =>
      left.definitionId.localeCompare(right.definitionId) || left.revision - right.revision)
    const text = `${JSON.stringify(document, null, 2)}\n`
    if (Buffer.byteLength(text) > MAX_CATALOG_BYTES) throw new Error('NodeTreeDefinition catalog is too large')
    await atomicWriteText(this.filePath, text)
  }

  async #assertSafePath(): Promise<void> {
    const canonicalRoot = await realpath(this.projectRoot)
    const canonicalFile = await canonicalizePotentialPath(this.filePath)
    if (canonicalRoot !== this.projectRoot || canonicalFile !== this.filePath
      || !isPathWithin(canonicalRoot, canonicalFile)) {
      throw new Error('NodeTreeDefinition catalog path is unsafe')
    }
    try {
      const info = await lstat(this.filePath)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('NodeTreeDefinition catalog is not a file')
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation)
    this.#tail = result.then(() => undefined, () => undefined)
    return result
  }
}

export function validateDefinition(value: unknown): asserts value is NodeTreeDefinition {
  if (!isRecord(value) || value.schemaVersion !== NODE_TREE_DEFINITION_SCHEMA_VERSION
    || typeof value.definitionId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(value.definitionId)
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
    || typeof value.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(value.digest)
    || typeof value.title !== 'string' || value.title.length < 1 || value.title.length > 240
    || typeof value.rootKey !== 'string' || !Array.isArray(value.nodes)
    || value.nodes.length < 1 || value.nodes.length > 256
    || !Array.isArray(value.edges) || value.edges.length > 512
    || !Array.isArray(value.overrideAllowlist) || value.overrideAllowlist.length > 256
    || !Array.isArray(value.exposedPorts) || value.exposedPorts.length > 128
    || typeof value.createdAt !== 'string') {
    throw new TypeError('NodeTreeDefinition envelope is invalid')
  }
  const { digest, ...unsigned } = value
  if (definitionDigest(unsigned) !== digest) throw new TypeError('NodeTreeDefinition digest does not match')
  const nodes = value.nodes as Array<Record<string, unknown>>
  const keys = new Set(nodes.map((node) => String(node.key)))
  if (keys.size !== nodes.length || !keys.has(value.rootKey)) throw new TypeError('NodeTreeDefinition keys are invalid')
  for (const node of nodes) {
    if (typeof node.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(node.key)
      || (node.parentKey !== null && (typeof node.parentKey !== 'string' || !keys.has(node.parentKey)))) {
      throw new TypeError('NodeTreeDefinition parent relation is invalid')
    }
  }
  for (const node of nodes) {
    const seen = new Set<string>()
    let cursor = node
    while (cursor.parentKey !== null) {
      if (seen.has(String(cursor.key))) throw new TypeError('NodeTreeDefinition contains a cycle')
      seen.add(String(cursor.key))
      cursor = nodes.find((candidate) => candidate.key === cursor.parentKey)!
    }
  }
  if (value.overrideAllowlist.some((entry) => typeof entry !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*:(?:title|text|payload\.[A-Za-z0-9][A-Za-z0-9._:-]*)$/u.test(entry))) {
    throw new TypeError('NodeTreeDefinition override allowlist is invalid')
  }
  if (value.exposedPorts.some((port) => !isRecord(port)
    || typeof port.key !== 'string' || typeof port.nodeKey !== 'string' || !keys.has(port.nodeKey)
    || typeof port.port !== 'string' || (port.direction !== 'input' && port.direction !== 'output')
    || typeof port.schema !== 'string')) {
    throw new TypeError('NodeTreeDefinition exposed ports are invalid')
  }
}

function definitionDigest(value: unknown): string {
  return createHash('sha256').update('ggai.node-tree-definition.v1\0')
    .update(JSON.stringify(value)).digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
