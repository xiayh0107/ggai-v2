import { createHash } from 'node:crypto'
import path from 'node:path'
import {
  inspectRunOutcomeV2,
  type RunOutcomeV2,
  type RunOutputRoleV2,
  type RunTaskProposalV2,
} from '../src/agent/outcomeV2.js'
import type { SuggestedAction } from '../src/agent/outcome.js'
import {
  artifactManifestDigestV1,
  inspectArtifactManifestV1,
  type ArtifactManifestEntryV1,
  type ArtifactManifestV1,
} from './artifactManifestV2.js'
import { parseRunId } from './protocol.js'

export const PROJECTION_PLAN_V2_SCHEMA_VERSION = 2
export const MAX_PROJECTION_PLUGINS_V2 = 500
export const MAX_ARTIFACT_RULES_PER_PLUGIN_V2 = 32
export const MAX_ARTIFACT_MATCHERS_PER_RULE_V2 = 64
export const MAX_PROJECTION_OUTPUTS_V2 = 32
export const MAX_AUTO_MATERIALIZED_OUTPUTS_V2 = 12

export type ProjectionRunStatusV2 = 'done' | 'error' | 'cancelled' | 'interrupted'

export interface ArtifactProjectionRuleV2 {
  extensions?: string[]
  mediaTypes?: string[]
  priority?: number
}

/** Serializable artifact capability; React materializers never cross this boundary. */
export interface ProjectionPluginContractV2 {
  id: string
  artifactRules: ArtifactProjectionRuleV2[]
  /** Explicit generic-file opt-in. It never outranks a typed rule. */
  acceptsUnknown?: boolean
}

/** A browser-safe reference to one daemon-authoritative manifest entry. */
export interface ProjectionArtifactRefV2 {
  runId: string
  artifactId: string
}

/** A trusted semantic output projection; it is not a canvas node patch. */
export interface ProjectionOutputV2 {
  key: string
  pluginId: string
  role: RunOutputRoleV2
  title: string
  artifactRefs: ProjectionArtifactRefV2[]
  derivedFrom: string[]
  materialize: boolean
}

/** A semantic proposal. Trusted canvas code assigns a future task id and layout. */
export type ProjectionTaskProposalV2 = RunTaskProposalV2

/**
 * A daemon-authored materialization plan for exactly one task run.
 *
 * The plan intentionally has no anchor node, collection, entity ids, payload,
 * coordinates, arbitrary edge records, or executable commands.
 */
export interface ProjectionPlanV2 {
  schemaVersion: 2
  planId: string
  runId: string
  taskId: string
  status: 'complete' | 'partial'
  manifestDigest: string
  outputs: ProjectionOutputV2[]
  taskProposals: ProjectionTaskProposalV2[]
  warnings: string[]
  digest: string
}

/** Durable settlement data that is safe to restore without the raw outcome. */
export interface ProjectionSettlementV2 {
  plan: ProjectionPlanV2
  suggestedActions: SuggestedAction[]
}

export interface ProjectionDiagnosticV2 {
  code:
    | 'invalid-outcome'
    | 'missing-artifact'
    | 'unknown-plugin'
    | 'plugin-rejected-artifact'
    | 'missing-parent'
    | 'unclaimed-artifact'
    | 'projection-limit'
    | 'discarded-proposals'
  message: string
  outputKey?: string
  artifactPath?: string
}

export interface BuildProjectionPlanV2Input {
  taskId: string
  runId: string
  runStatus: ProjectionRunStatusV2
  manifest: ArtifactManifestV1
  plugins: readonly ProjectionPluginContractV2[]
  /** Raw Agent value; invalid and unsupported values safely fall back. */
  outcome?: unknown
}

export interface BuildProjectionPlanV2Result {
  plan: ProjectionPlanV2
  diagnostics: ProjectionDiagnosticV2[]
  usedFallback: boolean
  /** Successful-run actions remain settlement data, not materialization commands. */
  suggestedActions: SuggestedAction[]
}

