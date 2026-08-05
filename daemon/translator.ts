import { TextDecoder } from 'node:util'
import type { CanvasAgentEvent } from '../src/agent/types.js'

export type AgentOutputSource = 'stdout' | 'stderr'
const MAX_AGENT_LINE_CHARS = 1024 * 1024

export interface TranslationResult {
  events: CanvasAgentEvent[]
  sessionId: string | null
}

export interface AgentEventTranslatorOptions {
  onSessionId?: (sessionId: string) => void
}

type JsonRecord = Record<string, unknown>

interface HandledEvents {
  handled: boolean
  events: CanvasAgentEvent[]
}

function emptyResult(): TranslationResult {
  return { events: [], sessionId: null }
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, Math.trunc(value))
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return Math.max(0, Math.trunc(parsed))
    }
  }
  return null
}

function normalizedTag(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[.\-/\s]+/g, '_')
    : ''
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function extractText(value: unknown, depth = 0): string | null {
  if (depth > 5) return null
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => extractText(entry, depth + 1))
      .filter((entry): entry is string => entry !== null && entry !== '')
    return parts.length > 0 ? parts.join('') : null
  }

  const record = asRecord(value)
  if (!record) return null

  const direct = firstString(
    record.text,
    record.delta,
    record.outputText,
    record.output_text,
    record.message,
    record.summary,
  )
  if (direct !== null) return direct

  for (const key of ['content', 'parts', 'blocks']) {
    if (record[key] !== undefined) {
      const nested = extractText(record[key], depth + 1)
      if (nested !== null) return nested
    }
  }
  return null
}

function extractErrorMessage(value: unknown): string {
  if (typeof value === 'string') return value
  const record = asRecord(value)
  if (!record) return stringify(value)
  return firstString(
    record.message,
    record.detail,
    record.error,
    record.reason,
  ) ?? stringify(value)
}

function extractSessionId(root: JsonRecord): string | null {
  const params = asRecord(root.params)
  const result = asRecord(root.result)
  const payload = asRecord(root.payload)
  const session = asRecord(root.session)
  const thread = asRecord(root.thread)

  return firstString(
    root.sessionId,
    root.session_id,
    root.threadId,
    root.thread_id,
    params?.sessionId,
    params?.session_id,
    params?.threadId,
    params?.thread_id,
    result?.sessionId,
    result?.session_id,
    result?.threadId,
    result?.thread_id,
    payload?.sessionId,
    payload?.session_id,
    payload?.threadId,
    payload?.thread_id,
    session?.id,
    thread?.id,
  )
}

function usageEvent(value: unknown): CanvasAgentEvent | null {
  const root = asRecord(value)
  if (!root) return null
  const usage = asRecord(root.usage) ?? asRecord(root.tokenUsage) ?? root

  let tokensIn = firstNumber(
    usage.tokensIn,
    usage.inputTokens,
    usage.input_tokens,
    usage.promptTokens,
    usage.prompt_tokens,
  )
  let tokensOut = firstNumber(
    usage.tokensOut,
    usage.outputTokens,
    usage.output_tokens,
    usage.completionTokens,
    usage.completion_tokens,
  )

  // ACP usage_update currently reports context-window usage as `used`/`size`.
  // Preserve the useful count without pretending that `size` is output usage.
  if (tokensIn === null && tokensOut === null) {
    tokensIn = firstNumber(usage.used, usage.totalTokens, usage.total_tokens)
    tokensOut = tokensIn === null ? null : 0
  }

  if (tokensIn === null && tokensOut === null) return null
  return { type: 'usage', tokensIn: tokensIn ?? 0, tokensOut: tokensOut ?? 0 }
}

function stopReason(value: unknown): 'end_turn' | 'cancelled' | 'error' {
  const tag = normalizedTag(value)
  if (tag === 'cancelled' || tag === 'canceled' || tag === 'aborted') return 'cancelled'
  if (tag === 'error' || tag === 'failed' || tag === 'failure') return 'error'
  return 'end_turn'
}

function formatPlan(value: unknown): string | null {
  const record = asRecord(value)
  const plan = asRecord(record?.plan) ?? record
  if (!plan) return extractText(value)

  const entries = [plan.entries, plan.items, plan.tasks]
    .map(asArray)
    .find((candidate) => candidate.length > 0) ?? []

  if (entries.length === 0) return extractText(plan)

  const lines = entries.flatMap((entry) => {
    const item = asRecord(entry)
    if (!item) return typeof entry === 'string' ? [`- ${entry}`] : []
    const text = firstString(item.content, item.text, item.title, item.description)
    if (text === null) return []
    const status = firstString(item.status, item.state)
    return [`- ${status ? `[${status}] ` : ''}${text}`]
  })
  return lines.length > 0 ? `Plan:\n${lines.join('\n')}` : null
}

