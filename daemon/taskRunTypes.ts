import { createHash } from 'node:crypto'
import type {
  CanvasArtifactRef,
  CanvasDocument,
} from '../src/canvas/model.js'
import type { NodeContextProjectionReceipt } from '../src/agent/nodeContextProjection.js'
import type { ProjectionPluginCapabilitySnapshot } from './pluginCapabilities.js'
import type { CreateRunRequest } from './protocol.js'
import type { RunIntent } from './taskRunProtocol.js'
import {
  canonicalSkillAssetRef,
  isNodeTypeId,
  type SkillAssetRef,
} from '../src/skills/contracts.js'
import type { ResolvedSkillAssetFile } from './skillAssets.js'

const MAX_RUN_SKILL_BYTES = 8 * 1024 * 1024

export interface ResolvedArtifactAttachment {
  runId: string
  artifactId: string
  projectRelativePath: string
  mediaType: string
  size: number
  contentDigest: string
}

/**
 * Explicit Node attachments are immutable snapshots from RunIntent.baseRevision.
 * Their semantic content is first projected through the pinned plugin policy,
 * then byte-bounded before it reaches an Agent context pack. Included artifact
 * identities are resolved separately through closed manifests.
 */
export interface ResolvedNodeAttachment {
  id: string
  title: string
  type: string
  text?: string
  payload?: Record<string, unknown>
  artifactRefs: CanvasArtifactRef[]
  contextProjection: NodeContextProjectionReceipt
  truncation: {
    text: boolean
    payload: boolean
  }
}

export type ResolvedSkillSource = {
  kind: 'node'
  nodeId: string
  nodeType: string
  role: 'target' | 'context' | 'attachment'
}

/** Immutable, integrity-checked skill bytes and their explicit Canvas authority. */
export interface ResolvedTaskSkill {
  ref: SkillAssetRef
  title: string
  description: string
  entrypoint: 'SKILL.md'
  files: ResolvedSkillAssetFile[]
  sources: ResolvedSkillSource[]
}

export function resolvedTaskSkillCapabilityDigest(
  skills: readonly Pick<ResolvedTaskSkill, 'ref' | 'title' | 'description' | 'sources'>[],
): string {
  return createHash('sha256')
    .update('ggai.run-skill-capabilities.v1\0', 'utf8')
    .update(JSON.stringify(skills.map((skill) => ({
      ref: skill.ref,
      title: skill.title,
      description: skill.description,
      sources: skill.sources,
    }))), 'utf8')
    .digest('hex')
}

export const EMPTY_SKILL_CAPABILITY_DIGEST = resolvedTaskSkillCapabilityDigest([])

export function pinResolvedTaskSkills(
  value: unknown,
  expectedDigest: unknown,
): ResolvedTaskSkill[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new TypeError('resolved Task skills must be a bounded array')
  }
  const skills = value.map((candidate, index) => pinResolvedTaskSkill(candidate, index))
    .sort((left, right) => left.ref.skillId.localeCompare(right.ref.skillId))
  if (new Set(skills.map((skill) => skill.ref.skillId)).size !== skills.length) {
    throw new TypeError('resolved Task skills contain duplicate ids')
  }
  const totalBytes = skills.reduce(
    (total, skill) => total + skill.files.reduce((skillTotal, file) => skillTotal + file.size, 0),
    0,
  )
  if (totalBytes > MAX_RUN_SKILL_BYTES) {
    throw new TypeError(`resolved Task skills exceed ${MAX_RUN_SKILL_BYTES} bytes`)
  }
  const digest = resolvedTaskSkillCapabilityDigest(skills)
  if (expectedDigest !== digest) {
    throw new TypeError('resolved Task skill capability digest does not match')
  }
  return skills
}