export type ProjectionPlanV2Inspection =
  | { status: 'valid'; plan: ProjectionPlanV2 }
  | { status: 'invalid'; reason: string }

export type ProjectionPluginContractsV2Inspection =
  | { status: 'valid'; plugins: ProjectionPluginContractV2[] }
  | { status: 'invalid'; reason: string }

export function buildProjectionPlanV2(
  input: BuildProjectionPlanV2Input,
): BuildProjectionPlanV2Result {
  const taskId = parseTaskId(input.taskId)
  const runId = parseRunId(input.runId)
  const runStatus = parseProjectionRunStatus(input.runStatus)
  const manifestInspection = inspectArtifactManifestV1(input.manifest)
  if (manifestInspection.status !== 'valid') {
    throw new TypeError(`manifest is invalid: ${manifestInspection.reason}`)
  }
  const manifest = manifestInspection.manifest
  if (manifest.runId !== runId) throw new TypeError('manifest belongs to a foreign run')
  const manifestDigest = artifactManifestDigestV1(manifest)

  const pluginInspection = inspectProjectionPluginContractsV2(input.plugins)
  if (pluginInspection.status !== 'valid') {
    throw new TypeError(`plugins are invalid: ${pluginInspection.reason}`)
  }
  const plugins = pluginInspection.plugins
  const pluginsById = new Map(plugins.map((plugin) => [plugin.id, plugin]))
  const artifactsByPath = new Map(manifest.entries.map((entry) => [entry.relativePath, entry]))
  const claimedArtifacts = new Set<string>()
  const diagnostics: ProjectionDiagnosticV2[] = []
  const outputs: ProjectionOutputV2[] = []

  let outcome: RunOutcomeV2 | undefined
  if (input.outcome !== undefined) {
    const inspection = inspectRunOutcomeV2(input.outcome)
    if (inspection.status === 'valid') outcome = inspection.outcome
    else diagnostics.push({
      code: 'invalid-outcome',
      message: inspection.status === 'invalid'
        ? inspection.reason
        : 'RunOutcome schemaVersion is unsupported',
    })
  }

  if (outcome) {
    for (const hint of outcome.outputs) {
      const artifact = artifactsByPath.get(hint.path)
      if (!artifact) {
        diagnostics.push({
          code: 'missing-artifact',
          message: 'Agent output path was not present in the authoritative manifest',
          outputKey: hint.key,
          artifactPath: hint.path,
        })
        continue
      }
      const plugin = pluginsById.get(hint.pluginId)
      if (!plugin) {
        diagnostics.push({
          code: 'unknown-plugin',
          message: 'Agent output named a plugin outside this run contract',
          outputKey: hint.key,
          artifactPath: hint.path,
        })
        continue
      }
      if (matchPlugin(plugin, artifact) === null) {
        diagnostics.push({
          code: 'plugin-rejected-artifact',
          message: 'Agent output did not match the declared plugin artifact rules',
          outputKey: hint.key,
          artifactPath: hint.path,
        })
        continue
      }
      claimedArtifacts.add(artifact.artifactId)
      outputs.push({
        key: hint.key,
        pluginId: hint.pluginId,
        role: hint.role,
        title: hint.title ?? basename(artifact.relativePath),
        artifactRefs: [artifactRef(runId, artifact)],
        derivedFrom: [...hint.derivedFrom],
        materialize: false,
      })
    }
  }

  const acceptedKeys = new Set(outputs.map((output) => output.key))
  for (const output of outputs) {
    const retained = output.derivedFrom.filter((parent) => acceptedKeys.has(parent))
    if (retained.length !== output.derivedFrom.length) {
      diagnostics.push({
        code: 'missing-parent',
        message: 'A derivedFrom key named an output rejected by the trust boundary',
        outputKey: output.key,
      })
      output.derivedFrom = retained
    }
  }

  const usedKeys = new Set(outputs.map((output) => output.key))
  let usedFallback = false
  for (const artifact of manifest.entries) {
    if (claimedArtifacts.has(artifact.artifactId)) continue
    if (outputs.length >= MAX_PROJECTION_OUTPUTS_V2) {
      diagnostics.push({
        code: 'projection-limit',
        message: 'Artifact was retained in the manifest but not auto-projected because the plan is full',
        artifactPath: artifact.relativePath,
      })
      continue
    }
    const plugin = selectFallbackPlugin(plugins, artifact)
    if (!plugin) {
      diagnostics.push({
        code: 'unclaimed-artifact',
        message: 'No plugin contract accepted this artifact',
        artifactPath: artifact.relativePath,
      })
      continue
    }
    usedFallback = true
    const key = uniqueFallbackKey(artifact, usedKeys)
    usedKeys.add(key)
    claimedArtifacts.add(artifact.artifactId)
    outputs.push({
      key,
      pluginId: plugin.id,
      role: 'supporting',
      title: basename(artifact.relativePath),
      artifactRefs: [artifactRef(runId, artifact)],
      derivedFrom: [],
      materialize: false,
    })
  }
  applyAutoMaterializationPolicy(outputs)

  let taskProposals = outcome
    ? trustedTaskProposals(outcome.taskProposals, new Set(outputs.map((output) => output.key)))
    : []
  let suggestedActions = outcome?.suggestedActions.map((action) => ({ ...action })) ?? []
  if (outcome && taskProposals.length !== outcome.taskProposals.length) {
    diagnostics.push({
      code: 'discarded-proposals',
      message: 'Task proposals with unavailable output inputs or dependencies were discarded',
    })
  }
  if (runStatus !== 'done' || !manifest.complete) {
    if (taskProposals.length > 0 || suggestedActions.length > 0) {
      diagnostics.push({
        code: 'discarded-proposals',
        message: 'Unsuccessful runs cannot create follow-up tasks or suggested actions',
      })
    }
    taskProposals = []
    suggestedActions = []
  }

  const status = runStatus === 'done' && manifest.complete ? 'complete' : 'partial'
  const planId = projectionPlanIdV2(taskId, runId)
  const warnings = diagnostics.map((diagnostic) =>
    `${diagnostic.code}: ${diagnostic.message}`)
  const unsigned = {
    schemaVersion: PROJECTION_PLAN_V2_SCHEMA_VERSION,
    planId,
    runId,
    taskId,
    status,
    manifestDigest,
    outputs,
    taskProposals,
    warnings,
  } as const
  const digest = digestJson('ggai-projection-plan-v2', unsigned)
  return {
    plan: { ...unsigned, digest },
    diagnostics,
    usedFallback,
    suggestedActions,
  }
}

