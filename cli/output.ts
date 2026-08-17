export interface CliIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
}

export interface CliErrorPayload {
  code: string
  message: string
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliUsageError'
  }
}

export function writeResult(
  io: CliIo,
  json: boolean,
  command: string,
  result: unknown,
  human: string,
): void {
  if (json) {
    io.stdout(`${JSON.stringify({ schemaVersion: 1, ok: true, command, result })}\n`)
    return
  }
  io.stdout(human.endsWith('\n') ? human : `${human}\n`)
}

export function writeError(io: CliIo, json: boolean, error: CliErrorPayload): void {
  if (json) {
    io.stderr(`${JSON.stringify({ schemaVersion: 1, ok: false, error })}\n`)
    return
  }
  io.stderr(`Error [${error.code}]: ${error.message}\n`)
}
