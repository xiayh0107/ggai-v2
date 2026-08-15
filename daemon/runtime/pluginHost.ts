import { EffectScope, type Disposer } from './effects.js'
import {
  TypedEventBus,
  type EventListener,
  type RuntimeEventFailure,
  type RuntimeEventSource,
} from './events.js'
import {
  inspectServiceKeyReference,
  ServiceScope,
  type ServiceKey,
  type ServiceKeyReference,
  type ServiceReader,
} from './services.js'

export const GGAI_RUNTIME_API_VERSION = 1 as const

export interface CapabilityPluginManifest {
  readonly id: string
  readonly version: string
  readonly apiVersion: typeof GGAI_RUNTIME_API_VERSION
  readonly displayName?: string
}

export interface CapabilityRuntimeEventMap {
  'plugin/activating': { readonly manifest: CapabilityPluginManifest }
  'plugin/mounted': { readonly manifest: CapabilityPluginManifest }
  'plugin/activation-failed': {
    readonly manifest: CapabilityPluginManifest
    readonly error: unknown
  }
  'plugin/unmounting': { readonly manifest: CapabilityPluginManifest }
  'plugin/unmounted': {
    readonly manifest: CapabilityPluginManifest
    readonly error?: unknown
  }
}

export interface CapabilityPluginContext {
  readonly pluginId: string
  readonly services: ServiceReader
  effect(disposer: Disposer): Disposer
  provide<T>(key: ServiceKey<T>, value: T): Disposer
  require<T>(key: ServiceKey<T>): T
  onEvent<Name extends Extract<keyof CapabilityRuntimeEventMap, string>>(
    event: Name,
    listener: EventListener<CapabilityRuntimeEventMap[Name]>,
  ): Disposer
}

export interface CapabilityPlugin {
  readonly manifest: CapabilityPluginManifest
  readonly inject?: readonly ServiceKeyReference[]
  activate(context: CapabilityPluginContext): void | Disposer | Promise<void | Disposer>
}

export interface SynchronousCapabilityPlugin {
  readonly manifest: CapabilityPluginManifest
  readonly inject?: readonly ServiceKeyReference[]
  activate(context: CapabilityPluginContext): void | Disposer
}

interface MountedPlugin {
  readonly manifest: CapabilityPluginManifest
  readonly dispose: Disposer
}

interface PendingMount {
  readonly id: string
  readonly manifest: CapabilityPluginManifest
  readonly context: CapabilityPluginContext
  readonly effects: EffectScope
}

class PluginServiceReader implements ServiceReader {
  readonly #scope: ServiceScope
  readonly #injectedIds: ReadonlySet<string>

  constructor(scope: ServiceScope, injectedIds: ReadonlySet<string>) {
    this.#scope = scope
    this.#injectedIds = injectedIds
  }

  get<T>(key: ServiceKey<T>): T | undefined {
    this.#assertInjected(key)
    return this.#scope.get(key)
  }

  require<T>(key: ServiceKey<T>): T {
    this.#assertInjected(key)
    return this.#scope.require(key)
  }

  ownerOf<T>(key: ServiceKey<T>): string | undefined {
    this.#assertInjected(key)
    return this.#scope.ownerOf(key)
  }

  #assertInjected<T>(key: ServiceKey<T>): void {
    if (!this.#injectedIds.has(key.id)) {
      throw new Error(`plugin did not declare required service: ${key.id}`)
    }
  }
}

const MAX_RUNTIME_EVENT_FAILURES = 100
const PLUGIN_ID = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u

export class CapabilityPluginHost {
  readonly #services: ServiceScope
  readonly #events = new TypedEventBus<CapabilityRuntimeEventMap>()
  readonly #eventFailures: RuntimeEventFailure[] = []
  readonly #effects = new EffectScope()
  readonly #plugins = new Map<string, MountedPlugin>()
  readonly #mounting = new Set<string>()
  readonly #pendingMounts = new Set<Promise<Disposer>>()
  #disposePromise: Promise<void> | null = null

  constructor(services = new ServiceScope({ label: 'runtime' })) {
    this.#services = services
  }

  get services(): ServiceScope {
    return this.#services
  }

  get events(): RuntimeEventSource<CapabilityRuntimeEventMap> {
    return this.#events
  }