export function inspectProjectionPlanV2(value: unknown): ProjectionPlanV2Inspection {
  if (!isExactRecord(value, [
    'schemaVersion',
    'planId',
    'runId',
    'taskId',
    'status',
    'manifestDigest',
    'outputs',
    'taskProposals',
    'warnings',
    'digest',
  ])) return invalid('projection plan has an invalid envelope')

  try {
    if (value.schemaVersion !== PROJECTION_PLAN_V2_SCHEMA_VERSION
      || typeof value.planId !== 'string'
      || typeof value.runId !== 'string'
      || typeof value.taskId !== 'string'
      || (value.status !== 'complete' && value.status !== 'partial')
      || typeof value.manifestDigest !== 'string'
      || !Array.isArray(value.outputs)
      || !Array.isArray(value.taskProposals)
      || !Array.isArray(value.warnings)
      || typeof value.digest !== 'string') {
      return invalid('projection plan fields are invalid')
    }
    const taskId = parseTaskId(value.taskId)
    const runId = parseRunId(value.runId)
    if (value.planId !== projectionPlanIdV2(taskId, runId)) {
      return invalid('projection plan id does not match taskId and runId')
    }
    if (!isSha256(value.digest) || !isSha256(value.manifestDigest)) {
      return invalid('projection plan digest is invalid')
    }

    const outputs = value.outputs.map((candidate, index) => inspectPlanOutput(candidate, index))
    if (outputs.length > MAX_PROJECTION_OUTPUTS_V2) {
      return invalid('projection plan has too many outputs')
    }
    const outputKeys = new Set(outputs.map((output) => output.key))
    if (outputKeys.size !== outputs.length) return invalid('projection output keys are duplicated')
    if (outputs.some((output) => output.derivedFrom.some((parent) => !outputKeys.has(parent)))) {
      return invalid('projection relation references a missing output')
    }
    if (hasProjectionCycle(outputs)) return invalid('projection relations contain a cycle')
    if (outputs.some((output) =>
      output.artifactRefs.some((artifact) => artifact.runId !== runId))) {
      return invalid('projection artifact belongs to a foreign run')
    }
    if (!hasCanonicalAutoMaterialization(outputs)) {
      return invalid('projection auto-materialization policy is invalid')
    }

    const semanticInspection = inspectRunOutcomeV2({
      schemaVersion: 2,
      suggestedActions: [],
      outputs: outputs.map((output, index) => ({
        key: output.key,
        path: `projection/${index}`,
        pluginId: output.pluginId,
        role: output.role,
        title: output.title,
        derivedFrom: output.derivedFrom,
      })),
      taskProposals: value.taskProposals,
    })
    if (semanticInspection.status !== 'valid') {
      return invalid('projection task proposals are invalid')
    }
    if (semanticInspection.outcome.taskProposals.some((proposal) =>
      proposal.inputOutputKeys.some((key) => !outputKeys.has(key)))) {
      return invalid('projection task proposal references a missing output')
    }
    if (value.status === 'partial' && semanticInspection.outcome.taskProposals.length > 0) {
      return invalid('partial projection plan retains task proposals')
    }
    if (value.warnings.length > 1_000
      || !value.warnings.every((warning) => isDisplayString(warning, 1_000))) {
      return invalid('projection warnings are invalid')
    }
    const warnings = [...value.warnings] as string[]

    const unsigned = {
      schemaVersion: PROJECTION_PLAN_V2_SCHEMA_VERSION,
      planId: value.planId,
      runId,
      taskId,
      status: value.status,
      manifestDigest: value.manifestDigest,
      outputs,
      taskProposals: semanticInspection.outcome.taskProposals,
      warnings,
    } as const
    const expectedDigest = digestJson('ggai-projection-plan-v2', unsigned)
    if (expectedDigest !== value.digest) return invalid('projection plan digest does not match')
    return { status: 'valid', plan: { ...unsigned, digest: expectedDigest } }
  } catch (error) {
    return invalid(error instanceof Error ? error.message : 'projection plan is invalid')
  }
}

