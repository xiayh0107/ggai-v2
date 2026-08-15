import type { Server } from 'node:http'
import { CapabilityExecutionScopes } from './capabilityScopes.js'
import { AgentRegistry } from './registry.js'
import { inspectRuntimeDoctor, type RuntimeDoctorReport } from './runtimeDoctor.js'
import { createDaemonServer, type DaemonServer } from './server.js'
import type { DaemonConfig } from './startupOptions.js'

export class DaemonApplication {
  readonly config: DaemonConfig
  readonly registry: AgentRegistry
  readonly scopes: CapabilityExecutionScopes
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
    })
    return this.#daemon
  }
}
