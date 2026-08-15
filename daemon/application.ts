import type { Server } from 'node:http'
import { CapabilityExecutionScopes } from './capabilityScopes.js'
import { createWorkspaceSkillResolverPlugin } from './plugins/skillResolver/workspace.js'
import {
  ProjectionContributionRegistry,
  PROJECTION_CONTRIBUTION_REGISTRY_SERVICE,
} from './projectionContributions.js'
import { AgentRegistry } from './registry.js'
import { inspectRuntimeDoctor, type RuntimeDoctorReport } from './runtimeDoctor.js'
import { createDaemonServer, type DaemonServer } from './server.js'
import { CapabilitySkillAssetCatalog } from './skills/capabilityCatalog.js'
import {
  SKILL_CATALOG_READER_SERVICE,
  SKILL_RESOLVER_SERVICE,
} from './skills/contracts.js'
import { SkillAssetCatalog } from './skillAssets.js'
import type { DaemonConfig } from './startupOptions.js'

export class DaemonApplication {
  readonly config: DaemonConfig
  readonly registry: AgentRegistry
  readonly scopes: CapabilityExecutionScopes
  readonly skillAssets: SkillAssetCatalog
  readonly runSkillAssets: CapabilitySkillAssetCatalog
  readonly projectionContributions: ProjectionContributionRegistry
  #daemon: DaemonServer | null = null
  #listenPromise: Promise<void> | null = null
  #closePromise: Promise<void> | null = null

  constructor(config: DaemonConfig) {
    this.config = config
    this.registry = new AgentRegistry({
      acpxAgents: config.acpxAgents,
      acpxApprovalMode: config.acpxApprovalMode,
      codexCommand: config.codexCommand,
      acpxCommand: config.acpxCommand,
    })
    this.scopes = new CapabilityExecutionScopes(this.registry.runtimeServices)
    this.skillAssets = new SkillAssetCatalog(config.projectRoot)
    this.projectionContributions = new ProjectionContributionRegistry()
    const workspace = this.scopes.workspace(config.projectRoot)
    workspace.services.provide(
      SKILL_CATALOG_READER_SERVICE,
      this.skillAssets,
      '@ggai/skill-catalog-authority',
    )
    workspace.services.provide(
      PROJECTION_CONTRIBUTION_REGISTRY_SERVICE,
      this.projectionContributions,
      '@ggai/projection-contribution-authority',
    )
    workspace.mountSync(createWorkspaceSkillResolverPlugin())
    this.runSkillAssets = new CapabilitySkillAssetCatalog(
      this.skillAssets,
      workspace.services.require(SKILL_RESOLVER_SERVICE),
    )
  }

  get server(): Server {
    return this.#server().server
  }

  runtimeDiagnostics() {
    return this.registry.runtimeDiagnostics()
  }

  runtimeDoctor(): Promise<RuntimeDoctorReport> {
    return inspectRuntimeDoctor(this.registry)
  }

  listen(): Promise<void> {
    if (this.config.operation !== 'serve') {
      return Promise.reject(new Error(
        `daemon operation ${this.config.operation} does not start an HTTP server`,
      ))
    }
    if (this.#closePromise) {
      return Promise.reject(new Error('daemon application is closing or closed'))
    }
    this.#listenPromise ??= new Promise<void>((resolve, reject) => {
      const server = this.#server().server
      const onError = (error: Error) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.config.port, this.config.host)
    })
    return this.#listenPromise
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#closeApplication()
    return this.#closePromise
  }

  async #closeApplication(): Promise<void> {
    const errors: unknown[] = []
    if (this.#daemon) {
      try {
        // Run close events release Run scopes before the Workspace/Application
        // capability tree is disposed.
        await this.#daemon.runs.close()
      } catch (error) {
        errors.push(error)
      }
    }
    try {
      await this.scopes.dispose()
    } catch (error) {
      errors.push(error)
    }
    try {
      if (this.#daemon) await this.#daemon.close()
      else await this.registry.dispose()
    } catch (error) {
      errors.push(error)
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'daemon application close failed')
  }

  #server(): DaemonServer {
    if (this.#closePromise) throw new Error('daemon application is closing or closed')
    this.#daemon ??= createDaemonServer({
      ...this.config,
      registry: this.registry,
      // The compatibility facade delegates mutation and binding reads to the
      // Core catalog, while immutable Run resolution crosses SKILL_RESOLVER_SERVICE.
      skillAssetCatalog: this.runSkillAssets,
      runCapabilityReceipts: {
        projectRoot: this.config.projectRoot,
        scopes: this.scopes,
        profile: this.registry.runtimeProfile,
        agentProvider: (agentId) => this.registry.snapshot()
          .find((provider) => provider.agentIds.includes(agentId))?.id,
        skillProvider: '@ggai/workspace-skill-resolver',
      },
    })
    return this.#daemon
  }
}
