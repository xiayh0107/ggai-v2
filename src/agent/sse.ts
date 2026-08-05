export interface SseMessage {
  event: string
  data: string
  id?: string
}

interface SseReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
  cancel(reason?: unknown): Promise<void>
  releaseLock(): void
}

interface SseResponseBody {
  getReader(): SseReader
}

export interface SseResponse {
  body: SseResponseBody | null
}

export type SseErrorFactory = (message: string, cause?: unknown) => Error

/** Incremental SSE parser supporting LF, CRLF, CR, comments, and multiline data. */
class SseParser {
  private buffer = ''
  private eventName = ''
  private dataLines: string[] = []
  private lastEventId: string | undefined
  private hasData = false
  private readonly dispatch: (message: SseMessage) => void

  constructor(dispatch: (message: SseMessage) => void) {
    this.dispatch = dispatch
  }

  push(text: string): void {
    this.buffer += text
    this.drainLines(false)
  }

  finish(): void {
    this.drainLines(true)
    if (this.buffer.length > 0) {
      this.processLine(this.buffer)
      this.buffer = ''
    }
    this.dispatchMessage()
  }

  private drainLines(flushTrailingCr: boolean): void {
    while (this.buffer.length > 0) {
      const lfIndex = this.buffer.indexOf('\n')
      const crIndex = this.buffer.indexOf('\r')
      let lineEnd: number

      if (lfIndex < 0) lineEnd = crIndex
      else if (crIndex < 0) lineEnd = lfIndex
      else lineEnd = Math.min(lfIndex, crIndex)

      if (lineEnd < 0) return
      if (!flushTrailingCr
        && this.buffer[lineEnd] === '\r'
        && lineEnd === this.buffer.length - 1) return

      const line = this.buffer.slice(0, lineEnd)
      const isCrLf = this.buffer[lineEnd] === '\r' && this.buffer[lineEnd + 1] === '\n'
      this.buffer = this.buffer.slice(lineEnd + (isCrLf ? 2 : 1))
      this.processLine(line)
    }
  }

  private processLine(line: string): void {
    if (line === '') {
      this.dispatchMessage()
      return
    }
    if (line.startsWith(':')) return

    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    switch (field) {
      case 'event':
        this.eventName = value
        break
      case 'data':
        this.dataLines.push(value)
        this.hasData = true
        break
      case 'id':
        if (!value.includes('\0')) this.lastEventId = value
        break
      case 'retry':
        // Reconnection is deliberately owned by the caller, not this parser.
        break
      default:
        // The SSE specification ignores unknown fields.
        break
    }
  }

  private dispatchMessage(): void {
    if (!this.hasData) {
      this.eventName = ''
      return
    }
    const message: SseMessage = {
      event: this.eventName || 'message',
      data: this.dataLines.join('\n'),
      ...(this.lastEventId === undefined ? {} : { id: this.lastEventId }),
    }
    this.eventName = ''
    this.dataLines = []
    this.hasData = false
    this.dispatch(message)
  }
}

/**
 * Consume an SSE response until EOF or until the callback marks a protocol
 * message as terminal. The latter is important for fetch bridges that keep the
 * HTTP stream open after the daemon's authoritative close event.
 */
export async function consumeSse(
  response: SseResponse,
  onMessage: (message: SseMessage) => boolean | void,
  createError: SseErrorFactory = (message, cause) => new Error(message, { cause }),
): Promise<void> {
  if (!response.body) {
    throw createError('Daemon SSE response did not include a response body')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let terminalMessageReceived = false
  const parser = new SseParser((message) => {
    if (onMessage(message) === true) terminalMessageReceived = true
  })
  let completed = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      let text: string
      try {
        text = decoder.decode(value, { stream: true })
      } catch (error) {
        throw createError('Daemon SSE response was not valid UTF-8', error)
      }
      parser.push(text)
      if (terminalMessageReceived) {
        completed = true
        try {
          void reader.cancel().catch(() => undefined)
        } catch {
          // The protocol close is authoritative; transport cleanup is best-effort.
        }
        break
      }
    }
    if (!terminalMessageReceived) {
      let trailingText: string
      try {
        trailingText = decoder.decode()
      } catch (error) {
        throw createError('Daemon SSE response ended with invalid UTF-8', error)
      }
      parser.push(trailingText)
      parser.finish()
      completed = true
    }
  } finally {
    if (!completed) {
      try {
        void reader.cancel().catch(() => undefined)
      } catch {
        // Preserve the original stream/protocol/callback error.
      }
    }
    reader.releaseLock()
  }
}
