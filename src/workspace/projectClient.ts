export interface WorkspaceProjectSummary {
  taskCount: number
  nodeCount: number
  collectionCount: number
}

export interface WorkspaceProject {
  id: string
  title: string
  projectDir: string
  createdAt: string
  updatedAt: string
  lastOpenedAt: string | null
  state: 'ready' | 'unavailable'
  summary: WorkspaceProjectSummary | null
}

export interface WorkspaceProjectApi {
  list(signal?: AbortSignal): Promise<WorkspaceProject[]>
  create(title: string, signal?: AbortSignal): Promise<WorkspaceProject>
  open(projectId: string, signal?: AbortSignal): Promise<WorkspaceProject>
}

export class WorkspaceProjectProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceProjectProtocolError'
  }
}

export class WorkspaceProjectRequestError extends Error {
  readonly status: number
  readonly code: string | null

  constructor(message: string, status: number, code: string | null = null) {
    super(message)
    this.name = 'WorkspaceProjectRequestError'
    this.status = status
    this.code = code
  }
}

export interface WorkspaceProjectClientOptions {
  baseUrl: string
  fetch?: typeof globalThis.fetch
}

export const ROOT_WORKSPACE_PROJECT_ID = 'project_root'
export const MAX_WORKSPACE_PROJECT_TITLE_LENGTH = 120

const MANAGED_WORKSPACE_PROJECT_ID_PATTERN = /^project_[0-9a-f]{32}$/u

export class WorkspaceProjectClient implements WorkspaceProjectApi {
  readonly #baseUrl: string
  readonly #fetch: typeof globalThis.fetch

  constructor(options: WorkspaceProjectClientOptions) {
    this.#baseUrl = options.baseUrl
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  async list(signal?: AbortSignal): Promise<WorkspaceProject[]> {
    const response = await this.#fetch(this.#url('/projects'), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    })
    const value = await readJson(response, '读取项目列表')
    return parseProjectListEnvelope(value).projects
  }

  async create(title: string, signal?: AbortSignal): Promise<WorkspaceProject> {
    const normalized = projectTitle(title, '项目名称')
    const response = await this.#fetch(this.#url('/projects'), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: normalized }),
      signal,
    })
    const value = await readJson(response, '创建项目')
    return parseProjectEnvelope(value).project
  }

  async open(projectId: string, signal?: AbortSignal): Promise<WorkspaceProject> {
    const id = parseProjectId(projectId, 'projectId')
    const response = await this.#fetch(
      this.#url(`/projects/${encodeURIComponent(id)}/open`),
      {
        method: 'POST',
        headers: { Accept: 'application/json' },
        signal,
      },
    )
    const value = await readJson(response, '打开项目')
    const project = parseProjectEnvelope(value).project
    if (project.id !== id) {
      throw new WorkspaceProjectProtocolError('打开项目响应与请求的项目不匹配')
    }
    return project
  }

  #url(pathname: string): string {
    return new URL(pathname, this.#baseUrl).toString()
  }
}

export function parseProjectListEnvelope(value: unknown): {
  schemaVersion: 1
  projects: WorkspaceProject[]
} {
  const record = exactRecord(value, ['schemaVersion', 'projects'], '项目列表响应')
  if (record.schemaVersion !== 1) {
    throw protocol('项目列表响应.schemaVersion 必须为 1')
  }
  if (!Array.isArray(record.projects)) {
    throw protocol('项目列表响应.projects 必须为数组')
  }
  const projects = record.projects.map((project, index) =>
    parseProject(project, `项目列表响应.projects[${index}]`))
  const ids = new Set<string>()
  for (const project of projects) {
    if (ids.has(project.id)) throw protocol(`项目列表包含重复 id：${project.id}`)
    ids.add(project.id)
  }
  return { schemaVersion: 1, projects }
}

export function parseProjectEnvelope(value: unknown): {
  schemaVersion: 1
  project: WorkspaceProject
} {
  const record = exactRecord(value, ['schemaVersion', 'project'], '项目响应')
  if (record.schemaVersion !== 1) {
    throw protocol('项目响应.schemaVersion 必须为 1')
  }
  return { schemaVersion: 1, project: parseProject(record.project, '项目响应.project') }
}

