import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rename, unlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export interface FileQuarantine {
  filePath: string
  quarantinePath: string
  reason: string
}

/** Durably replaces a UTF-8 file without exposing a partially-written result. */
export async function atomicWriteText(filePath: string, contents: string): Promise<void> {
  const directory = dirname(filePath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporaryPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let handle: Awaited<ReturnType<typeof open>> | undefined

  try {
    handle = await open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporaryPath, filePath)
    await syncDirectory(directory)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

/** Reads exactly the size established by a prior fstat and rejects concurrent growth/shrink. */
export async function readExactFileBytes(
  handle: FileHandle,
  expectedSize: number,
  maximumSize: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(expectedSize)
    || expectedSize < 0
    || expectedSize > maximumSize) {
    throw new TypeError('file size exceeds the supported bound')
  }
  const buffer = Buffer.allocUnsafe(expectedSize + 1)
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  if (offset !== expectedSize) {
    throw new Error('file size changed while it was being read')
  }
  return buffer.subarray(0, expectedSize)
}

/** Moves an invalid persistent file aside without deleting its contents. */
export async function quarantineFile(
  filePath: string,
  cause: unknown,
): Promise<FileQuarantine> {
  const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, '')
  const quarantinePath = `${filePath}.corrupt-${stamp}-${randomUUID()}`
  try {
    await rename(filePath, quarantinePath)
    await syncDirectory(dirname(filePath))
  } catch (error) {
    throw new Error(`Could not quarantine invalid persistent file at ${filePath}`, {
      cause: new AggregateError([cause, error]),
    })
  }
  return {
    filePath,
    quarantinePath,
    reason: errorMessage(cause),
  }
}

/** Finds a prior quarantine so a restart cannot silently overwrite corruption. */
export async function findLatestQuarantine(filePath: string): Promise<string | undefined> {
  const directory = dirname(filePath)
  const prefix = `${basename(filePath)}.corrupt-`
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined
    throw error
  }
  const latest = entries.filter((entry) => entry.startsWith(prefix)).sort().at(-1)
  return latest ? join(directory, latest) : undefined
}

export function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch (error) {
    // Some platforms do not support fsync on directory handles. The file was
    // still synced before its atomic rename, so retain that guarantee there.
    if (!isUnsupportedDirectorySync(error)) throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return isNodeError(error, 'EINVAL')
    || isNodeError(error, 'ENOTSUP')
    || isNodeError(error, 'EISDIR')
    || isNodeError(error, 'EBADF')
}