  list(): CapabilityPluginManifest[] {
    return [...this.#plugins.values()].map(({ manifest }) => ({ ...manifest }))
  }

  eventFailures(): RuntimeEventFailure[] {
    return this.#eventFailures.map((failure) => ({ ...failure }))
  }

  drainEventFailures(): RuntimeEventFailure[] {
    return this.#eventFailures.splice(0)
  }

  mount(plugin: CapabilityPlugin): Promise<Disposer> {
    let pending: PendingMount
    try {
      pending = this.#beginMount(plugin)
    } catch (error) {
      return Promise.reject(error)
    }
    const operation = this.#completeMount(plugin, pending)
    this.#pendingMounts.add(operation)
    void operation.then(
      () => this.#pendingMounts.delete(operation),
      () => this.#pendingMounts.delete(operation),
    )
    return operation
  }

  mountSync(plugin: SynchronousCapabilityPlugin): Disposer {
    const pending = this.#beginMount(plugin)
    try {
      const activationDisposer = plugin.activate(pending.context)
      if (activationDisposer) pending.effects.add(activationDisposer)
      return this.#finishMount(pending)
    } catch (error) {
      this.#emit('plugin/activation-failed', { manifest: pending.manifest, error })
      void pending.effects.dispose().catch(() => undefined)
      throw error
    } finally {
      this.#mounting.delete(pending.id)
    }
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#disposeHost()
    return this.#disposePromise
  }

  async #disposeHost(): Promise<void> {
    const errors: unknown[] = []
    await Promise.allSettled([...this.#pendingMounts])
    try {
      await this.#effects.dispose()
    } catch (error) {
      errors.push(error)
    }
    this.#events.dispose()
    try {
      await this.#services.dispose()
    } catch (error) {
      errors.push(error)
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new AggregateError(errors, 'capability plugin host disposal failed')
    }
  }

  async #completeMount(
    plugin: CapabilityPlugin,
    pending: PendingMount,
  ): Promise<Disposer> {
    try {
      const activationDisposer = await plugin.activate(pending.context)
      if (activationDisposer) pending.effects.add(activationDisposer)
      return this.#finishMount(pending)
    } catch (error) {
      this.#emit('plugin/activation-failed', { manifest: pending.manifest, error })
      try {
        await pending.effects.dispose()
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `plugin activation and rollback failed: ${pending.id}`,
        )
      }
      throw error
    } finally {
      this.#mounting.delete(pending.id)
    }
  }

  #beginMount(plugin: Pick<CapabilityPlugin, 'manifest' | 'inject'>): PendingMount {
    const pinnedManifest = inspectCapabilityPluginManifest(plugin.manifest)
    const { id } = pinnedManifest
    if (this.#disposePromise) throw new Error('capability plugin host is disposing or disposed')
    if (this.#plugins.has(id) || this.#mounting.has(id)) {
      throw new Error(`plugin is already mounted or mounting: ${id}`)
    }
    const injectedIds = inspectCapabilityPluginInjection(plugin.inject)
    for (const serviceId of injectedIds) {
      if (this.#services.get({ id: serviceId }) === undefined) {
        throw new Error(`required service is unavailable for ${id}: ${serviceId}`)
      }
    }
    this.#mounting.add(id)
    this.#emit('plugin/activating', { manifest: pinnedManifest })

    const lookupScope = this.#services.fork(`plugin:${id}`)
    const services = new PluginServiceReader(lookupScope, new Set(injectedIds))
    const effects = new EffectScope()
    effects.add(() => lookupScope.dispose())
    const context: CapabilityPluginContext = {
      pluginId: id,
      services,
      effect: (disposer) => effects.add(disposer),
      provide: (key, value) => {
        const release = this.#services.provide(key, value, id)
        try {
          return effects.add(release)
        } catch (error) {
          release()
          throw error
        }
      },
      require: (key) => services.require(key),
      onEvent: (event, listener) => effects.add(this.#events.on(event, listener)),
    }
    return { id, manifest: pinnedManifest, context, effects }
  }

  #finishMount(pending: PendingMount): Disposer {
    let active = true
    const dispose: Disposer = async () => {
      if (!active) return
      active = false
      this.#emit('plugin/unmounting', { manifest: pending.manifest })
      this.#plugins.delete(pending.id)
      let disposalError: unknown
      try {
        await pending.effects.dispose()
      } catch (error) {
        disposalError = error
      }
      this.#emit('plugin/unmounted', {
        manifest: pending.manifest,
        ...(disposalError === undefined ? {} : { error: disposalError }),
      })
      if (disposalError !== undefined) throw disposalError
    }
    this.#plugins.set(pending.id, { manifest: pending.manifest, dispose })
    try {
      this.#effects.add(dispose)
    } catch (error) {
      this.#plugins.delete(pending.id)
      void pending.effects.dispose().catch(() => undefined)
      throw error
    }
    this.#emit('plugin/mounted', { manifest: pending.manifest })
    return dispose
  }

  #emit<Name extends Extract<keyof CapabilityRuntimeEventMap, string>>(
    event: Name,
    payload: Readonly<CapabilityRuntimeEventMap[Name]>,
  ): void {
    this.#eventFailures.push(...this.#events.emit(event, payload))
    if (this.#eventFailures.length > MAX_RUNTIME_EVENT_FAILURES) {
      this.#eventFailures.splice(0, this.#eventFailures.length - MAX_RUNTIME_EVENT_FAILURES)
    }
  }
}

export function inspectCapabilityPluginManifest(
  manifest: CapabilityPluginManifest,
): CapabilityPluginManifest {
  if (!PLUGIN_ID.test(manifest.id)) throw new TypeError(`invalid plugin id: ${manifest.id}`)
  if (!VERSION.test(manifest.version)) {
    throw new TypeError(`invalid plugin version for ${manifest.id}: ${manifest.version}`)
  }
  if (manifest.apiVersion !== GGAI_RUNTIME_API_VERSION) {
    throw new TypeError(
      `unsupported plugin apiVersion for ${manifest.id}: ${manifest.apiVersion}`,
    )
  }
  return Object.freeze({ ...manifest })
}

export function inspectCapabilityPluginInjection(
  injection: readonly ServiceKeyReference[] | undefined,
): readonly string[] {
  if (injection === undefined) return Object.freeze([])
  if (!Array.isArray(injection)) throw new TypeError('plugin inject must be an array')
  const ids = injection.map(inspectServiceKeyReference)
  if (new Set(ids).size !== ids.length) {
    throw new TypeError(`plugin inject contains duplicate service keys: ${ids.join(', ')}`)
  }
  return Object.freeze(ids)
}
