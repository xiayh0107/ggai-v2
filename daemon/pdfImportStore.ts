import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { PdfImportRecord, PdfMaterializationPlan } from '../src/pdf/contracts.js'
import { atomicWriteText, isNodeError } from './atomic-file.js'
import { canonicalizePotentialPath, isPathWithin } from './permissions.js'

const MAX_STORE_BYTES = 32 * 1024 * 1024
const MAX_IMPORTS = 1_000
const MAX_PLANS = 4_000

interface PdfImportStoreDocument {
  schemaVersion: 1
  imports: Array<{ record: PdfImportRecord; initialPlan: PdfMaterializationPlan }>
  plans: PdfMaterializationPlan[]
}

export class PdfImportStore {
  readonly projectDir: string
  readonly filePath: string
  #tail: Promise<void> = Promise.resolve()

  constructor(projectDir: string) {
    this.projectDir = path.resolve(projectDir)
    this.filePath = path.join(this.projectDir, '.gg', 'runtime', 'pdf-imports.json')
  }

  putImport(record: PdfImportRecord, initialPlan: PdfMaterializationPlan): Promise<void> {
    return this.#exclusive(async () => {
      const document = await this.#read()
      const existing = document.imports.find((entry) => entry.record.importId === record.importId)
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify({ record, initialPlan })) {
          throw new Error('PDF import identity was reused with different content')
        }
        return
      }
      if (document.imports.length >= MAX_IMPORTS) throw new Error('PDF import store is full')
      document.imports.push({ record: structuredClone(record), initialPlan: structuredClone(initialPlan) })
      document.plans.push(structuredClone(initialPlan))
      await this.#write(document)
    })
  }

  putPlan(plan: PdfMaterializationPlan): Promise<void> {
    return this.#exclusive(async () => {
      const document = await this.#read()
      const existing = document.plans.find((candidate) => candidate.planId === plan.planId)
      if (existing) {
        if (existing.digest !== plan.digest || JSON.stringify(existing) !== JSON.stringify(plan)) {
          throw new Error('PDF plan identity was reused with different content')
        }
        return
      }
      if (document.plans.length >= MAX_PLANS) throw new Error('PDF plan store is full')
      document.plans.push(structuredClone(plan))
      await this.#write(document)
    })
  }

  getImport(importId: string): Promise<{ record: PdfImportRecord; initialPlan: PdfMaterializationPlan } | null> {
    return this.#exclusive(async () => {
      const entry = (await this.#read()).imports.find((candidate) => candidate.record.importId === importId)
      return entry ? structuredClone(entry) : null
    })
  }

  getPlan(planId: string): Promise<PdfMaterializationPlan | null> {
    return this.#exclusive(async () => {
      const plan = (await this.#read()).plans.find((candidate) => candidate.planId === planId)
      return plan ? structuredClone(plan) : null
    })
  }

  async #read(): Promise<PdfImportStoreDocument> {
    await this.#assertSafePath()
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
      const info = await handle.stat()
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_STORE_BYTES) {
        throw new Error('PDF import store is unsafe or too large')
      }
      const value = JSON.parse(await handle.readFile('utf8')) as unknown
      if (!isRecord(value) || value.schemaVersion !== 1
        || !Array.isArray(value.imports) || value.imports.length > MAX_IMPORTS
        || !Array.isArray(value.plans) || value.plans.length > MAX_PLANS) {
        throw new Error('PDF import store is invalid')
      }
      return structuredClone(value) as unknown as PdfImportStoreDocument
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return { schemaVersion: 1, imports: [], plans: [] }
      throw error
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  async #write(document: PdfImportStoreDocument): Promise<void> {
    document.imports.sort((left, right) => left.record.importId.localeCompare(right.record.importId))
    document.plans.sort((left, right) => left.planId.localeCompare(right.planId))
    const text = `${JSON.stringify(document, null, 2)}\n`
    if (Buffer.byteLength(text) > MAX_STORE_BYTES) throw new Error('PDF import store exceeds byte limit')
    await atomicWriteText(this.filePath, text)
  }

  async #assertSafePath(): Promise<void> {
    const canonicalProject = await realpath(this.projectDir)
    const canonicalFile = await canonicalizePotentialPath(this.filePath)
    if (canonicalProject !== this.projectDir
      || canonicalFile !== this.filePath
      || !isPathWithin(canonicalProject, canonicalFile)) {
      throw new Error('PDF import store path is unsafe')
    }
    try {
      const info = await lstat(this.filePath)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('PDF import store is not a regular file')
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation)
    this.#tail = result.then(() => undefined, () => undefined)
    return result
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
