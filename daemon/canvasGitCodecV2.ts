import { createHash } from 'node:crypto'

import {
  parseCanvasDocumentV2,
  type CanvasCollectionV2,
  type CanvasDocumentV2,
  type CanvasEdgeV2,
  type CanvasNodeV2,
  type CanvasReceiptV2,
  type CanvasTaskV2,
} from '../src/canvas-v2/model.js'

export const CANVAS_GIT_IGNORE_V2 = '.DS_Store\n'

export type CanvasGitEntityDomainV2 =
  | 'task'
  | 'node'
  | 'collection'
  | 'edge'
  | 'receipt'

export interface CanvasGitTreeEntryV2 {
  path: string
  content: string
}

export interface CanvasGitTreeReaderV2 {
  paths: readonly string[]
  read(path: string): string | undefined
}

export type CanvasGitCodecV2ErrorCode =
  | 'INVALID_DOCUMENT'
  | 'INVALID_TREE'
  | 'DUPLICATE_PATH'
  | 'MALFORMED_JSON'
  | 'HASH_MISMATCH'

export class CanvasGitCodecV2Error extends Error {
  readonly code: CanvasGitCodecV2ErrorCode
  readonly path?: string

  constructor(
    code: CanvasGitCodecV2ErrorCode,
    message: string,
    options: { path?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'CanvasGitCodecV2Error'
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
} as const satisfies Record<string, CanvasGitEntityDomainV2>

type CanvasGitDirectoryV2 = keyof typeof DIRECTORY_DOMAINS

const ROOT_PATHS = new Set(['.gitignore', 'meta.json'])
const ENTITY_FILE_PATTERN = /^(tasks|nodes|collections|edges|receipts)\/([a-z]+_[0-9a-f]{64}\.json)$/u

/**
 * Returns a filename whose identity is scoped to its entity domain. The full
 * digest avoids exposing user IDs as paths and makes entity renames explicit.
 */
export function canvasGitEntityFileNameV2(
  domain: CanvasGitEntityDomainV2,
  identity: string,
): string {
  if (identity.length === 0) {
    throw new CanvasGitCodecV2Error('INVALID_DOCUMENT', 'Git entity identity must be non-empty')
  }
  const digest = createHash('sha256')
    .update(domain)
    .update('\0')
    .update(identity)
    .digest('hex')
  return `${domain}_${digest}.json`
}

/** Converts a validated Canvas V2 document into a deterministic, data-only Git tree. */
export function encodeCanvasGitTreeV2(
  document: CanvasDocumentV2,
): CanvasGitTreeEntryV2[] {
  let parsed: CanvasDocumentV2
  try {
    parsed = parseCanvasDocumentV2(document)
  } catch (error) {
    throw new CanvasGitCodecV2Error(
      'INVALID_DOCUMENT',
      'Canvas V2 document is not safe to checkpoint',
      { cause: error },
    )
  }

  const entries: CanvasGitTreeEntryV2[] = [
    { path: '.gitignore', content: CANVAS_GIT_IGNORE_V2 },
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
export function readCanvasGitTreeV2(reader: CanvasGitTreeReaderV2): CanvasDocumentV2 {
  const paths = new Set<string>()
  return decodeCanvasGitTreeV2(reader.paths.map((path) => {
    if (paths.has(path)) {
      throw new CanvasGitCodecV2Error(
        'DUPLICATE_PATH',
        `Canvas V2 Git tree contains a duplicate path or digest collision: ${path}`,
        { path },
      )
    }
    if (!isAllowedPath(path)) {
      throw new CanvasGitCodecV2Error(
        'INVALID_TREE',
        `Canvas V2 Git tree contains an unsupported path: ${path}`,
        { path },
      )
    }
    paths.add(path)
    const content = reader.read(path)
    if (content === undefined) {
      throw new CanvasGitCodecV2Error(
        'INVALID_TREE',
        `Canvas V2 Git tree entry is unreadable: ${path}`,
        { path },
      )
    }
    return { path, content }
  }))
}

/** Reassembles and fully validates a Canvas V2 document from normalized tree entries. */
export function decodeCanvasGitTreeV2(
  entries: readonly CanvasGitTreeEntryV2[],
): CanvasDocumentV2 {
  const byPath = indexTreeEntries(entries)
  const gitignore = requirePath(byPath, '.gitignore')
  if (gitignore !== CANVAS_GIT_IGNORE_V2) {
    throw new CanvasGitCodecV2Error(
      'INVALID_TREE',
      'Canvas V2 .gitignore does not match the managed tree contract',
      { path: '.gitignore' },
    )
  }

  const meta = parseJson(requirePath(byPath, 'meta.json'), 'meta.json')
  if (!isExactRecord(meta, ['schemaVersion', 'everCreated'])
    || meta.schemaVersion !== 2
    || typeof meta.everCreated !== 'boolean') {
    throw new CanvasGitCodecV2Error(
      'INVALID_TREE',
      'Canvas V2 Git metadata has an invalid shape or schema version',
      { path: 'meta.json' },
    )
  }

  const tasks: CanvasTaskV2[] = []
  const nodes: CanvasNodeV2[] = []
  const collections: CanvasCollectionV2[] = []
  const edges: CanvasEdgeV2[] = []
  const receipts: CanvasReceiptV2[] = []
  const identities = new Map<CanvasGitEntityDomainV2, Set<string>>()

  for (const [path, content] of byPath) {
    if (ROOT_PATHS.has(path)) continue
    const match = ENTITY_FILE_PATTERN.exec(path)
    if (!match) {
      throw new CanvasGitCodecV2Error(
        'INVALID_TREE',
        `Canvas V2 Git tree contains an unsupported path: ${path}`,
        { path },
      )
    }
    const directory = match[1] as CanvasGitDirectoryV2
    const fileName = match[2]
    const domain = DIRECTORY_DOMAINS[directory]
    if (!fileName.startsWith(`${domain}_`)) {
      throw new CanvasGitCodecV2Error(
        'INVALID_TREE',
        `Canvas V2 entity filename has the wrong type domain: ${path}`,
        { path },
      )
    }

    const value = parseJson(content, path)
    const identity = entityIdentity(domain, value, path)
    const expected = canvasGitEntityFileNameV2(domain, identity)
    if (fileName !== expected) {
      throw new CanvasGitCodecV2Error(
        'HASH_MISMATCH',
        `Canvas V2 entity path does not match its stored identity: ${path}`,
        { path },
      )
    }
    const domainIdentities = identities.get(domain) ?? new Set<string>()
    if (domainIdentities.has(identity)) {
      throw new CanvasGitCodecV2Error(
        'HASH_MISMATCH',
        `Canvas V2 Git tree contains a duplicate identity or digest collision: ${path}`,
        { path },
      )
    }
    domainIdentities.add(identity)
    identities.set(domain, domainIdentities)

    if (domain === 'task') tasks.push(value as CanvasTaskV2)
    else if (domain === 'node') nodes.push(value as CanvasNodeV2)
    else if (domain === 'collection') collections.push(value as CanvasCollectionV2)
    else if (domain === 'edge') edges.push(value as CanvasEdgeV2)
    else receipts.push(value as CanvasReceiptV2)
  }

  const candidate = {
    schemaVersion: 2,
    tasks: tasks.sort(compareById),
    nodes: nodes.sort(compareById),
    collections: collections.sort(compareById),
    edges: edges.sort(compareById),
    receipts: receipts.sort(compareReceipts),
    everCreated: meta.everCreated,
  } satisfies CanvasDocumentV2

  try {
    return parseCanvasDocumentV2(candidate)
  } catch (error) {
    throw new CanvasGitCodecV2Error(
      'INVALID_DOCUMENT',
      'Canvas V2 Git tree failed semantic validation',
      { cause: error },
    )
  }
}

function appendEntities<T>(
  entries: CanvasGitTreeEntryV2[],
  identitiesByPath: Map<string, string>,
  directory: CanvasGitDirectoryV2,
  values: readonly T[],
  identityOf: (value: T) => string,
): void {
  const domain = DIRECTORY_DOMAINS[directory]
  for (const value of values) {
    const identity = identityOf(value)
    const path = `${directory}/${canvasGitEntityFileNameV2(domain, identity)}`
    const previousIdentity = identitiesByPath.get(path)
    if (previousIdentity !== undefined) {
      throw new CanvasGitCodecV2Error(
        'INVALID_DOCUMENT',
        `Canvas V2 entities share a Git path: ${previousIdentity} and ${identity}`,
        { path },
      )
    }
    identitiesByPath.set(path, identity)
    entries.push({ path, content: stableJson(normalizeEntity(domain, value)) })
  }
}

function normalizeEntity(domain: CanvasGitEntityDomainV2, value: unknown): unknown {
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
    throw new CanvasGitCodecV2Error(
      'INVALID_DOCUMENT',
      'Canvas V2 checkpoint contains a value that is not JSON serializable',
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
  entries: readonly CanvasGitTreeEntryV2[],
): Map<string, string> {
  const byPath = new Map<string, string>()
  for (const entry of entries) {
    if (!isExactRecord(entry, ['path', 'content'])
      || typeof entry.path !== 'string'
      || typeof entry.content !== 'string') {
      throw new CanvasGitCodecV2Error(
        'INVALID_TREE',
        'Canvas V2 Git tree entries must contain only string path and content fields',
      )
    }
    if (byPath.has(entry.path)) {
      throw new CanvasGitCodecV2Error(
        'DUPLICATE_PATH',
        `Canvas V2 Git tree contains a duplicate path or digest collision: ${entry.path}`,
        { path: entry.path },
      )
    }
    if (!isAllowedPath(entry.path)) {
      throw new CanvasGitCodecV2Error(
        'INVALID_TREE',
        `Canvas V2 Git tree contains an unsupported path: ${entry.path}`,
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
    throw new CanvasGitCodecV2Error(
      'INVALID_TREE',
      `Canvas V2 Git tree is missing required path: ${path}`,
      { path },
    )
  }
  return content
}

function parseJson(content: string, path: string): unknown {
  try {
    return JSON.parse(content) as unknown
  } catch (error) {
    throw new CanvasGitCodecV2Error(
      'MALFORMED_JSON',
      `Canvas V2 Git tree contains malformed JSON: ${path}`,
      { path, cause: error },
    )
  }
}

function entityIdentity(
  domain: CanvasGitEntityDomainV2,
  value: unknown,
  path: string,
): string {
  if (!isRecord(value)) {
    throw new CanvasGitCodecV2Error(
      'INVALID_TREE',
      `Canvas V2 entity must be a JSON object: ${path}`,
      { path },
    )
  }
  if (domain === 'receipt') {
    if (typeof value.kind !== 'string' || typeof value.planId !== 'string') {
      throw new CanvasGitCodecV2Error(
        'INVALID_TREE',
        `Canvas V2 receipt has no stable identity: ${path}`,
        { path },
      )
    }
    return receiptIdentity(value as Pick<CanvasReceiptV2, 'kind' | 'planId'>)
  }
  if (typeof value.id !== 'string' || value.id.length === 0) {
    throw new CanvasGitCodecV2Error(
      'INVALID_TREE',
      `Canvas V2 entity has no stable identity: ${path}`,
      { path },
    )
  }
  return value.id
}

function receiptIdentity(receipt: Pick<CanvasReceiptV2, 'kind' | 'planId'>): string {
  return `${receipt.kind}\0${receipt.planId}`
}

function compareEntryPath(left: CanvasGitTreeEntryV2, right: CanvasGitTreeEntryV2): number {
  return compareStrings(left.path, right.path)
}

function compareById(left: { id: string }, right: { id: string }): number {
  return compareStrings(left.id, right.id)
}

function compareReceipts(left: CanvasReceiptV2, right: CanvasReceiptV2): number {
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
