import path from 'node:path'
import {
  createRunCapabilityReceipt,
  type RunCapabilityReceipt,
  type SemanticCapabilityReceipt,
} from './capabilityReceipt.js'
import type { CapabilityProfileSnapshot } from './runtime/composition.js'
import {
  defineService,
  type ServiceProviderSnapshot,
  ServiceScope,
} from './runtime/services.js'

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/u

export interface WorkspaceCapabilityIdentity {
  readonly projectDir: string
}

export interface RunCapabilityIdentity extends WorkspaceCapabilityIdentity {
  readonly runId: string
}

export const WORKSPACE_CAPABILITY_IDENTITY_SERVICE =
  defineService<WorkspaceCapabilityIdentity>('ggai.workspace-context.v1')
export const RUN_CAPABILITY_IDENTITY_SERVICE =
  defineService<RunCapabilityIdentity>('ggai.run-context.v1')

export interface CapabilityScopeSnapshot {
  readonly application: readonly ServiceProviderSnapshot[]
  readonly workspaces: readonly {
    readonly projectDir: string
    readonly services: readonly ServiceProviderSnapshot[]
    readonly runs: readonly {
      readonly runId: string
      readonly services: readonly ServiceProviderSnapshot[]
    }[]
  }[]
}

export class CapabilityExecutionScopes {
  readonly application: ServiceScope
  readonly #workspaces = new Map<string, WorkspaceCapabilityScope>()
  #disposePromise: Promise<void> | null = null

  constructor(parent: ServiceScope) {
    this.application = parent.fork('execution:application')
  }

  workspace(projectDir: string): WorkspaceCapabilityScope {
    this.#assertOpen()
    const canonical = path.resolve(projectDir)
    let workspace = this.#workspaces.get(canonical)
    if (!workspace) {
      workspace = new WorkspaceCapabilityScope(this.application, canonical, () => {
        if (this.#workspaces.get(canonical) === workspace) this.#workspaces.delete(canonical)
      })
      this.#workspaces.set(canonical, workspace)
    }
    return workspace
  }

  snapshot(): CapabilityScopeSnapshot {
    this.#assertOpen()
    return Object.freeze({
      application: Object.freeze(this.application.snapshot()),
      workspaces: Object.freeze([...this.#workspaces.values()]
        .sort((left, right) => left.projectDir.localeCompare(right.projectDir))
        .map((workspace) => workspace.snapshot())),
    })
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#disposeAll()
    return this.#disposePromise
  }

  async #disposeAll(): Promise<void> {
    const workspaces = [...this.#workspaces.values()].reverse()
    this.#workspaces.clear()
    for (const workspace of workspaces) await workspace.dispose()
    await this.application.dispose()
  }

  #assertOpen(): void {
    if (this.#disposePromise) throw new Error('capability execution scopes are disposing or disposed')
  }
}

export class WorkspaceCapabilityScope {
  readonly projectDir: string
  readonly services: ServiceScope
  readonly #runs = new Map<string, RunCapabilityScope>()
  readonly #onDispose: () => void
  #disposePromise: Promise<void> | null = null

  constructor(parent: ServiceScope, projectDir: string, onDispose: () => void) {
    this.projectDir = projectDir
    this.#onDispose = onDispose
    this.services = parent.fork(`workspace:${projectDir}`)
    this.services.provide(
      WORKSPACE_CAPABILITY_IDENTITY_SERVICE,
      Object.freeze({ projectDir }),
      '@ggai/workspace-scope',
    )
  }

  run(runId: string): RunCapabilityScope {
    this.#assertOpen()
    if (!RUN_ID.test(runId)) throw new TypeError(`invalid Run scope id: ${runId}`)
    if (this.#runs.has(runId)) throw new Error(`Run scope already exists: ${runId}`)
    const run = new RunCapabilityScope(this.services, this.projectDir, runId, () => {
      if (this.#runs.get(runId) === run) this.#runs.delete(runId)
    })
    this.#runs.set(runId, run)
    return run
  }

  snapshot() {
    this.#assertOpen()
    return Object.freeze({
      projectDir: this.projectDir,
      services: Object.freeze(this.services.snapshot()),
      runs: Object.freeze([...this.#runs.values()]
        .sort((left, right) => left.runId.localeCompare(right.runId))
        .map((run) => run.snapshot())),
    })
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#disposeAll()
    return this.#disposePromise
  }

  async #disposeAll(): Promise<void> {
    const runs = [...this.#runs.values()].reverse()
    this.#runs.clear()
    for (const run of runs) await run.dispose()
    await this.services.dispose()
    this.#onDispose()
  }

  #assertOpen(): void {
    if (this.#disposePromise) throw new Error(`Workspace scope is disposing or disposed: ${this.projectDir}`)
  }
}

export class RunCapabilityScope {
  readonly projectDir: string
  readonly runId: string
  readonly services: ServiceScope
  readonly #onDispose: () => void
  #disposePromise: Promise<void> | null = null

  constructor(parent: ServiceScope, projectDir: string, runId: string, onDispose: () => void) {
    this.projectDir = projectDir
    this.runId = runId
    this.#onDispose = onDispose
    this.services = parent.fork(`run:${runId}`)
    this.services.provide(
      RUN_CAPABILITY_IDENTITY_SERVICE,
      Object.freeze({ projectDir, runId }),
      '@ggai/run-scope',
    )
  }

  snapshot() {
    this.#assertOpen()
    return Object.freeze({
      runId: this.runId,
      services: Object.freeze(this.services.snapshot()),
    })
  }

  acceptCapabilities(
    profile: CapabilityProfileSnapshot,
    semanticCapabilities: readonly SemanticCapabilityReceipt[] = [],
  ): RunCapabilityReceipt {
    this.#assertOpen()
    return createRunCapabilityReceipt({
      runId: this.runId,
      profile,
      services: this.services.snapshot(),
      semanticCapabilities,
    })
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#disposeRun()
    return this.#disposePromise
  }

  async #disposeRun(): Promise<void> {
    await this.services.dispose()
    this.#onDispose()
  }

  #assertOpen(): void {
    if (this.#disposePromise) throw new Error(`Run scope is disposing or disposed: ${this.runId}`)
  }
}
