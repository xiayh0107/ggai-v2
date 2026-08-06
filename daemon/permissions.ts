import { lstat, realpath, stat } from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path'

export type PermissionErrorCode =
  | 'INVALID_PATH'
  | 'NOT_A_DIRECTORY'
  | 'PROJECT_OUTSIDE_ROOT'
  | 'UNRESOLVABLE_PATH'

export class PermissionPolicyError extends Error {
  readonly code: PermissionErrorCode

  constructor(code: PermissionErrorCode, message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'PermissionPolicyError'
    this.code = code
  }
}

export interface ProjectScopeConfig {
  /** Trusted daemon configuration boundary. This directory must exist. */
  projectRoot: string
  /** Requested working directory, absolute or relative to `projectRoot`. */
  projectDir: string
}

/** Canonical project paths used for subsequent permission decisions. */
export interface ProjectScope {
  projectRoot: string
  projectDir: string
  artifactsDir: string
  ggDir: string
}

export type WritePathArea = 'artifacts' | 'gg' | 'project' | 'outside-project'
export type PermissionDisposition = 'allow' | 'confirm' | 'deny'

export interface WritePathDecision {
  disposition: PermissionDisposition
  area: WritePathArea
  requestedPath: string
  /** Canonical path, when the target could be resolved safely. */
  resolvedPath?: string
  reason: string
}

export type CommandInput = string | readonly string[]

export interface CommandDecision {
  disposition: PermissionDisposition
  rule: string
  reason: string
}

/**
 * Resolves a requested project directory against a configured project root.
 * Both lexical traversal and symlink escape are rejected.
 */
export async function resolveProjectDir(
  projectRoot: string,
  requestedProjectDir: string,
): Promise<string> {
  assertPathString(projectRoot, 'projectRoot')
  assertPathString(requestedProjectDir, 'projectDir')

  const lexicalRoot = resolve(projectRoot)
  const canonicalRoot = await canonicalExistingDirectory(lexicalRoot, 'projectRoot')
  const lexicalProject = isAbsolute(requestedProjectDir)
    ? resolve(requestedProjectDir)
    : resolve(canonicalRoot, requestedProjectDir)

  if (
    !isPathWithin(lexicalRoot, lexicalProject) &&
    !isPathWithin(canonicalRoot, lexicalProject)
  ) {
    throw new PermissionPolicyError(
      'PROJECT_OUTSIDE_ROOT',
      `Project directory is outside configured root: ${requestedProjectDir}`,
    )
  }

  const canonicalProject = await canonicalExistingDirectory(lexicalProject, 'projectDir')
  if (!isPathWithin(canonicalRoot, canonicalProject)) {
    throw new PermissionPolicyError(
      'PROJECT_OUTSIDE_ROOT',
      `Project directory resolves outside configured root: ${requestedProjectDir}`,
    )
  }
  return canonicalProject
}

export async function createProjectScope(config: ProjectScopeConfig): Promise<ProjectScope> {
  const projectDir = await resolveProjectDir(config.projectRoot, config.projectDir)
  const projectRoot = await canonicalExistingDirectory(resolve(config.projectRoot), 'projectRoot')
  return {
    projectRoot,
    projectDir,
    artifactsDir: resolve(projectDir, 'artifacts'),
    ggDir: resolve(projectDir, '.gg'),
  }
}

/**
 * Canonicalizes existing targets with `realpath`. For a target that does not
 * exist yet, the nearest existing parent is canonicalized and the missing path
 * segments are appended. A broken or unresolvable symlink is rejected.
 */
export async function canonicalizePotentialPath(path: string): Promise<string> {
  assertPathString(path, 'path')
  let cursor = resolve(path)
  const missingSegments: string[] = []

  while (true) {
    try {
      const canonicalParent = await realpath(cursor)
      return resolve(canonicalParent, ...missingSegments)
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) {
        throw new PermissionPolicyError(
          'UNRESOLVABLE_PATH',
          `Cannot safely resolve path: ${path}`,
          error,
        )
      }

      // If lstat succeeds while realpath failed, `cursor` is commonly a broken
      // symlink. Treat it as unsafe instead of walking past it.
      try {
        await lstat(cursor)
      } catch (lstatError) {
        if (!isNodeError(lstatError, 'ENOENT')) {
          throw new PermissionPolicyError(
            'UNRESOLVABLE_PATH',
            `Cannot inspect path while resolving: ${path}`,
            lstatError,
          )
        }
        const parent = dirname(cursor)
        if (parent === cursor) {
          throw new PermissionPolicyError(
            'UNRESOLVABLE_PATH',
            `No existing parent could be resolved for path: ${path}`,
            error,
          )
        }
        missingSegments.unshift(basename(cursor))
        cursor = parent
        continue
      }

      throw new PermissionPolicyError(
        'UNRESOLVABLE_PATH',
        `Path contains a broken or unresolvable symlink: ${path}`,
        error,
      )
    }
  }
}