function toolName(value: JsonRecord, fallback = 'tool'): string {
  const fn = asRecord(value.function)
  const server = firstString(value.server, value.serverName, value.server_name)
  const tool = firstString(value.tool, value.toolName, value.tool_name)
  return firstString(
    value.title,
    value.name,
    fn?.name,
    server && tool ? `${server}.${tool}` : null,
    tool,
    value.kind,
  ) ?? fallback
}

function toolInput(value: JsonRecord): unknown {
  const fn = asRecord(value.function)
  const direct = value.rawInput
    ?? value.raw_input
    ?? value.input
    ?? value.arguments
    ?? value.args
    ?? fn?.arguments
  if (direct !== undefined) return direct
  if (value.command !== undefined) return { command: value.command }

  const id = firstString(value.toolCallId, value.tool_call_id, value.callId, value.call_id, value.id)
  return id === null ? {} : { toolCallId: id }
}

function toolOutput(value: JsonRecord): unknown {
  const direct = value.rawOutput
    ?? value.raw_output
    ?? value.output
    ?? value.result
    ?? value.aggregatedOutput
    ?? value.aggregated_output
  if (direct !== undefined) return direct

  if (value.content !== undefined) {
    const text = extractText(value.content)
    return text ?? value.content
  }

  const compact: JsonRecord = {}
  for (const key of ['toolCallId', 'tool_call_id', 'status', 'exitCode', 'exit_code', 'error']) {
    if (value[key] !== undefined) compact[key] = value[key]
  }
  return compact
}

function fileWriteEvents(value: JsonRecord): CanvasAgentEvent[] {
  const nodeId = firstString(value.nodeId, value.node_id) ?? undefined
  const paths = new Set<string>()
  const directPath = firstString(value.path, value.filePath, value.file_path)
  if (directPath !== null) paths.add(directPath)

  for (const change of asArray(value.changes)) {
    if (typeof change === 'string' && change !== '') paths.add(change)
    const record = asRecord(change)
    const path = record && firstString(record.path, record.filePath, record.file_path)
    if (path) paths.add(path)
  }

  return [...paths].map((path) => ({ type: 'file-write', path, nodeId }))
}

function permissionEvent(root: JsonRecord): CanvasAgentEvent {
  const params = asRecord(root.params) ?? root
  const subject = asRecord(params.subject)
  const subjectTool = asRecord(subject?.toolCall) ?? asRecord(subject?.tool_call)
  const legacyTool = asRecord(params.toolCall) ?? asRecord(params.tool_call)
  const tool = subjectTool ?? legacyTool
  const id = firstString(
    root.id,
    params.permissionId,
    params.permission_id,
    tool?.toolCallId,
    tool?.tool_call_id,
  ) ?? 'permission'
  const action = firstString(params.title, tool?.title, tool?.name, tool?.kind) ?? 'Agent action'
  const detail = firstString(params.description, params.detail)
    ?? (tool ? stringify(toolInput(tool)) : stringify(params))
  return { type: 'permission-request', id, action, detail }
}

