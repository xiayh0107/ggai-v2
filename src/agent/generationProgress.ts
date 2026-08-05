import type { CanvasAgentEvent } from './types'

export type GenerationActivityKind =
  | 'connecting'
  | 'thinking'
  | 'writing'
  | 'tool'
  | 'artifact'
  | 'finishing'
  | 'warning'

export interface GenerationActivity {
  key: string
  kind: GenerationActivityKind
  label: string
}

/** 一条原始日志：Agent 的英文思考 / 输出 / 工具调用等未加工内容。 */
export interface GenerationLogEntry {
  kind: 'thinking' | 'output' | 'tool' | 'artifact' | 'warning' | 'info'
  text: string
}

export interface GenerationPanelState {
  epoch: number
  current: GenerationActivity
  /** Completed activities immediately preceding `current`, oldest first. */
  recent: GenerationActivity[]
  /**
   * 原始日志（默认折叠，用户展开「原始日志」时展示）。
   * 与产品化状态并行维护；thinking / output 流式片段会合并进上一条同类日志。
   */
  log: GenerationLogEntry[]
}

const MAX_RECENT_ACTIVITIES = 3
const MAX_LOG_ENTRIES = 200
const MAX_LOG_LINE = 400

export function createGenerationPanel(epoch: number): GenerationPanelState {
  return {
    epoch,
    current: {
      key: 'connecting',
      kind: 'connecting',
      label: '正在连接 Agent',
    },
    recent: [],
    log: [],
  }
}

function artifactName(artifactPath: string): string {
  return artifactPath.split('/').at(-1) || '结果文件'
}

function friendlyToolActivity(name: string): GenerationActivity {
  const normalized = name.trim().toLowerCase()
  if (/read|context|list|cat|open/u.test(normalized)) {
    return { key: 'tool:read', kind: 'tool', label: '正在读取节点上下文' }
  }
  if (/search|web|fetch|lookup/u.test(normalized)) {
    return { key: 'tool:search', kind: 'tool', label: '正在检索相关信息' }
  }
  if (/write|edit|patch|create|save/u.test(normalized)) {
    return { key: 'tool:write', kind: 'tool', label: '正在写入生成内容' }
  }
  return { key: 'tool:run', kind: 'tool', label: '正在执行处理步骤' }
}

function clipLogLine(text: string): string {
  const compact = text.replace(/\s+$/u, '')
  return compact.length > MAX_LOG_LINE ? `${compact.slice(0, MAX_LOG_LINE - 1)}…` : compact
}

function summarizeUnknown(value: unknown): string {
  let raw: string
  try {
    raw = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  } catch {
    raw = ''
  }
  raw = raw.replace(/\s+/gu, ' ').trim()
  return raw.length > 160 ? `${raw.slice(0, 160)}…` : raw
}

/**
 * Convert a protocol event into a raw log line (Agent's own words, usually
 * English). Returns null for bookkeeping events that stay out of the log.
 */
export function rawLogEntryForEvent(event: CanvasAgentEvent): GenerationLogEntry | null {
  switch (event.type) {
    case 'thinking': {
      const text = clipLogLine(event.text)
      return text ? { kind: 'thinking', text } : null
    }
    case 'text-delta':
      return event.text ? { kind: 'output', text: event.text } : null
    case 'tool-call': {
      const input = summarizeUnknown(event.input)
      return { kind: 'tool', text: clipLogLine(`→ ${event.name}${input ? ` ${input}` : ''}`) }
    }
    case 'tool-result': {
      const result = summarizeUnknown(event.result)
      return { kind: 'tool', text: clipLogLine(`← ${result || 'ok'}`) }
    }
    case 'file-write':
      return { kind: 'artifact', text: `write ${event.path}` }
    case 'permission-request':
      return { kind: 'warning', text: clipLogLine(`permission: ${event.action} ${event.detail}`.trim()) }
    case 'error':
      return { kind: 'warning', text: clipLogLine(`error: ${event.message}`) }
    case 'done':
      return { kind: 'info', text: `done (${event.stopReason})` }
    case 'usage':
      return null
  }
}

/** 流式片段（thinking / output）合并进上一条同类日志，避免每个 chunk 一行。 */
function appendLogEntry(log: GenerationLogEntry[], entry: GenerationLogEntry): GenerationLogEntry[] {
  const last = log.at(-1)
  if (last && last.kind === entry.kind && (entry.kind === 'thinking' || entry.kind === 'output')) {
    const merged = clipLogLine(last.text + entry.text)
    return [...log.slice(0, -1), { kind: last.kind, text: merged }]
  }
  return [...log, entry].slice(-MAX_LOG_ENTRIES)
}

/**
 * Convert protocol events into stable, product-level progress. Raw reasoning
 * and streamed output are kept out of the product labels, but preserved in
 * `panel.log` for the expandable「原始日志」view.
 */
export function generationActivityForEvent(
  event: CanvasAgentEvent,
  nodeType: string,
): GenerationActivity | null {
  switch (event.type) {
    case 'thinking':
      return { key: 'thinking', kind: 'thinking', label: '正在理解任务' }
    case 'text-delta':
      return {
        key: 'writing',
        kind: 'writing',
        label: nodeType === 'text' ? '正在生成文本' : '正在生成内容',
      }
    case 'tool-call':
      return friendlyToolActivity(event.name)
    case 'tool-result':
      return { key: 'tool:result', kind: 'tool', label: '处理步骤已完成' }
    case 'file-write':
      return {
        key: `artifact:${event.path}`,
        kind: 'artifact',
        label: `已生成 ${artifactName(event.path)}`,
      }
    case 'permission-request':
      return { key: 'permission', kind: 'warning', label: '等待操作确认' }
    case 'error':
      return { key: 'warning', kind: 'warning', label: '正在调整处理方式' }
    case 'done':
      return event.stopReason === 'end_turn'
        ? { key: 'finishing', kind: 'finishing', label: '正在整理结果' }
        : null
    case 'usage':
      return null
  }
}

export function advanceGenerationPanel(
  panel: GenerationPanelState,
  event: CanvasAgentEvent,
  nodeType: string,
): GenerationPanelState {
  const activity = generationActivityForEvent(event, nodeType)
  const logEntry = rawLogEntryForEvent(event)
  const activityChanged = Boolean(activity) && activity!.key !== panel.current.key
  if (!activityChanged && !logEntry) return panel
  return {
    ...panel,
    current: activityChanged ? activity! : panel.current,
    recent: activityChanged
      ? [...panel.recent, panel.current].slice(-MAX_RECENT_ACTIVITIES)
      : panel.recent,
    log: logEntry ? appendLogEntry(panel.log, logEntry) : panel.log,
  }
}
