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

interface MountedPlugin {
  readonly manifest: CapabilityPluginManifest
  readonly dispose: Disposer
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
    this.#assertManifest(plugin.manifest)
    const { id } = plugin.manifest
    if (this.#plugins.has(id)) throw new Error(`plugin is already mounted: ${id}`)

    const lookupScope = this.#services.fork(`plugin:${id}`)
    const pluginEffects = new EffectScope()
    pluginEffects.add(() => lookupScope.dispose())
    const context: CapabilityPluginContext = {
      pluginId: id,
      services: lookupScope,
      effect: (disposer) => pluginEffects.add(disposer),
      provide: (key, value) => {
        const release = this.#services.provide(key, value, id)
        return pluginEffects.add(release)
      },
      require: (key) => lookupScope.require(key),
    }

    try {
      const activationDisposer = await plugin.activate(context)
      if (activationDisposer) pluginEffects.add(activationDisposer)
    } catch (error) {
      await pluginEffects.dispose().catch(() => undefined)
      throw error
    }

    let active = true
    const dispose: Disposer = async () => {
      if (!active) return
      active = false
      this.#plugins.delete(id)
      await pluginEffects.dispose()
    }
    this.#plugins.set(id, { manifest: { ...plugin.manifest }, dispose })
    this.#effects.add(dispose)
    return dispose
  }

  async dispose(): Promise<void> {
    await this.#effects.dispose()
    await this.#services.dispose()
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