function translateAcpUpdate(update: JsonRecord): CanvasAgentEvent[] {
  const kind = normalizedTag(
    update.sessionUpdate
    ?? update.session_update
    ?? update.updateType
    ?? update.update_type
    ?? update.type,
  )

  if (kind === 'agent_message_chunk' || kind === 'assistant_message_chunk') {
    const text = extractText(update.content ?? update.message ?? update.delta)
    return text === null ? [] : [{ type: 'text-delta', text }]
  }

  if (
    kind === 'agent_thought_chunk'
    || kind === 'thought_chunk'
    || kind === 'reasoning_chunk'
    || kind === 'thinking'
  ) {
    const text = extractText(update.content ?? update.message ?? update.delta ?? update)
    return text === null ? [] : [{ type: 'thinking', text }]
  }

  if (kind === 'plan_update' || kind === 'plan') {
    const text = formatPlan(update.plan ?? update)
    return text === null ? [] : [{ type: 'thinking', text }]
  }

  if (kind === 'usage_update' || kind === 'usage' || kind === 'token_usage') {
    const event = usageEvent(update)
    return event === null ? [] : [event]
  }

  if (kind === 'tool_call' || kind === 'tool_call_start' || kind === 'tool_call_started') {
    return [{ type: 'tool-call', name: toolName(update), input: toolInput(update) }]
  }

  if (kind === 'tool_result' || kind === 'tool_call_result') {
    return [{ type: 'tool-result', result: toolOutput(update) }]
  }

  if (kind === 'tool_call_update') {
    const status = normalizedTag(update.status)
    const hasOutput = update.rawOutput !== undefined
      || update.raw_output !== undefined
      || update.output !== undefined
      || update.result !== undefined
    const finished = hasOutput
      || ['completed', 'done', 'failed', 'error', 'cancelled', 'canceled'].includes(status)
    return finished
      ? [{ type: 'tool-result', result: toolOutput(update) }]
      : [{ type: 'tool-call', name: toolName(update), input: toolInput(update) }]
  }

  if (kind === 'file_write' || kind === 'file_change' || kind === 'artifact') {
    return fileWriteEvents(update)
  }

  if (kind === 'state_update' || kind === 'state') {
    const stateRecord = asRecord(update.state)
    const state = normalizedTag(
      stateRecord?.type ?? stateRecord?.state ?? stateRecord?.status ?? update.state ?? update.status,
    )
    if (['completed', 'complete', 'done', 'idle'].includes(state)) {
      return [{ type: 'done', stopReason: 'end_turn' }]
    }
    if (['cancelled', 'canceled'].includes(state)) {
      return [{ type: 'done', stopReason: 'cancelled' }]
    }
    if (['failed', 'error'].includes(state)) {
      const message = firstString(update.message, asRecord(update.error)?.message)
      return [
        ...(message ? [{ type: 'error' as const, message }] : []),
        { type: 'done', stopReason: 'error' },
      ]
    }
    return []
  }

  // User chunks, mode/config changes, and future ACP updates are intentionally ignored.
  return []
}

function translateAcp(root: JsonRecord): HandledEvents {
  const method = normalizedTag(root.method)
  if (method === 'session_request_permission') {
    return { handled: true, events: [permissionEvent(root)] }
  }

  const params = asRecord(root.params)
  const update = asRecord(params?.update) ?? asRecord(root.update)
  if (method === 'session_update' || update !== null) {
    return { handled: true, events: update ? translateAcpUpdate(update) : [] }
  }

  const result = asRecord(root.result)
  if (result?.stopReason !== undefined || result?.stop_reason !== undefined) {
    return {
      handled: true,
      events: [{ type: 'done', stopReason: stopReason(result.stopReason ?? result.stop_reason) }],
    }
  }

  if (root.jsonrpc === '2.0' || root.jsonrpc === '2') {
    if (root.error !== undefined) {
      return {
        handled: true,
        events: [
          { type: 'error', message: extractErrorMessage(root.error) },
          { type: 'done', stopReason: 'error' },
        ],
      }
    }
    return { handled: true, events: [] }
  }

  return { handled: false, events: [] }
}

function translateCodexItem(rootType: string, item: JsonRecord): CanvasAgentEvent[] {
  const kind = normalizedTag(item.type ?? item.kind)
  const completed = rootType === 'item_completed'

  if (kind === 'agent_message' || kind === 'assistant_message' || kind === 'message') {
    const text = extractText(item.text ?? item.content ?? item.message ?? item.delta)
    return text === null ? [] : [{ type: 'text-delta', text }]
  }

  if (kind === 'reasoning' || kind === 'analysis' || kind === 'thinking') {
    const text = extractText(item.text ?? item.content ?? item.summary ?? item)
    return text === null ? [] : [{ type: 'thinking', text }]
  }

  if (kind === 'command_execution' || kind === 'command') {
    return completed
      ? [{ type: 'tool-result', result: toolOutput(item) }]
      : [{ type: 'tool-call', name: 'command', input: toolInput(item) }]
  }

  if (kind === 'mcp_tool_call' || kind === 'tool_call' || kind === 'function_call') {
    return completed
      ? [{ type: 'tool-result', result: toolOutput(item) }]
      : [{ type: 'tool-call', name: toolName(item), input: toolInput(item) }]
  }

  if (kind === 'file_change' || kind === 'file_write') {
    return completed ? fileWriteEvents(item) : []
  }

  if (kind === 'web_search') {
    return completed
      ? [{ type: 'tool-result', result: toolOutput(item) }]
      : [{ type: 'tool-call', name: 'web_search', input: toolInput(item) }]
  }

  if (kind === 'todo_list' || kind === 'plan') {
    const text = formatPlan(item)
    return text === null ? [] : [{ type: 'thinking', text }]
  }

  if (kind === 'error') {
    return [{ type: 'error', message: extractErrorMessage(item) }]
  }

  return []
}