/** Pure path-boundary check that is safe against sibling-prefix confusion. */
export function isPathWithin(parentPath: string, candidatePath: string): boolean {
  const child = relative(resolve(parentPath), resolve(candidatePath))
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

/**
 * Applies the daemon write policy:
 * - `artifacts/` and `.gg/` are automatically allowed;
 * - other canonical paths inside the project require confirmation;
 * - traversal, broken links, and symlink escapes are denied.
 */
export async function assessWritePath(
  scope: ProjectScope,
  requestedPath: string,
): Promise<WritePathDecision> {
  if (typeof requestedPath !== 'string' || requestedPath.trim().length === 0) {
    return {
      disposition: 'deny',
      area: 'outside-project',
      requestedPath,
      reason: 'Write path must be a non-empty string',
    }
  }

  const lexicalPath = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(scope.projectDir, requestedPath)

  if (!isPathWithin(scope.projectDir, lexicalPath)) {
    return {
      disposition: 'deny',
      area: 'outside-project',
      requestedPath,
      reason: 'Write path traverses outside the project directory',
    }
  }

  let canonicalPath: string
  try {
    canonicalPath = await canonicalizePotentialPath(lexicalPath)
  } catch (error) {
    return {
      disposition: 'deny',
      area: lexicalArea(scope, lexicalPath),
      requestedPath,
      reason: error instanceof Error ? error.message : 'Write path cannot be resolved safely',
    }
  }

  if (!isPathWithin(scope.projectDir, canonicalPath)) {
    return {
      disposition: 'deny',
      area: 'outside-project',
      requestedPath,
      resolvedPath: canonicalPath,
      reason: 'Write path resolves outside the project directory through a symlink',
    }
  }

  const area = lexicalArea(scope, lexicalPath)
  if (
    area === 'gg'
    && (
      isDaemonOwnedStatePath(scope, lexicalPath)
      || isDaemonOwnedStatePath(scope, canonicalPath)
    )
  ) {
    return {
      disposition: 'deny',
      area,
      requestedPath,
      resolvedPath: canonicalPath,
      reason: 'Path is daemon-owned persistent state and cannot be modified by an Agent run',
    }
  }
  if (area === 'artifacts' || area === 'gg') {
    const whitelistRoot = area === 'artifacts' ? scope.artifactsDir : scope.ggDir
    try {
      const whitelistInfo = await lstat(whitelistRoot)
      if (!whitelistInfo.isDirectory()) {
        return {
          disposition: 'deny',
          area,
          requestedPath,
          resolvedPath: canonicalPath,
          reason: `Project ${area} whitelist exists but is not a real directory`,
        }
      }
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) {
        return {
          disposition: 'deny',
          area,
          requestedPath,
          resolvedPath: canonicalPath,
          reason: `Project ${area} whitelist cannot be inspected safely`,
        }
      }
    }

    let canonicalWhitelistRoot: string
    try {
      canonicalWhitelistRoot = await canonicalizePotentialPath(whitelistRoot)
    } catch (error) {
      return {
        disposition: 'deny',
        area,
        requestedPath,
        resolvedPath: canonicalPath,
        reason:
          error instanceof Error ? error.message : 'Write whitelist cannot be resolved safely',
      }
    }

    // The whitelist directory itself may not redirect elsewhere. Without this
    // equality check, `artifacts -> some-project-secret` would gain auto-write.
    if (
      canonicalWhitelistRoot !== whitelistRoot
      || canonicalPath !== lexicalPath
      || !isPathWithin(canonicalWhitelistRoot, canonicalPath)
    ) {
      return {
        disposition: 'deny',
        area,
        requestedPath,
        resolvedPath: canonicalPath,
        reason: `Write path escapes the ${area} whitelist through a symlink`,
      }
    }

    return {
      disposition: 'allow',
      area,
      requestedPath,
      resolvedPath: canonicalPath,
      reason: `Write is inside the project ${area} whitelist`,
    }
  }

  return {
    disposition: 'confirm',
    area: 'project',
    requestedPath,
    resolvedPath: canonicalPath,
    reason: 'Write is inside the project but outside artifacts/ and .gg/',
  }
}