export function projectionPlanIdV2(taskId: string, runId: string): string {
  const parsedTaskId = parseTaskId(taskId)
  const parsedRunId = parseRunId(runId)
  return `plan_${createHash('sha256')
    .update(parsedTaskId, 'utf8')
    .update('\0', 'utf8')
    .update(parsedRunId, 'utf8')
    .digest('hex')}`
}

/**
 * Runtime boundary for the browser-to-daemon plugin capability snapshot.
 *
 * The returned value is canonical plain data. UI renderers, functions, canvas
 * commands, and other undeclared plugin properties are rejected rather than
 * silently crossing the trust boundary.
 */
export function inspectProjectionPluginContractsV2(
  value: unknown,
): ProjectionPluginContractsV2Inspection {
  try {
    return { status: 'valid', plugins: parseProjectionPlugins(value) }
  } catch (error) {
    return invalid(error instanceof Error ? error.message : 'plugin contracts are invalid')
  }
}

function parseProjectionPlugins(
  values: unknown,
): ProjectionPluginContractV2[] {
  if (!Array.isArray(values) || values.length > MAX_PROJECTION_PLUGINS_V2) {
    throw new TypeError('plugins exceeds the supported bound')
  }
  const ids = new Set<string>()
  return values.map((plugin, pluginIndex) => {
    if (!isRecord(plugin)
      || !hasOnlyKeys(plugin, ['id', 'artifactRules', 'acceptsUnknown'])) {
      throw new TypeError(`plugins[${pluginIndex}] has unsupported properties`)
    }
    if (!isPluginId(plugin.id) || ids.has(plugin.id)) {
      throw new TypeError(`plugins[${pluginIndex}].id is invalid or duplicated`)
    }
    ids.add(plugin.id)
    if (!Array.isArray(plugin.artifactRules)
      || plugin.artifactRules.length > MAX_ARTIFACT_RULES_PER_PLUGIN_V2) {
      throw new TypeError(`plugins[${pluginIndex}].artifactRules is invalid`)
    }
    if (plugin.acceptsUnknown !== undefined && typeof plugin.acceptsUnknown !== 'boolean') {
      throw new TypeError(`plugins[${pluginIndex}].acceptsUnknown is invalid`)
    }
    const artifactRules = plugin.artifactRules.map((rule, ruleIndex) =>
      validateRule(rule, pluginIndex, ruleIndex))
    return {
      id: plugin.id,
      artifactRules,
      ...(plugin.acceptsUnknown ? { acceptsUnknown: true } : {}),
    }
  })
}