function parseProject(value: unknown, context: string): WorkspaceProject {
  const record = exactRecord(value, [
    'id',
    'title',
    'projectDir',
    'createdAt',
    'updatedAt',
    'lastOpenedAt',
    'state',
    'summary',
  ], context)
  const state = record.state
  if (state !== 'ready' && state !== 'unavailable') {
    throw protocol(`${context}.state 无效`)
  }
  const lastOpenedAt = record.lastOpenedAt === null
    ? null
    : timestamp(record.lastOpenedAt, `${context}.lastOpenedAt`)
  const id = parseProjectId(record.id, `${context}.id`)
  const projectDir = nonEmptyString(record.projectDir, `${context}.projectDir`)
  const expectedProjectDir = id === ROOT_WORKSPACE_PROJECT_ID
    ? '.'
    : `.gg/workspace/projects/${id}`
  if (projectDir !== expectedProjectDir) {
    throw protocol(`${context}.projectDir 与项目 id 不匹配`)
  }
  return {
    id,
    title: projectTitle(record.title, `${context}.title`),
    projectDir,
    createdAt: timestamp(record.createdAt, `${context}.createdAt`),
    updatedAt: timestamp(record.updatedAt, `${context}.updatedAt`),
    lastOpenedAt,
    state,
    summary: record.summary === null ? null : parseSummary(record.summary, `${context}.summary`),
  }
}

function parseSummary(value: unknown, context: string): WorkspaceProjectSummary {
  const record = exactRecord(value, ['taskCount', 'nodeCount', 'collectionCount'], context)
  return {
    taskCount: count(record.taskCount, `${context}.taskCount`),
    nodeCount: count(record.nodeCount, `${context}.nodeCount`),
    collectionCount: count(record.collectionCount, `${context}.collectionCount`),
  }
}

async function readJson(response: Response, action: string): Promise<unknown> {
  let value: unknown
  try {
    value = await response.json() as unknown
  } catch (error) {
    if (!response.ok) {
      throw new WorkspaceProjectRequestError(`${action}失败（HTTP ${response.status}）`, response.status)
    }
    throw new WorkspaceProjectProtocolError(
      `${action}返回了无效 JSON：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!response.ok) {
    const detail = responseError(value)
    throw new WorkspaceProjectRequestError(
      detail.message ?? `${action}失败（HTTP ${response.status}）`,
      response.status,
      detail.code,
    )
  }
  return value
}

function responseError(value: unknown): { code: string | null; message: string | null } {
  if (!isRecord(value) || !isRecord(value.error)) return { code: null, message: null }
  return {
    code: typeof value.error.code === 'string' ? value.error.code : null,
    message: typeof value.error.message === 'string' ? value.error.message : null,
  }
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  context: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw protocol(`${context}必须为对象`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw protocol(`${context}字段不符合协议`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1_024) {
    throw protocol(`${context}必须为非空字符串`)
  }
  return value
}

function parseProjectId(value: unknown, context: string): string {
  if (
    value !== ROOT_WORKSPACE_PROJECT_ID
    && (typeof value !== 'string' || !MANAGED_WORKSPACE_PROJECT_ID_PATTERN.test(value))
  ) {
    throw protocol(`${context}必须为有效的项目标识`)
  }
  return value
}

function projectTitle(value: unknown, context: string): string {
  if (typeof value !== 'string') throw protocol(`${context}必须为字符串`)
  const normalized = value.trim().normalize('NFC')
  if (
    normalized.length === 0
    || normalized.length > MAX_WORKSPACE_PROJECT_TITLE_LENGTH
    || containsControlCharacter(normalized)
  ) {
    throw protocol(`${context}必须为 1–${MAX_WORKSPACE_PROJECT_TITLE_LENGTH} 个可打印字符`)
  }
  return normalized
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })
}

function timestamp(value: unknown, context: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw protocol(`${context}必须为有效时间`)
  }
  return value
}

function count(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw protocol(`${context}必须为非负整数`)
  }
  return value as number
}

function protocol(message: string): WorkspaceProjectProtocolError {
  return new WorkspaceProjectProtocolError(message)
}
