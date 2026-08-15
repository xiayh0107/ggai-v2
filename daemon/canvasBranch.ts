import { createHash } from 'node:crypto'
import { parseCanvasBranch } from './protocol.js'

/** Opaque branch directory: logical branch names never participate in filesystem paths. */
export function canvasBranchStorageId(branch: string): string {
  return createHash('sha256').update(parseCanvasBranch(branch), 'utf8').digest('hex')
}
