import { EffectScope, type Disposer } from './effects.js'
import { ServiceScope, type ServiceKey } from './services.js'

export const GGAI_RUNTIME_API_VERSION = 1 as const

export interface CapabilityPluginManifest {
  readonly id: string
  readonly version: string
  readonly apiVersion: typeof GGAI_RUNTIME_API_VERSION
  readonly displayName?: string
}

export interface CapabilityPluginContext {
  readonly pluginId: string
  readonly services: ServiceScope
  effect(disposer: Disposer): Disposer
  provide<T>(key: ServiceKey<T>, value: T): Disposer
  require<T>(key: ServiceKey<T>): T
}

export interface CapabilityPlugin {
  readonly manifest: CapabilityPluginManifest
  activate(
    context: CapabilityPluginContext,
  ): void | Disposer | Promise<void | Disposer>
}

export interface SynchronousCapabilityPlugin {
  readonly manifest: CapabilityPluginManifest
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

const PLUGIN_ID = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u

/**
 * Mounts capability plugins into lifecycle-owned contexts. Providers live in
 * the shared service scope but are removed when their owning plugin unloads.
 */
export class CapabilityPluginHost {
  readonly #services: ServiceScope
  readonly #effects = new EffectScope()
  readonly #plugins = new Map<string, MountedPlugin>()
  readonly #mounting = new Set<string>()

  constructor(services = new ServiceScope({ label: 'runtime' })) {
    this.#services = services
  }

  get services(): ServiceScope {
    return this.#services
  }

  list(): CapabilityPluginManifest[] {
    return [...this.#plugins.values()].map(({ manifest }) => ({ ...manifest }))
  }

  async mount(plugin: CapabilityPlugin): Promise<Disposer> {
    const pending = this.#beginMount(plugin.manifest)
    try {
      const activationDisposer = await plugin.activate(pending.context)
      if (activationDisposer) pending.effects.add(activationDisposer)
      return this.#finishMount(pending)
    } catch (error) {
      await pending.effects.dispose().catch(() => undefined)
      throw error
    } finally {
      this.#mounting.delete(pending.id)
    }
  }

  mountSync(plugin: SynchronousCapabilityPlugin): Disposer {
    const pending = this.#beginMount(plugin.manifest)
    try {
      const activationDisposer = plugin.activate(pending.context)
      if (activationDisposer) pending.effects.add(activationDisposer)
      return this.#finishMount(pending)
    } catch (error) {
      void pending.effects.dispose().catch(() => undefined)
      throw error
    } finally {
      this.#mounting.delete(pending.id)
    }
  }

  async dispose(): Promise<void> {
    const errors: unknown[] = []
    try {
      await this.#effects.dispose()
    } catch (error) {
      errors.push(error)
    }
    try {
      await this.#services.dispose()
    } catch (error) {
      errors.push(error)
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'capability plugin host disposal failed')
  }

  #beginMount(manifest: CapabilityPluginManifest): PendingMount {
    this.#assertManifest(manifest)
    const { id } = manifest
    if (this.#effects.disposed) throw new Error('capability plugin host is disposed')
    if (this.#plugins.has(id) || this.#mounting.has(id)) {
      throw new Error(`plugin is already mounted or mounting: ${id}`)
    }
    this.#mounting.add(id)

    const lookupScope = this.#services.fork(`plugin:${id}`)
    const effects = new EffectScope()
    effects.add(() => lookupScope.dispose())
    const context: CapabilityPluginContext = {
      pluginId: id,
      services: lookupScope,
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
      require: (key) => lookupScope.require(key),
    }
    return { id, manifest: { ...manifest }, context, effects }
  }

  #finishMount(pending: PendingMount): Disposer {
    let active = true
    const dispose: Disposer = async () => {
      if (!active) return
      active = false
      this.#plugins.delete(pending.id)
      await pending.effects.dispose()
    }
    this.#plugins.set(pending.id, { manifest: pending.manifest, dispose })
    try {
      this.#effects.add(dispose)
    } catch (error) {
      this.#plugins.delete(pending.id)
      void pending.effects.dispose().catch(() => undefined)
      throw error
    }
    return dispose
  }

  #assertManifest(manifest: CapabilityPluginManifest): void {
    if (!PLUGIN_ID.test(manifest.id)) throw new TypeError(`invalid plugin id: ${manifest.id}`)
    if (!VERSION.test(manifest.version)) {
      throw new TypeError(`invalid plugin version for ${manifest.id}: ${manifest.version}`)
    }
    if (manifest.apiVersion !== GGAI_RUNTIME_API_VERSION) {
      throw new TypeError(
        `unsupported plugin apiVersion for ${manifest.id}: ${manifest.apiVersion}`,
      )
    }
  }
}
