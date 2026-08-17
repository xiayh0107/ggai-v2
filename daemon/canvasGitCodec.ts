import { createHash } from 'node:crypto'

import {
  parseCanvasDocument,
  type CanvasCollection,
  type CanvasDocument,
  type CanvasEdge,
  type CanvasNode,
  type CanvasReceipt,
  type CanvasTask,
} from '../src/canvas/model.js'

export const CANVAS_GIT_IGNORE = '.DS_Store\n'

export type CanvasGitEntityDomain =
  | 'task'
  | 'node'
  | 'collection'
  | 'edge'
  | 'receipt'

export interface CanvasGitTreeEntry {
  path: string
  content: string
}

export interface CanvasGitTreeReader {
  paths: readonly string[]
  read(path: string): string | undefined
}

export type CanvasGitCodecErrorCode =
  | 'INVALID_DOCUMENT'
  | 'INVALID_TREE'
  | 'DUPLICATE_PATH'
  | 'MALFORMED_JSON'
  | 'HASH_MISMATCH'

export class CanvasGitCodecError extends Error {
  readonly code: CanvasGitCodecErrorCode
  readonly path?: string

  constructor(
    code: CanvasGitCodecErrorCode,
    message: string,
    options: { path?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'CanvasGitCodecError'
    this.code = code
    this.path = options.path
  }
}

const DIRECTORY_DOMAINS = {
  tasks: 'task',
  nodes: 'node',
  collections: 'collection',
  edges: 'edge',
  receipts: 'receipt',
} as const satisfies Record<string, CanvasGitEntityDomain>

type CanvasGitDirectory = keyof typeof DIRECTORY_DOMAINS

const ROOT_PATHS = new Set(['.gitignore', 'meta.json'])
const ENTITY_FILE_PATTERN = /^(tasks|nodes|collections|edges|receipts)\/([a-z]+_[0-9a-f]{64}\.json)$/u

/**
 * Returns a filename whose identity is scoped to its entity domain. The full
 * digest avoids exposing user IDs as paths and makes entity renames explicit.
 */
export function canvasGitEntityFileName(
  domain: CanvasGitEntityDomain,
  identity: string,
): string {
  if (identity.length === 0) {
    throw new CanvasGitCodecError('INVALID_DOCUMENT', 'Git entity identity must be non-empty')
  }
  const digest = createHash('sha256')
    .update(domain)
    .update('\0')
    .update(identity)
    .digest('hex')
  return `${domain}_${digest}.json`
}

/** Converts a validated Canvas document into a deterministic, data-only Git tree. */
export function encodeCanvasGitTree(
  document: CanvasDocument,
): CanvasGitTreeEntry[] {
  let parsed: CanvasDocument
  try {
    parsed = parseCanvasDocument(document)
  } catch (error) {
    throw new CanvasGitCodecError(
      'INVALID_DOCUMENT',
      'Canvas document is not safe to checkpoint',
      { cause: error },
    )
  }

  const entries: CanvasGitTreeEntry[] = [
    { path: '.gitignore', content: CANVAS_GIT_IGNORE },
    {
      path: 'meta.json',
      content: stableJson({
        schemaVersion: parsed.schemaVersion,
        everCreated: parsed.everCreated,
      }),
    },
  ]
  const identitiesByPath = new Map<string, string>()

  appendEntities(entries, identitiesByPath, 'tasks', parsed.tasks, (task) => task.id)
  appendEntities(entries, identitiesByPath, 'nodes', parsed.nodes, (node) => node.id)
  appendEntities(
    entries,
    identitiesByPath,
    'collections',
    parsed.collections,
    (collection) => collection.id,
  )
  appendEntities(entries, identitiesByPath, 'edges', parsed.edges, (edge) => edge.id)
  appendEntities(
    entries,
    identitiesByPath,
    'receipts',
    parsed.receipts,
    receiptIdentity,
  )

  return entries.sort(compareEntryPath)
}

/** Reads an already-enumerated tree without performing filesystem or Git I/O. */
export function readCanvasGitTree(reader: CanvasGitTreeReader): CanvasDocument {
  const paths = new Set<string>()
  return decodeCanvasGitTree(reader.paths.map((path) => {
    if (paths.has(path)) {
      throw new CanvasGitCodecError(
        'DUPLICATE_PATH',
        `Canvas Git tree contains a duplicate path or digest collision: ${path}`,
        { path },
      )
    }
    if (!isAllowedPath(path)) {
      throw new CanvasGitCodecError(
        'INVALID_TREE',
        `Canvas Git tree contains an unsupported path: ${path}`,
        { path },
      )
    }
    paths.add(path)
    const content = reader.read(path)
    if (content === undefined) {
      throw new CanvasGitCodecError(
        'INVALID_TREE',
        `Canvas Git tree entry is unreadable: ${path}`,
        { path },
      )
    }
    return { path, content }
  }))
}

/** Reassembles and fully validates a Canvas document from normalized tree entries. */
export function decodeCanvasGitTree(
  entries: readonly CanvasGitTreeEntry[],
): CanvasDocument {
  const byPath = indexTreeEntries(entries)
  const gitignore = requirePath(byPath, '.gitignore')
  if (gitignore !== CANVAS_GIT_IGNORE) {
    throw new CanvasGitCodecError(
      'INVALID_TREE',
      'Canvas .gitignore does not match the managed tree contract',
      { path: '.gitignore' },
    )
  }

  const meta = parseJson(requirePath(byPath, 'meta.json'), 'meta.json')
  if (!isExactRecord(meta, ['schemaVersion', 'everCreated'])
    || meta.schemaVersion !== 3
    || typeof meta.everCreated !== 'boolean') {
    throw new CanvasGitCodecError(
      'INVALID_TREE',
      'Canvas Git metadata has an invalid shape or schema version',
      { path: 'meta.json' },
    )
  }

  const tasks: CanvasTask[] = []
  const nodes: CanvasNode[] = []
  const collections: CanvasCollection[] = []
  const edges: CanvasEdge[] = []
  const receipts: CanvasReceipt[] = []
  const identities = new Map<CanvasGitEntityDomain, Set<string>>()

  for (const [path, content] of byPath) {
    if (ROOT_PATHS.has(path)) continue
    const match = ENTITY_FILE_PATTERN.exec(path)
    if (!match) {
      throw new CanvasGitCodecError(
        'INVALID_TREE',
        `Canvas Git tree contains an unsupported path: ${path}`,
        { path },
      )
    }
    const directory = match[1] as CanvasGitDirectory
    const fileName = match[2]
    const domain = DIRECTORY_DOMAINS[directory]
    if (!fileName.startsWith(`${domain}_`)) {
      throw new CanvasGitCodecError(
        'INVALID_TREE',
        `Canvas entity filename has the wrong type domain: ${path}`,
        { path },
      )
    }

    const value = parseJson(content, path)
    const identity = entityIdentity(domain, value, path)
    const expected = canvasGitEntityFileName(domain, identity)
    if (fileName !== expected) {
      throw new CanvasGitCodecError(
        'HASH_MISMATCH',
        `Canvas entity path does not match its stored identity: ${path}`,
        { path },
      )
    }
    const domainIdentities = identities.get(domain) ?? new Set<string>()
    if (domainIdentities.has(identity)) {
      throw new CanvasGitCodecError(
        'HASH_MISMATCH',
        `Canvas Git tree contains a duplicate identity or digest collision: ${path}`,
        { path },
      )
    }
    domainIdentities.add(identity)
    identities.set(domain, domainIdentities)

    if (domain === 'task') tasks.push(value as CanvasTask)
    else if (domain === 'node') nodes.push(value as CanvasNode)
    else if (domain === 'collection') collections.push(value as CanvasCollection)
    else if (domain === 'edge') edges.push(value as CanvasEdge)
    else receipts.push(value as CanvasReceipt)
  }

  const candidate = {
    schemaVersion: 3,
    tasks: tasks.sort(compareById),
    nodes: nodes.sort(compareById),
    collections: collections.sort(compareById),
    edges: edges.sort(compareById),
    receipts: receipts.sort(compareReceipts),
    everCreated: meta.everCreated,
  } satisfies CanvasDocument

  try {
    return parseCanvasDocument(candidate)
  } catch (error) {
    throw new CanvasGitCodecError(
      'INVALID_DOCUMENT',
      'Canvas Git tree failed semantic validation',
      { cause: error },
    )
  }
}

function appendEntities<T>(
  entries: CanvasGitTreeEntry[],
  identitiesByPath: Map<string, string>,
  directory: CanvasGitDirectory,
  values: readonly T[],
  identityOf: (value: T) => string,
): void {
  const domain = DIRECTORY_DOMAINS[directory]
  for (const value of values) {
    const identity = identityOf(value)
    const path = `${directory}/${canvasGitEntityFileName(domain, identity)}`
    const previousIdentity = identitiesByPath.get(path)
    if (previousIdentity !== undefined) {
      throw new CanvasGitCodecError(
        'INVALID_DOCUMENT',
        `Canvas entities share a Git path: ${previousIdentity} and ${identity}`,
        { path },
      )
    }
    identitiesByPath.set(path, identity)
    entries.push({ path, content: stableJson(normalizeEntity(domain, value)) })
  }
}

function normalizeEntity(domain: CanvasGitEntityDomain, value: unknown): unknown {
  const normalized = cloneJson(value)
  if (!isRecord(normalized)) return normalized

  if (domain === 'node' && Array.isArray(normalized.artifactRefs)) {
    normalized.artifactRefs.sort((left, right) => compareArtifactRefs(left, right))
  } else if (domain === 'receipt') {
    if (Array.isArray(normalized.outcomes)) {
      normalized.outcomes.sort((left, right) => compareMapping(left, right, 'outputKey', 'nodeId'))
    }
    if (Array.isArray(normalized.dismissedProposalKeys)) {
      normalized.dismissedProposalKeys.sort(compareUnknownStrings)
    }
    if (Array.isArray(normalized.proposalKeys)) {
      normalized.proposalKeys.sort(compareUnknownStrings)
    }
    if (Array.isArray(normalized.proposals)) {
      normalized.proposals.sort((left, right) =>
        compareMapping(left, right, 'proposalKey', 'taskId'))
    }
  }
  return normalized
}

function cloneJson(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new TypeError('value is not JSON serializable')
    return JSON.parse(serialized) as unknown
  } catch (error) {
    throw new CanvasGitCodecError(
      'INVALID_DOCUMENT',
      'Canvas checkpoint contains a value that is not JSON serializable',
      { cause: error },
    )
  }
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(sortObjectKeys(value), null, 2)}\n`
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareStrings)
      .map((key) => [key, sortObjectKeys(value[key])]),
  )
}

function indexTreeEntries(
  entries: readonly CanvasGitTreeEntry[],
): Map<string, string> {
  const byPath = new Map<string, string>()
  for (const entry of entries) {
    if (!isExactRecord(entry, ['path', 'content'])
      || typeof entry.path !== 'string'
      || typeof entry.content !== 'string') {
      throw new CanvasGitCodecError(
        'INVALID_TREE',
        'Canvas Git tree entries must contain only string path and content fields',
      )
    }
    if (byPath.has(entry.path)) {
      throw new CanvasGitCodecError(
        'DUPLICATE_PATH',
        `Canvas Git tree contains a duplicate path or digest collision: ${entry.path}`,
        { path: entry.path },
      )
    }
    if (!isAllowedPath(entry.path)) {
      throw new CanvasGitCodecError(
        'INVALID_TREE',
        `Canvas Git tree contains an unsupported path: ${entry.path}`,
        { path: entry.path },
      )
    }
    byPath.set(entry.path, entry.content)
  }
  return new Map([...byPath.entries()].sort(([left], [right]) => compareStrings(left, right)))
}

function isAllowedPath(path: string): boolean {
  return ROOT_PATHS.has(path) || ENTITY_FILE_PATTERN.test(path)
}

function requirePath(byPath: Map<string, string>, path: string): string {
  const content = byPath.get(path)
  if (content === undefined) {
    throw new CanvasGitCodecError(
      'INVALID_TREE',
      `Canvas Git tree is missing required path: ${path}`,
      { path },
    )
  }
  return content
}

function parseJson(content: string, path: string): unknown {
  try {
    return JSON.parse(content) as unknown
  } catch (error) {
    throw new CanvasGitCodecError(
      'MALFORMED_JSON',
      `Canvas Git tree contains malformed JSON: ${path}`,
      { path, cause: error },
    )
  }
}

function entityIdentity(
  domain: CanvasGitEntityDomain,
  value: unknown,
  path: string,
): string {
  if (!isRecord(value)) {
    throw new CanvasGitCodecError(
      'INVALID_TREE',
      `Canvas entity must be a JSON object: ${path}`,
      { path },
    )
  }
  if (domain === 'receipt') {
    if (typeof value.kind !== 'string' || typeof value.planId !== 'string') {
      throw new CanvasGitCodecError(
        'INVALID_TREE',
        `Canvas receipt has no stable identity: ${path}`,
        { path },
      )
    }
    return receiptIdentity(value as Pick<CanvasReceipt, 'kind' | 'planId'>)
  }
  if (typeof value.id !== 'string' || value.id.length === 0) {
    throw new CanvasGitCodecError(
      'INVALID_TREE',
      `Canvas entity has no stable identity: ${path}`,
      { path },
    )
  }
  return value.id
}

function receiptIdentity(receipt: Pick<CanvasReceipt, 'kind' | 'planId'>): string {
  return `${receipt.kind}\0${receipt.planId}`
}

function compareEntryPath(left: CanvasGitTreeEntry, right: CanvasGitTreeEntry): number {
  return compareStrings(left.path, right.path)
}

function compareById(left: { id: string }, right: { id: string }): number {
  return compareStrings(left.id, right.id)
}

function compareReceipts(left: CanvasReceipt, right: CanvasReceipt): number {
  return compareStrings(receiptIdentity(left), receiptIdentity(right))
}

function compareArtifactRefs(left: unknown, right: unknown): number {
  const leftKey = isRecord(left) ? `${String(left.runId)}\0${String(left.artifactId)}` : ''
  const rightKey = isRecord(right) ? `${String(right.runId)}\0${String(right.artifactId)}` : ''
  return compareStrings(leftKey, rightKey)
}

function compareMapping(
  left: unknown,
  right: unknown,
  firstKey: string,
  secondKey: string,
): number {
  const leftKey = isRecord(left) ? `${String(left[firstKey])}\0${String(left[secondKey])}` : ''
  const rightKey = isRecord(right) ? `${String(right[firstKey])}\0${String(right[secondKey])}` : ''
  return compareStrings(leftKey, rightKey)
}

function compareUnknownStrings(left: unknown, right: unknown): number {
  return compareStrings(String(left), String(right))
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}