function translateCodex(root: JsonRecord): HandledEvents {
  const type = normalizedTag(root.type ?? root.event)

  if (type === 'thread_started' || type === 'turn_started') {
    return { handled: true, events: [] }
  }

  if (type === 'item_started' || type === 'item_updated' || type === 'item_completed') {
    const item = asRecord(root.item)
    return { handled: true, events: item ? translateCodexItem(type, item) : [] }
  }

  if (type === 'turn_completed') {
    const usage = usageEvent(root)
    return {
      handled: true,
      events: [...(usage ? [usage] : []), { type: 'done', stopReason: 'end_turn' }],
    }
  }

  if (type === 'turn_cancelled' || type === 'turn_canceled') {
    return { handled: true, events: [{ type: 'done', stopReason: 'cancelled' }] }
  }

  if (type === 'turn_failed') {
    const error = root.error ?? root.message ?? root.reason ?? 'Agent turn failed'
    return {
      handled: true,
      events: [
        { type: 'error', message: extractErrorMessage(error) },
        { type: 'done', stopReason: 'error' },
      ],
    }
  }

  return { handled: false, events: [] }
}

function translateGeneric(root: JsonRecord, source: AgentOutputSource): CanvasAgentEvent[] {
  const type = normalizedTag(root.type ?? root.event ?? root.kind)

  if (
    ['text_delta', 'message_delta', 'content_block_delta', 'output_text_delta', 'response_output_text_delta']
      .includes(type)
  ) {
    const text = extractText(root.delta ?? root.text ?? root.content ?? root)
    return text === null ? [] : [{ type: 'text-delta', text }]
  }

  if (['thinking', 'thought', 'reasoning', 'analysis'].includes(type)) {
    const text = extractText(root)
    return text === null ? [] : [{ type: 'thinking', text }]
  }

  if (['tool_call', 'tool_call_start', 'function_call'].includes(type)) {
    return [{ type: 'tool-call', name: toolName(root), input: toolInput(root) }]
  }

  if (['tool_result', 'tool_call_result', 'function_call_output'].includes(type)) {
    return [{ type: 'tool-result', result: toolOutput(root) }]
  }

  if (['file_write', 'file_change', 'artifact'].includes(type)) return fileWriteEvents(root)

  if (['plan', 'plan_update', 'todo_list'].includes(type)) {
    const text = formatPlan(root)
    return text === null ? [] : [{ type: 'thinking', text }]
  }

  if (['usage', 'usage_update', 'token_count', 'token_usage'].includes(type)) {
    const event = usageEvent(root)
    return event === null ? [] : [event]
  }

  if (['done', 'complete', 'completed', 'response_completed'].includes(type)) {
    const usage = usageEvent(root)
    return [
      ...(usage ? [usage] : []),
      { type: 'done', stopReason: stopReason(root.stopReason ?? root.stop_reason ?? root.status) },
    ]
  }

  if (['cancelled', 'canceled', 'aborted'].includes(type)) {
    return [{ type: 'done', stopReason: 'cancelled' }]
  }

  if (['error', 'failed', 'failure'].includes(type) || root.error !== undefined) {
    return [
      { type: 'error', message: extractErrorMessage(root.error ?? root) },
      { type: 'done', stopReason: 'error' },
    ]
  }

  const level = normalizedTag(root.level ?? root.severity)
  const message = firstString(root.message)
  if (source === 'stderr' && message !== null) {
    return level === 'warn' || level === 'warning' || level === 'info'
      ? [{ type: 'text-delta', text: message }]
      : [{ type: 'error', message }]
  }

  // A few JSONL CLIs only wrap assistant output in { message/content/text }.
  const role = normalizedTag(root.role)
  if (role === 'assistant' || type === 'message' || type === 'assistant_message') {
    const text = extractText(root.content ?? root.message ?? root.text)
    if (text !== null) return [{ type: 'text-delta', text }]
  }

  return []
}

/** Translate one already-parsed ACP/Codex/JSONL message. This function never throws. */
export function translateAgentMessage(
  value: unknown,
  source: AgentOutputSource = 'stdout',
): TranslationResult {
  try {
    if (typeof value === 'string') {
      return value.trim() === ''
        ? emptyResult()
        : {
            events: source === 'stderr'
              ? [{ type: 'error', message: value }]
              : [{ type: 'text-delta', text: value }],
            sessionId: null,
          }
    }

    const root = asRecord(value)
    if (!root) return emptyResult()
    const sessionId = extractSessionId(root)

    const acp = translateAcp(root)
    if (acp.handled) return { events: acp.events, sessionId }

    const codex = translateCodex(root)
    if (codex.handled) return { events: codex.events, sessionId }

    return { events: translateGeneric(root, source), sessionId }
  } catch (error) {
    return {
      events: [
        { type: 'error', message: `Could not translate agent output: ${extractErrorMessage(error)}` },
        { type: 'done', stopReason: 'error' },
      ],
      sessionId: null,
    }
  }
}