function validateRule(
  rule: unknown,
  pluginIndex: number,
  ruleIndex: number,
): ArtifactProjectionRuleV2 {
  if (!isRecord(rule)) throw new TypeError(`plugins[${pluginIndex}].artifactRules[${ruleIndex}] is invalid`)
  if (!hasOnlyKeys(rule, ['extensions', 'mediaTypes', 'priority'])) {
    throw new TypeError(`plugins[${pluginIndex}].artifactRules[${ruleIndex}] has unsupported properties`)
  }
  if (rule.extensions !== undefined && !Array.isArray(rule.extensions)) {
    throw new TypeError(`plugins[${pluginIndex}].artifactRules[${ruleIndex}].extensions is invalid`)
  }
  if (rule.mediaTypes !== undefined && !Array.isArray(rule.mediaTypes)) {
    throw new TypeError(`plugins[${pluginIndex}].artifactRules[${ruleIndex}].mediaTypes is invalid`)
  }
  const extensions = (rule.extensions ?? []) as unknown[]
  const mediaTypes = (rule.mediaTypes ?? []) as unknown[]
  if (extensions.length > MAX_ARTIFACT_MATCHERS_PER_RULE_V2
    || mediaTypes.length > MAX_ARTIFACT_MATCHERS_PER_RULE_V2
    || extensions.length + mediaTypes.length === 0
    || !extensions.every((extension) =>
      typeof extension === 'string' && /^\.[a-z0-9][a-z0-9.+_-]{0,31}$/u.test(extension))
    || !mediaTypes.every((mediaType) =>
      typeof mediaType === 'string' && isMediaTypeMatcher(mediaType))
    || new Set(extensions).size !== extensions.length
    || new Set(mediaTypes).size !== mediaTypes.length) {
    throw new TypeError(`plugins[${pluginIndex}].artifactRules[${ruleIndex}] matchers are invalid`)
  }
  const priority = rule.priority ?? 0
  if (typeof priority !== 'number'
    || !Number.isSafeInteger(priority)
    || priority < -1_000
    || priority > 1_000) {
    throw new TypeError(`plugins[${pluginIndex}].artifactRules[${ruleIndex}].priority is invalid`)
  }
  return {
    ...(extensions.length > 0 ? { extensions: [...extensions] as string[] } : {}),
    ...(mediaTypes.length > 0 ? { mediaTypes: [...mediaTypes] as string[] } : {}),
    ...(priority !== 0 ? { priority } : {}),
  }
}

function selectFallbackPlugin(
  plugins: readonly ProjectionPluginContractV2[],
  artifact: ArtifactManifestEntryV1,
): ProjectionPluginContractV2 | null {
  const ranked = plugins
    .map((plugin) => ({ plugin, score: matchPlugin(plugin, artifact) }))
    .filter((candidate): candidate is { plugin: ProjectionPluginContractV2; score: number } =>
      candidate.score !== null)
    .sort((left, right) => right.score - left.score || left.plugin.id.localeCompare(right.plugin.id))
  return ranked[0]?.plugin ?? null
}