function pinResolvedTaskSkill(value: unknown, index: number): ResolvedTaskSkill {
  if (!isExactRecord(value, [
    'ref', 'title', 'description', 'entrypoint', 'files', 'sources',
  ]) || typeof value.title !== 'string' || value.title.length === 0 || value.title.length > 160
    || typeof value.description !== 'string' || value.description.length > 1_000
    || value.entrypoint !== 'SKILL.md'
    || !Array.isArray(value.files) || value.files.length > 256
    || !Array.isArray(value.sources) || value.sources.length === 0 || value.sources.length > 512) {
    throw new TypeError(`resolved Task skill ${index} is invalid`)
  }
  const ref = canonicalSkillAssetRef(value.ref, `resolvedSkills[${index}].ref`)
  const files = value.files.map((file, fileIndex) => {
    if (!isExactRecord(file, ['relativePath', 'size', 'digest', 'contentBase64'])
      || typeof file.relativePath !== 'string'
      || !isSafeRelativePath(file.relativePath)
      || !Number.isSafeInteger(file.size) || (file.size as number) < 0
      || (file.size as number) > 1024 * 1024
      || typeof file.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(file.digest)
      || typeof file.contentBase64 !== 'string') {
      throw new TypeError(`resolvedSkills[${index}].files[${fileIndex}] is invalid`)
    }
    const content = Buffer.from(file.contentBase64, 'base64')
    if (content.byteLength !== file.size
      || content.toString('base64') !== file.contentBase64
      || createHash('sha256').update(content).digest('hex') !== file.digest) {
      throw new TypeError(`resolvedSkills[${index}].files[${fileIndex}] failed integrity validation`)
    }
    return {
      relativePath: file.relativePath,
      size: file.size as number,
      digest: file.digest,
      contentBase64: file.contentBase64,
    }
  }).sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  if (!files.some((file) => file.relativePath === 'SKILL.md')
    || new Set(files.map((file) => file.relativePath)).size !== files.length
    || skillSnapshotDigest(files) !== ref.digest) {
    throw new TypeError(`resolvedSkills[${index}] snapshot digest does not match`)
  }
  const sources = value.sources.map((source, sourceIndex): ResolvedSkillSource => {
    if (!isExactRecord(source, ['kind', 'nodeId', 'nodeType', 'role'])
      || source.kind !== 'node'
      || !isCanvasNodeId(source.nodeId)
      || !isNodeTypeId(source.nodeType)
      || (source.role !== 'target' && source.role !== 'context' && source.role !== 'attachment')) {
      throw new TypeError(`resolvedSkills[${index}].sources[${sourceIndex}] is invalid`)
    }
    return {
      kind: 'node',
      nodeId: source.nodeId,
      nodeType: source.nodeType,
      role: source.role,
    }
  }).sort((left, right) =>
    left.nodeId.localeCompare(right.nodeId) || left.role.localeCompare(right.role))
  const sourceKeys = sources.map((source) => `${source.nodeId}\0${source.nodeType}\0${source.role}`)
  if (new Set(sourceKeys).size !== sourceKeys.length) {
    throw new TypeError(`resolvedSkills[${index}].sources contains duplicates`)
  }
  return {
    ref,
    title: value.title,
    description: value.description,
    entrypoint: 'SKILL.md',
    files,
    sources,
  }
}

function skillSnapshotDigest(
  files: readonly { relativePath: string; contentBase64: string }[],
): string {
  const hash = createHash('sha256').update('ggai.skill-asset.v1\0', 'utf8')
  for (const file of files) {
    const content = Buffer.from(file.contentBase64, 'base64')
    hash.update(`${Buffer.byteLength(file.relativePath, 'utf8')}:`, 'utf8')
    hash.update(file.relativePath, 'utf8')
    hash.update(`:${content.byteLength}:`, 'utf8')
    hash.update(content)
  }
  return hash.digest('hex')
}

function isSafeRelativePath(value: string): boolean {
  return value.length > 0
    && !value.startsWith('/')
    && !value.includes('\\')
    && value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
}

function isCanvasNodeId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 160
    && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(value)
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

export const MAX_RESOLVED_NODE_ATTACHMENT_TEXT_BYTES = 128 * 1024
export const MAX_RESOLVED_NODE_ATTACHMENT_PAYLOAD_BYTES = 128 * 1024
export const MAX_RESOLVED_NODE_ATTACHMENT_CONTENT_BYTES = 1024 * 1024
export const MAX_RESOLVED_NODE_ATTACHMENT_ARTIFACT_REFS = 2_000

/** RunIntent after the daemon has pinned and validated its persisted Canvas revision. */
export interface ResolvedTaskRunRequest extends RunIntent {
  projectDir: string
  canvasDocument: CanvasDocument
  resolvedArtifactAttachments: ResolvedArtifactAttachment[]
  resolvedNodeAttachments: ResolvedNodeAttachment[]
  resolvedSkills: ResolvedTaskSkill[]
  /** Digest of refs, display metadata, and authority sources fixed at Run acceptance. */
  skillCapabilityDigest: string
  /** Daemon-resolved immutable registry. Absent callers are pinned to built-ins at acceptance. */
  pluginCapabilities?: ProjectionPluginCapabilitySnapshot
  automationMode: 'confirm'
}

/** Internal-only declarative node design Run. It is never accepted by the retired standalone HTTP API. */
export interface NodeStudioRunRequest extends CreateRunRequest {
  executionKind: 'node-studio'
  baseDefinitionId: string
  baseDefinitionRevision: number
}

export type RunExecutionRequest =
  | CreateRunRequest
  | NodeStudioRunRequest
  | ResolvedTaskRunRequest

export function isResolvedTaskRunRequest(
  request: RunExecutionRequest,
): request is ResolvedTaskRunRequest {
  return 'schemaVersion' in request
    && request.schemaVersion === 2
    && 'taskId' in request
    && 'canvasDocument' in request
}

export function isNodeStudioRunRequest(
  request: RunExecutionRequest,
): request is NodeStudioRunRequest {
  return 'executionKind' in request && request.executionKind === 'node-studio'
}

export function runTargetId(request: RunExecutionRequest): string {
  return isResolvedTaskRunRequest(request) ? request.taskId : request.nodeId
}

export function requestedRunSessionId(request: RunExecutionRequest): string | null {
  return isResolvedTaskRunRequest(request) ? null : request.sessionId ?? null
}