/** Parse and translate one NDJSON/plain-text line. Malformed JSON becomes plain output. */
export function translateAgentLine(
  line: string,
  source: AgentOutputSource = 'stdout',
): TranslationResult {
  if (line.trim() === '') return emptyResult()
  try {
    return translateAgentMessage(JSON.parse(line) as unknown, source)
  } catch {
    return translateAgentMessage(line, source)
  }
}

/** Explicit helper for transports that consume stderr independently. */
export function translateStderrLine(line: string): CanvasAgentEvent[] {
  return translateAgentLine(line, 'stderr').events
}

/**
 * Incremental NDJSON translator for child-process stdout/stderr.
 * It keeps independent buffers because both streams may interleave arbitrarily.
 */
export class AgentEventTranslator {
  readonly #buffers: Record<AgentOutputSource, string> = { stdout: '', stderr: '' }
  readonly #discardingLine: Record<AgentOutputSource, boolean> = { stdout: false, stderr: false }
  readonly #decoders: Record<AgentOutputSource, TextDecoder> = {
    stdout: new TextDecoder(),
    stderr: new TextDecoder(),
  }
  readonly #onSessionId: ((sessionId: string) => void) | undefined
  #sessionId: string | null = null

  constructor(options: AgentEventTranslatorOptions = {}) {
    this.#onSessionId = options.onSessionId
  }

  get sessionId(): string | null {
    return this.#sessionId
  }

  push(
    chunk: string | Uint8Array,
    source: AgentOutputSource = 'stdout',
  ): CanvasAgentEvent[] {
    let text = typeof chunk === 'string'
      ? chunk
      : this.#decoders[source].decode(chunk, { stream: true })
    if (this.#discardingLine[source]) {
      const newline = text.indexOf('\n')
      if (newline === -1) return []
      this.#discardingLine[source] = false
      text = text.slice(newline + 1)
    }
    this.#buffers[source] += text
    return this.#drainLines(source)
  }

  flush(source?: AgentOutputSource): CanvasAgentEvent[] {
    if (source) return this.#flushSource(source)
    return [...this.#flushSource('stdout'), ...this.#flushSource('stderr')]
  }

  /** Return the latest captured id and clear it, useful when handing a run to session storage. */
  takeSessionId(): string | null {
    const value = this.#sessionId
    this.#sessionId = null
    return value
  }

  #capture(sessionId: string | null): void {
    if (sessionId === null || sessionId === this.#sessionId) return
    this.#sessionId = sessionId
    this.#onSessionId?.(sessionId)
  }

  #translateLine(line: string, source: AgentOutputSource): CanvasAgentEvent[] {
    const result = translateAgentLine(line.endsWith('\r') ? line.slice(0, -1) : line, source)
    this.#capture(result.sessionId)
    return result.events
  }

  #drainLines(source: AgentOutputSource): CanvasAgentEvent[] {
    const events: CanvasAgentEvent[] = []
    let newline = this.#buffers[source].indexOf('\n')
    while (newline !== -1) {
      const line = this.#buffers[source].slice(0, newline)
      this.#buffers[source] = this.#buffers[source].slice(newline + 1)
      if (line.length > MAX_AGENT_LINE_CHARS) events.push(...lineTooLongEvents())
      else events.push(...this.#translateLine(line, source))
      newline = this.#buffers[source].indexOf('\n')
    }
    if (this.#buffers[source].length > MAX_AGENT_LINE_CHARS) {
      this.#buffers[source] = ''
      this.#discardingLine[source] = true
      events.push(...lineTooLongEvents())
    }
    return events
  }

  #flushSource(source: AgentOutputSource): CanvasAgentEvent[] {
    this.#buffers[source] += this.#decoders[source].decode()
    const events = this.#drainLines(source)
    if (this.#discardingLine[source]) {
      this.#discardingLine[source] = false
      return events
    }
    if (this.#buffers[source] !== '') {
      const line = this.#buffers[source]
      this.#buffers[source] = ''
      events.push(...this.#translateLine(line, source))
    }
    return events
  }
}

function lineTooLongEvents(): CanvasAgentEvent[] {
  return [
    { type: 'error', message: `Agent output line exceeded ${MAX_AGENT_LINE_CHARS} characters` },
    { type: 'done', stopReason: 'error' },
  ]
}