function matchPlugin(
  plugin: ProjectionPluginContractV2,
  artifact: ArtifactManifestEntryV1,
): number | null {
  const extension = path.posix.extname(artifact.relativePath).toLowerCase()
  let best: number | null = null
  for (const rule of plugin.artifactRules) {
    const extensionMatch = rule.extensions?.includes(extension) ?? false
    const mediaTypeMatch = rule.mediaTypes?.some((matcher) =>
      matcher.endsWith('/*')
        ? artifact.mediaType.startsWith(matcher.slice(0, -1))
        : matcher === artifact.mediaType) ?? false
    if (!extensionMatch && !mediaTypeMatch) continue
    const specificity = extensionMatch && mediaTypeMatch ? 20 : 10
    best = Math.max(best ?? Number.NEGATIVE_INFINITY, (rule.priority ?? 0) * 100 + specificity)
  }
  if (best !== null) return best
  return plugin.acceptsUnknown ? -100_000 : null
}

function inspectPlanOutput(value: unknown, index: number): ProjectionOutputV2 {
  if (!isExactRecord(value, [
    'key',
    'pluginId',
    'role',
    'title',
    'artifactRefs',
    'derivedFrom',
    'materialize',
  ])) throw new TypeError(`outputs[${index}] is invalid`)
  if (!isStableKey(value.key)) throw new TypeError(`outputs[${index}].key is invalid`)
  if (!isPluginId(value.pluginId)) throw new TypeError(`outputs[${index}].pluginId is invalid`)
  if (value.role !== 'primary' && value.role !== 'supporting' && value.role !== 'auxiliary') {
    throw new TypeError(`outputs[${index}].role is invalid`)
  }
  if (!isDisplayString(value.title, 240)) throw new TypeError(`outputs[${index}].title is invalid`)
  if (!Array.isArray(value.artifactRefs)
    || value.artifactRefs.length === 0
    || value.artifactRefs.length > 8) {
    throw new TypeError(`outputs[${index}].artifactRefs is invalid`)
  }
  const artifactRefs = value.artifactRefs.map((candidate, artifactIndex) =>
    inspectArtifactRef(candidate, index, artifactIndex))
  if (new Set(artifactRefs.map((artifact) => artifact.artifactId)).size !== artifactRefs.length) {
    throw new TypeError(`outputs[${index}].artifactRefs is duplicated`)
  }
  if (!Array.isArray(value.derivedFrom)
    || value.derivedFrom.length > 8
    || !value.derivedFrom.every(isStableKey)
    || new Set(value.derivedFrom).size !== value.derivedFrom.length) {
    throw new TypeError(`outputs[${index}].derivedFrom is invalid`)
  }
  if (typeof value.materialize !== 'boolean') {
    throw new TypeError(`outputs[${index}].materialize is invalid`)
  }
  return {
    key: value.key,
    pluginId: value.pluginId,
    role: value.role,
    title: value.title,
    artifactRefs,
    derivedFrom: [...value.derivedFrom] as string[],
    materialize: value.materialize,
  }
}

function inspectArtifactRef(
  value: unknown,
  outputIndex: number,
  artifactIndex: number,
): ProjectionArtifactRefV2 {
  const label = `outputs[${outputIndex}].artifactRefs[${artifactIndex}]`
  if (!isExactRecord(value, [
    'runId',
    'artifactId',
  ])) throw new TypeError(`${label} is invalid`)
  if (typeof value.runId !== 'string'
    || typeof value.artifactId !== 'string'
    || !/^artifact_[0-9a-f]{64}$/u.test(value.artifactId)) {
    throw new TypeError(`${label} fields are invalid`)
  }
  const runId = parseRunId(value.runId)
  return {
    runId,
    artifactId: value.artifactId,
  }
}

function artifactRef(runId: string, entry: ArtifactManifestEntryV1): ProjectionArtifactRefV2 {
  return {
    runId,
    artifactId: entry.artifactId,
  }
}

