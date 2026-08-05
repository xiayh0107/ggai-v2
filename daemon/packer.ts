import { lstat, mkdir, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { packContext, renderPackPrompt } from '../src/agent/context.js'
import type { ContextPack } from '../src/agent/types.js'
import {
  ARTIFACT_CONTROL_DIRECTORY,
  artifactRunDir,
  isArtifactReferenceForNode,
} from './artifactPaths.js'
import {
  MAX_SUGGESTED_ACTION_ID_LENGTH,
  MAX_SUGGESTED_ACTION_LABEL_LENGTH,
  MAX_SUGGESTED_ACTION_PROMPT_LENGTH,
  RUN_OUTCOME_RELATIVE_PATH,
} from './outcome.js'
import { isPathWithin } from './permissions.js'
import type { CreateRunRequest, PluginContract } from './protocol.js'

const MAX_ARTIFACT_FILES = 500
let latestViewWrite = Promise.resolve()

export interface PreparedRunContext {
  projectDir: string
  artifactDir: string
  contextFile: string
  pack: ContextPack
  /** Kept short so transports never put a large canvas snapshot in argv. */
  agentPrompt: string
}

async function atomicWrite(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, file)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/')
}

export interface ArtifactFileSnapshot {
  files: string[]
  complete: boolean
}

async function collectFiles(root: string, projectDir: string): Promise<ArtifactFileSnapshot> {
  const files: string[] = []
  let complete = true

  const ready = await safeCollectionRoot(root, projectDir)
  if (!ready) return { files, complete }

  async function visit(directory: string): Promise<void> {
    if (files.length >= MAX_ARTIFACT_FILES) {
      complete = false
      return
    }
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return
      throw error
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name === ARTIFACT_CONTROL_DIRECTORY) continue
      if (files.length >= MAX_ARTIFACT_FILES) {
        complete = false
        return
      }
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) files.push(toPosix(path.relative(projectDir, absolute)))
    }
  }

  await visit(root)
  return { files, complete }
}