function isDaemonOwnedStatePath(scope: ProjectScope, candidatePath: string): boolean {
  const protectedRoots = [
    resolve(scope.ggDir, 'canvas-state'),
    resolve(scope.ggDir, 'canvas-worktrees'),
    resolve(scope.ggDir, 'source-worktrees'),
    resolve(scope.ggDir, 'runtime'),
    resolve(scope.ggDir, 'workspace'),
  ]
  return protectedRoots.some((root) => isPathWithin(root, candidatePath))
}

export async function isAllowedWritePath(
  scope: ProjectScope,
  requestedPath: string,
): Promise<boolean> {
  return (await assessWritePath(scope, requestedPath)).disposition === 'allow'
}

/**
 * Pure, conservative command classifier. It never executes or resolves a
 * command. Known destructive/elevated operations are denied, dependency
 * installation is allowed for rapid development, and unknown writes require
 * confirmation.
 */
export function assessCommand(command: CommandInput): CommandDecision {
  const inspected = inspectCommand(command)
  if (inspected.raw.length === 0 || inspected.tokens.length === 0) {
    return denyCommand('empty-command', 'Empty commands are not executable')
  }
  if (inspected.raw.includes('\0')) {
    return denyCommand('nul-byte', 'Commands containing NUL bytes are invalid')
  }

  const tokens = inspected.tokens.map((token) => token.toLowerCase())
  const raw = inspected.raw.toLowerCase()
  const executableIndexes = findExecutableIndexes(tokens)
  const commands = executableIndexes.map((index) => commandBasename(tokens[index] ?? ''))

  if (commands.some((token) => token === 'sudo' || token === 'doas')) {
    return denyCommand('privilege-escalation', 'Privilege escalation is disabled')
  }
  if (commands.some((token) => token === 'rm' || token === 'rmdir' || token === 'unlink')) {
    return denyCommand('destructive-delete', 'Destructive delete commands are disabled')
  }
  if (
    commands.some(
      (token) =>
        token.startsWith('mkfs') ||
        ['diskutil', 'fdisk', 'shutdown', 'reboot'].includes(token),
    )
  ) {
    return denyCommand('system-destructive', 'System-level destructive commands are disabled')
  }
  if (commands.some((token) => token === 'dd')) {
    return denyCommand('raw-disk-write', 'Raw copy/disk commands are disabled')
  }
  if (
    typeof command === 'string' &&
    (raw.includes('$(') || raw.includes('`'))
  ) {
    return denyCommand('nested-shell', 'Nested shell evaluation cannot be safely inspected')
  }
  if (
    executableIndexes.some((index) => {
      const executable = commandBasename(tokens[index] ?? '')
      const arguments_ = commandArguments(tokens, index)
      return (
        ['bash', 'sh', 'zsh', 'fish', 'powershell', 'pwsh'].includes(executable) &&
        (arguments_.includes('-c') || arguments_.includes('-command'))
      ) || executable === 'eval'
    })
  ) {
    return denyCommand('nested-shell', 'Nested shell evaluation cannot be safely inspected')
  }
  const packageInstall = isPackageInstall(tokens, executableIndexes)
  if (/\b(?:curl|wget)\b[^\n|;]*(?:\||\|&)\s*(?:ba)?sh\b/u.test(raw)) {
    return denyCommand('download-and-execute', 'Downloading content into a shell is disabled')
  }
  if (executableIndexes.some((index) => isDestructiveGit(tokens, index))) {
    return denyCommand('destructive-git', 'Destructive Git operations are disabled by default')
  }
  if (executableIndexes.some((index) => {
    const executable = commandBasename(tokens[index] ?? '')
    return (
      (executable === 'chmod' || executable === 'chown') &&
      commandArguments(tokens, index).some(
        (token) => token === '-r' || /^-[a-z]*r[a-z]*$/u.test(token),
      )
    )
  })) {
    return denyCommand('recursive-permissions', 'Recursive permission changes are disabled')
  }
  if (executableIndexes.some((index) => {
    if (commandBasename(tokens[index] ?? '') !== 'find') return false
    return commandArguments(tokens, index).some((token) =>
      ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'].includes(
        token,
      ),
    )
  })) {
    return denyCommand('mutating-find', 'Mutating find operations are disabled')
  }

  if (typeof command === 'string' && /[;&|`$<>\n\r]/u.test(command)) {
    return confirmCommand(
      'shell-syntax',
      'Shell composition or redirection requires explicit confirmation',
    )
  }

  if (packageInstall) {
    return allowCommand('package-install', 'Dependency installation is enabled for development')
  }

  const executable = commandBasename(tokens[0] ?? '')
  if (executable && READ_ONLY_COMMANDS.has(executable)) {
    return allowCommand('read-only', 'Known read-only command')
  }
  if (executable === 'git' && isReadOnlyGit(tokens.slice(1))) {
    return allowCommand('read-only-git', 'Known read-only Git command')
  }

  return confirmCommand('unclassified', 'Command is not in the read-only allowlist')
}

export function isDangerousCommand(command: CommandInput): boolean {
  return assessCommand(command).disposition === 'deny'
}

const READ_ONLY_COMMANDS = new Set([
  'cat',
  'du',
  'find',
  'head',
  'id',
  'ls',
  'pwd',
  'realpath',
  'rg',
  'stat',
  'tail',
  'uname',
  'wc',
  'which',
  'whoami',
])

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'diff',
  'log',
  'rev-parse',
  'show',
  'status',
])

function lexicalArea(scope: ProjectScope, path: string): WritePathArea {
  if (isPathWithin(scope.artifactsDir, path)) return 'artifacts'
  if (isPathWithin(scope.ggDir, path)) return 'gg'
  return isPathWithin(scope.projectDir, path) ? 'project' : 'outside-project'
}

async function canonicalExistingDirectory(path: string, label: string): Promise<string> {
  let canonical: string
  try {
    canonical = await realpath(path)
  } catch (error) {
    throw new PermissionPolicyError(
      'INVALID_PATH',
      `${label} does not exist or cannot be resolved: ${path}`,
      error,
    )
  }

  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(canonical)
  } catch (error) {
    throw new PermissionPolicyError('INVALID_PATH', `Cannot inspect ${label}: ${path}`, error)
  }
  if (!info.isDirectory()) {
    throw new PermissionPolicyError('NOT_A_DIRECTORY', `${label} is not a directory: ${path}`)
  }
  return canonical
}

function assertPathString(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new PermissionPolicyError('INVALID_PATH', `${label} must be a non-empty path`)
  }
}

function inspectCommand(command: CommandInput): { raw: string; tokens: string[] } {
  if (typeof command !== 'string') {
    return {
      raw: command.join(' '),
      tokens: command.map((part) => part.trim()).filter(Boolean),
    }
  }
  const raw = command.trim()
  const matches =
    raw.match(/&&|\|\||\|&|[;|&]|(?:[^\s"'\\;&|]+|"(?:\\.|[^"])*"|'[^']*')+/gu) ?? []
  return {
    raw,
    tokens: matches.map((token) => {
      if (
        (token.startsWith('"') && token.endsWith('"')) ||
        (token.startsWith("'") && token.endsWith("'"))
      ) {
        return token.slice(1, -1)
      }
      return token
    }),
  }
}

function commandBasename(token: string): string {
  const slash = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'))
  return slash >= 0 ? token.slice(slash + 1) : token
}

function findExecutableIndexes(tokens: readonly string[]): number[] {
  const indexes: number[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    if (index === 0 || SHELL_OPERATORS.has(tokens[index - 1] ?? '')) {
      if (!SHELL_OPERATORS.has(tokens[index] ?? '')) indexes.push(index)
    }
  }

  // A small set of transparent wrappers needs one additional level of
  // inspection. Unknown wrappers remain in the confirmation tier.
  for (let cursor = 0; cursor < indexes.length; cursor += 1) {
    const index = indexes[cursor]
    const executable = commandBasename(tokens[index] ?? '')
    if (!['command', 'env', 'nohup', 'time', 'xargs'].includes(executable)) continue
    const segmentEnd = findSegmentEnd(tokens, index)
    for (let nested = index + 1; nested < segmentEnd; nested += 1) {
      const candidate = tokens[nested] ?? ''
      if (candidate.startsWith('-')) continue
      if (executable === 'env' && /^[a-z_][a-z0-9_]*=/iu.test(candidate)) continue
      indexes.push(nested)
      break
    }
  }
  return [...new Set(indexes)].sort((left, right) => left - right)
}

function commandArguments(tokens: readonly string[], executableIndex: number): string[] {
  return tokens.slice(executableIndex + 1, findSegmentEnd(tokens, executableIndex))
}

function findSegmentEnd(tokens: readonly string[], start: number): number {
  const relativeEnd = tokens.slice(start + 1).findIndex((token) => SHELL_OPERATORS.has(token))
  return relativeEnd < 0 ? tokens.length : start + 1 + relativeEnd
}

function isPackageInstall(tokens: readonly string[], executableIndexes: readonly number[]): boolean {
  for (const index of executableIndexes) {
    const executable = commandBasename(tokens[index] ?? '')
    const arguments_ = commandArguments(tokens, index)
    const subcommand = firstSubcommand(arguments_)
    if (
      ['npm', 'pnpm', 'yarn', 'bun'].includes(executable) &&
      subcommand !== undefined &&
      ['i', 'install', 'add', 'ci'].includes(subcommand)
    ) {
      return true
    }
    if (
      /^pip(?:\d+(?:\.\d+)*)?$/u.test(executable) &&
      subcommand === 'install'
    ) {
      return true
    }
    if (
      [
        'apt',
        'apt-get',
        'apk',
        'brew',
        'cargo',
        'composer',
        'conda',
        'dnf',
        'gem',
        'pacman',
        'poetry',
        'uv',
        'yum',
      ].includes(executable) &&
      subcommand !== undefined &&
      ['add', 'install', 'sync'].includes(subcommand)
    ) {
      return true
    }
    if (
      executable === 'uv' &&
      subcommand === 'pip' &&
      firstSubcommand(arguments_.slice(arguments_.indexOf('pip') + 1)) === 'install'
    ) {
      return true
    }
  }
  return /\bpython(?:\d+(?:\.\d+)*)?\s+-m\s+pip\s+install\b/u.test(tokens.join(' '))
}

function firstSubcommand(arguments_: readonly string[]): string | undefined {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] ?? ''
    if (OPTIONS_WITH_VALUES.has(argument)) {
      index += 1
      continue
    }
    if (!argument.startsWith('-')) return argument
  }
  return undefined
}

function isDestructiveGit(tokens: readonly string[], index: number): boolean {
  if (commandBasename(tokens[index] ?? '') !== 'git') return false
  const arguments_ = commandArguments(tokens, index)
  return (
    (arguments_.includes('reset') && arguments_.includes('--hard')) ||
    (arguments_.includes('clean') &&
      arguments_.some(
        (token) => token === '--force' || /^-[a-z]*f[a-z]*$/u.test(token),
      )) ||
    (arguments_.includes('push') &&
      arguments_.some(
        (token) => token === '--force' || token === '-f' || token.startsWith('--force-with-lease'),
      )) ||
    (arguments_.includes('checkout') && arguments_.includes('--'))
  )
}

function isReadOnlyGit(arguments_: readonly string[]): boolean {
  const subcommand = arguments_.find((argument) => !argument.startsWith('-'))
  return (
    subcommand !== undefined &&
    READ_ONLY_GIT_SUBCOMMANDS.has(subcommand) &&
    !arguments_.some((argument) => argument === '--output' || argument.startsWith('--output='))
  )
}

const SHELL_OPERATORS = new Set(['&&', '||', '|', '|&', ';', '&'])

const OPTIONS_WITH_VALUES = new Set([
  '--cwd',
  '--prefix',
  '--project',
  '--workspace',
  '-c',
  '-C',
])

function allowCommand(rule: string, reason: string): CommandDecision {
  return { disposition: 'allow', rule, reason }
}

function confirmCommand(rule: string, reason: string): CommandDecision {
  return { disposition: 'confirm', rule, reason }
}

function denyCommand(rule: string, reason: string): CommandDecision {
  return { disposition: 'deny', rule, reason }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}