function cloneTaskProposal(proposal: RunTaskProposalV2): ProjectionTaskProposalV2 {
  return {
    key: proposal.key,
    title: proposal.title,
    prompt: proposal.prompt,
    inputOutputKeys: [...proposal.inputOutputKeys],
    dependsOn: [...proposal.dependsOn],
  }
}

function trustedTaskProposals(
  proposals: readonly RunTaskProposalV2[],
  outputKeys: ReadonlySet<string>,
): ProjectionTaskProposalV2[] {
  const accepted = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const proposal of proposals) {
      if (accepted.has(proposal.key)
        || !proposal.inputOutputKeys.every((key) => outputKeys.has(key))
        || !proposal.dependsOn.every((key) => accepted.has(key))) continue
      accepted.add(proposal.key)
      changed = true
    }
  }
  return proposals
    .filter((proposal) => accepted.has(proposal.key))
    .map(cloneTaskProposal)
}

function applyAutoMaterializationPolicy(outputs: ProjectionOutputV2[]): void {
  const eligible = [
    ...outputs.filter((output) => output.role === 'primary'),
    ...outputs.filter((output) => output.role === 'supporting'),
  ].slice(0, MAX_AUTO_MATERIALIZED_OUTPUTS_V2)
  const selected = new Set(eligible.map((output) => output.key))
  for (const output of outputs) output.materialize = selected.has(output.key)
}

function hasCanonicalAutoMaterialization(outputs: readonly ProjectionOutputV2[]): boolean {
  const eligible = [
    ...outputs.filter((output) => output.role === 'primary'),
    ...outputs.filter((output) => output.role === 'supporting'),
  ].slice(0, MAX_AUTO_MATERIALIZED_OUTPUTS_V2)
  const selected = new Set(eligible.map((output) => output.key))
  return outputs.every((output) => output.materialize === selected.has(output.key))
}

function hasProjectionCycle(outputs: readonly ProjectionOutputV2[]): boolean {
  const parents = new Map(outputs.map((output) => [output.key, output.derivedFrom]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return true
    if (visited.has(key)) return false
    visiting.add(key)
    for (const parent of parents.get(key) ?? []) if (visit(parent)) return true
    visiting.delete(key)
    visited.add(key)
    return false
  }
  return outputs.some((output) => visit(output.key))
}

function uniqueFallbackKey(artifact: ArtifactManifestEntryV1, used: ReadonlySet<string>): string {
  const suffix = artifact.artifactId.slice(-16)
  let key = `artifact-${suffix}`
  let sequence = 2
  while (used.has(key)) {
    key = `artifact-${suffix}-${sequence}`
    sequence += 1
  }
  return key
}

function basename(value: string): string {
  return path.posix.basename(value).slice(0, 240) || 'Artifact'
}

function parseTaskId(value: unknown): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 160
    || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(value)
    || value.includes('..')) throw new TypeError('taskId is invalid')
  return value
}

function parseProjectionRunStatus(value: unknown): ProjectionRunStatusV2 {
  if (value !== 'done' && value !== 'error' && value !== 'cancelled' && value !== 'interrupted') {
    throw new TypeError('runStatus is not terminal')
  }
  return value
}

function digestJson(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(`${domain}\0`, 'utf8')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex')
}

function isStableKey(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 80
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
}

function isPluginId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 160
    && /^@?[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)
    && !value.includes('..')
    && !value.includes('//')
}

function isMediaTypeMatcher(value: string): boolean {
  return /^[a-z0-9!#$&^_.+-]+\/(?:[a-z0-9!#$&^_.+-]+|\*)$/u.test(value)
}

function isDisplayString(value: unknown, maxLength: number): value is string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || value !== value.trim()) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return false
  }
  return true
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value)
}

function invalid(reason: string): { status: 'invalid'; reason: string } {
  return { status: 'invalid', reason }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExactRecord(value: unknown, expectedKeys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value)
    && Object.keys(value).length === expectedKeys.length
    && expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key))
}