async function safeCollectionRoot(root: string, projectDir: string): Promise<boolean> {
  const artifactsRoot = path.resolve(projectDir, 'artifacts')
  const absoluteRoot = path.resolve(root)
  try {
    const [artifactsInfo, rootInfo, canonicalProject, canonicalArtifacts, canonicalRoot] = await Promise.all([
      lstat(artifactsRoot),
      lstat(absoluteRoot),
      realpath(projectDir),
      realpath(artifactsRoot),
      realpath(absoluteRoot),
    ])
    const relativeRoot = path.relative(artifactsRoot, absoluteRoot)
    if (
      !isPathWithin(artifactsRoot, absoluteRoot)
      || !artifactsInfo.isDirectory()
      || artifactsInfo.isSymbolicLink()
      || canonicalArtifacts !== path.resolve(canonicalProject, 'artifacts')
      || !rootInfo.isDirectory()
      || rootInfo.isSymbolicLink()
      || canonicalRoot !== path.resolve(canonicalArtifacts, relativeRoot)
      || !isPathWithin(canonicalArtifacts, canonicalRoot)
    ) {
      throw new Error('artifact collection root is not a real project artifact directory')
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function existingArtifactReferences(
  projectDir: string,
  nodeId: string,
  values: readonly unknown[],
): Promise<string[]> {
  const artifactsRoot = path.resolve(projectDir, 'artifacts')
  const rootReady = await safeCollectionRoot(artifactsRoot, projectDir)
  if (!rootReady) return []
  const canonicalArtifacts = await realpath(artifactsRoot)

  const references: string[] = []
  for (const value of values) {
    if (references.length >= MAX_ARTIFACT_FILES) break
    if (!isArtifactReferenceForNode(value, nodeId) || references.includes(value)) continue
    const absolute = path.resolve(projectDir, ...value.split('/'))
    if (!isPathWithin(artifactsRoot, absolute)) continue
    try {
      const [info, canonical] = await Promise.all([lstat(absolute), realpath(absolute)])
      const expectedCanonical = path.resolve(
        canonicalArtifacts,
        path.relative(artifactsRoot, absolute),
      )
      if (
        info.isFile()
        && !info.isSymbolicLink()
        && canonical === expectedCanonical
        && isPathWithin(canonicalArtifacts, canonical)
      ) references.push(value)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return references
}

/** Authoritative, bounded artifact snapshot used for terminal UI reconciliation. */
export function listArtifactSnapshot(
  projectDir: string,
  nodeId: string,
  run?: { canvasBranch: string; runId: string },
): Promise<ArtifactFileSnapshot> {
  const root = run
    ? artifactRunDir(projectDir, run.canvasBranch, run.runId, nodeId)
    : path.join(projectDir, 'artifacts', nodeId)
  return collectFiles(root, projectDir)
}

export async function listArtifactFiles(projectDir: string, nodeId: string): Promise<string[]> {
  return (await listArtifactSnapshot(projectDir, nodeId)).files
}

function skillFilename(id: string): string {
  const normalized = id
    .normalize('NFKD')
    .replace(/^@/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '__')
    .replace(/^\.+/, '')
    .slice(0, 120)
  return `${normalized || 'plugin'}.md`
}

function renderPluginContract(plugin: PluginContract, artifactTarget: string): string {
  const lines = [
    `# ${plugin.label}`,
    '',
    `- Plugin ID: \`${plugin.id}\``,
    `- Description: ${plugin.description || 'No description provided.'}`,
  ]
  if (plugin.instruction) {
    lines.push(`- Instruction hint: ${plugin.instruction.placeholder || 'None'}`)
  }
  if (plugin.initialPayload) {
    lines.push('', '## Initial payload shape', '', '```json', JSON.stringify(plugin.initialPayload, null, 2), '```')
  }
  lines.push('', `Write generated files under \`${artifactTarget}\`; do not edit canvas state directly.`, '')
  return lines.join('\n')
}

async function writePluginContracts(
  skillsDir: string,
  plugins: PluginContract[],
  artifactTarget: string,
): Promise<void> {
  await mkdir(skillsDir, { recursive: true })
  const manifest: Array<{ id: string; file: string }> = []
  const seenFiles = new Set<string>()

  for (const plugin of plugins) {
    let filename = skillFilename(plugin.id)
    let suffix = 2
    while (seenFiles.has(filename)) {
      filename = skillFilename(`${plugin.id}-${suffix}`)
      suffix += 1
    }
    seenFiles.add(filename)
    manifest.push({ id: plugin.id, file: filename })
    await atomicWrite(path.join(skillsDir, filename), renderPluginContract(plugin, artifactTarget))
  }

  await atomicWrite(
    path.join(skillsDir, 'index.json'),
    `${JSON.stringify({ version: 1, plugins: manifest }, null, 2)}\n`,
  )
}

function renderDaemonContract(
  contextFile: string,
  skillsDir: string,
  artifactTarget: string,
): string {
  return [
    '# GGAI Agent workspace contract',
    '',
    `- Treat this run's context file, \`${contextFile}\`, as the source of truth.`,
    `- Treat \`${skillsDir}/\` as this run's plugin-contract directory.`,
    `- Write this run's deliverables only under \`${artifactTarget}\`.`,
    '- Never edit private canvas state; the UI reconciles artifact events back into nodes.',
    '- Follow any project-level `AGENTS.md` and `DESIGN.md` files that already exist.',
    '- Keep filenames stable and use relative paths when referring to deliverables.',
    '',
  ].join('\n')
}

/**
 * Compile the browser snapshot into the file-layer contract consumed by an external Agent CLI.
 * Existing project AGENTS.md files are intentionally not overwritten.
 */
export async function prepareRunContext(
  request: CreateRunRequest,
  projectDir: string,
  runId: string,
  executionProjectDir = projectDir,
): Promise<PreparedRunContext> {
  const artifactDir = artifactRunDir(
    projectDir,
    request.canvasBranch ?? 'main',
    runId,
    request.nodeId,
  )
  const contextRoot = path.join(projectDir, '.gg', 'context')
  const contextDir = path.join(contextRoot, 'runs', runId)
  const contextFile = path.join(contextDir, 'pack.md')
  const isolatedSource = path.resolve(executionProjectDir) !== path.resolve(projectDir)
  const contextReference = isolatedSource
    ? contextFile
    : toPosix(path.relative(projectDir, contextFile))
  const skillsReference = isolatedSource
    ? path.join(contextDir, 'skills')
    : toPosix(path.relative(projectDir, path.join(contextDir, 'skills')))
  const artifactTarget = `${artifactDir}${path.sep}`
  const outcomeTarget = path.join(artifactDir, ...RUN_OUTCOME_RELATIVE_PATH.split('/'))
  await Promise.all([
    mkdir(artifactDir, { recursive: true }),
    mkdir(contextDir, { recursive: true }),
  ])

  const pack = packContext({
    targetNodeId: request.nodeId,
    nodes: request.canvasSnapshot.nodes,
    edges: request.canvasSnapshot.edges,
    projectDir: executionProjectDir,
  })

  for (const [nodeId, content] of Object.entries(pack.sourceContents)) {
    const referenced = Array.isArray(content.payload?.artifactFiles)
      ? await existingArtifactReferences(projectDir, nodeId, content.payload.artifactFiles)
      : []
    content.artifactFiles = referenced.length > 0
      ? [...new Set(referenced)]
      : await listArtifactFiles(projectDir, nodeId)
    content.payload = { ...content.payload, artifactFiles: content.artifactFiles }
  }

  const rendered = [
    renderDaemonContract(
      contextReference,
      skillsReference,
      artifactTarget,
    ).trimEnd(),
    '',
    renderPackPrompt(pack, request.prompt),
    '',
    '## Output contract',
    `- Put every deliverable for this run in \`${artifactTarget}\`.`,
    `- At successful completion, write 3 to 5 context-specific next actions to \`${outcomeTarget}\`.`,
    '- This control file is not a deliverable. Create its parent directory if needed.',
    '- The file must be UTF-8 JSON with exactly this schema and no additional properties:',
    '',
    '```json',
    JSON.stringify({
      schemaVersion: 1,
      suggestedActions: [
        { id: 'stable-action-id', label: 'Short label', prompt: 'Complete prompt to run next' },
        { id: 'second-action-id', label: 'Short label', prompt: 'Complete prompt to run next' },
        { id: 'third-action-id', label: 'Short label', prompt: 'Complete prompt to run next' },
      ],
    }, null, 2),
    '```',
    `- Each action \`id\` must be unique, use only letters, digits, dot, underscore, colon, or hyphen, and be at most ${MAX_SUGGESTED_ACTION_ID_LENGTH} characters.`,
    `- Each \`label\` must be non-empty and at most ${MAX_SUGGESTED_ACTION_LABEL_LENGTH} characters; each \`prompt\` must be non-empty and at most ${MAX_SUGGESTED_ACTION_PROMPT_LENGTH} characters.`,
    '- Base actions on this run\'s actual result. Do not copy generic actions from the UI or include run/node identity fields.',
    '- In the final response, list the relative paths you created or changed.',
    '',
  ].join('\n')
  const packJson = `${JSON.stringify(pack, null, 2)}\n`
  const daemonContract = renderDaemonContract(
    contextReference,
    skillsReference,
    artifactTarget,
  )

  await Promise.all([
    atomicWrite(contextFile, rendered),
    atomicWrite(path.join(contextDir, 'pack.json'), packJson),
    atomicWrite(path.join(contextDir, 'AGENTS.md'), daemonContract),
    writePluginContracts(
      path.join(contextDir, 'skills'),
      request.canvasSnapshot.plugins ?? [],
      artifactTarget,
    ),
  ])

  // Stable "latest" files are for inspection only. Serialize this debug view so
  // concurrent runs cannot mix a pack.md from one run with another run's JSON/skills.
  const writeLatest = latestViewWrite.then(() => Promise.all([
    atomicWrite(path.join(contextRoot, 'pack.md'), rendered),
    atomicWrite(path.join(contextRoot, 'pack.json'), packJson),
    atomicWrite(path.join(contextRoot, 'AGENTS.md'), daemonContract),
    writePluginContracts(
      path.join(projectDir, '.gg', 'skills'),
      request.canvasSnapshot.plugins ?? [],
      artifactTarget,
    ),
  ]).then(() => undefined))
  latestViewWrite = writeLatest.catch(() => undefined)
  await writeLatest

  return {
    projectDir,
    artifactDir,
    contextFile,
    pack,
    agentPrompt: [
      `Read ${JSON.stringify(contextFile)} and carry out its task and output contract.`,
      `Write deliverables under ${JSON.stringify(artifactDir)} and report their project-relative paths.`,
    ].join(' '),
  }
}
