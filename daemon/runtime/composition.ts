import { EffectScope, type Disposer } from './effects.js'
import {
  inspectCapabilityPluginManifest,
  type CapabilityPlugin,
  type CapabilityPluginHost,
  type CapabilityPluginManifest,
  type SynchronousCapabilityPlugin,
} from './pluginHost.js'

export const CAPABILITY_PROFILE_SCHEMA_VERSION = 1 as const
const MAX_PROFILE_BUNDLES = 64
const MAX_PROFILE_PLUGINS = 512

export interface CapabilityBundle<Plugin extends CapabilityPlugin = CapabilityPlugin> {
  readonly id: string
  readonly version: string
  readonly plugins: readonly Plugin[]
}

export interface CapabilityProfile<Plugin extends CapabilityPlugin = CapabilityPlugin> {
  readonly schemaVersion: typeof CAPABILITY_PROFILE_SCHEMA_VERSION
  readonly id: string
  readonly version: string
  readonly bundles: readonly CapabilityBundle<Plugin>[]
}

export interface CapabilityProfileSnapshot {
  readonly schemaVersion: typeof CAPABILITY_PROFILE_SCHEMA_VERSION
  readonly id: string
  readonly version: string
  readonly bundles: readonly {
    readonly id: string
    readonly version: string
    readonly plugins: readonly CapabilityPluginManifest[]
  }[]
}

interface PreparedCapabilityProfile<Plugin extends CapabilityPlugin> {
  readonly snapshot: CapabilityProfileSnapshot
  readonly bundles: readonly {
    readonly plugins: readonly Plugin[]
  }[]
}

const COMPOSITION_ID = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u

/**
 * Validates and snapshots the complete composition before activation, mounts
 * plugins in bundle order, and awaits rollback if a later activation fails.
 */
export async function mountCapabilityProfile(
  host: CapabilityPluginHost,
  profile: CapabilityProfile,
): Promise<Disposer> {
  const prepared = prepareCapabilityProfile(profile)
  const effects = new EffectScope()
  try {
    for (const bundle of prepared.bundles) {
      for (const plugin of bundle.plugins) {
        effects.add(await host.mount(plugin))
      }
    }
  } catch (error) {
    try {
      await effects.dispose()
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `capability profile activation and rollback failed: ${profile.id}`,
      )
    }
    throw error
  }
  return () => effects.dispose()
}

/**
 * Synchronous compatibility path for constructor-time boot. Structural errors
 * are rejected before the first plugin activates; unload still follows the
 * ordinary asynchronous EffectScope contract.
 */
export function mountCapabilityProfileSync(
  host: CapabilityPluginHost,
  profile: CapabilityProfile<SynchronousCapabilityPlugin>,
): Disposer {
  const prepared = prepareCapabilityProfile(profile)
  const effects = new EffectScope()
  try {
    for (const bundle of prepared.bundles) {
      for (const plugin of bundle.plugins) {
        effects.add(host.mountSync(plugin))
      }
    }
  } catch (error) {
    void effects.dispose().catch(() => undefined)
    throw error
  }
  return () => effects.dispose()
}

export function inspectCapabilityProfile(
  profile: CapabilityProfile,
): CapabilityProfileSnapshot {
  return prepareCapabilityProfile(profile).snapshot
}

function prepareCapabilityProfile<Plugin extends CapabilityPlugin>(
  profile: CapabilityProfile<Plugin>,
): PreparedCapabilityProfile<Plugin> {
  if (profile.schemaVersion !== CAPABILITY_PROFILE_SCHEMA_VERSION) {
    throw new TypeError(
      `unsupported capability profile schemaVersion for ${profile.id}: ${profile.schemaVersion}`,
    )
  }
  assertCompositionIdentity(profile.id, profile.version, 'profile')
  if (!Array.isArray(profile.bundles)) {
    throw new TypeError(`capability profile bundles must be an array: ${profile.id}`)
  }
  if (profile.bundles.length > MAX_PROFILE_BUNDLES) {
    throw new TypeError(`capability profile has too many bundles: ${profile.id}`)
  }

  const bundleIds = new Set<string>()
  const pluginIds = new Set<string>()
  let pluginCount = 0
  const preparedBundles: Array<{ readonly plugins: readonly Plugin[] }> = []
  const snapshotBundles: CapabilityProfileSnapshot['bundles'][number][] = []

  for (const bundle of profile.bundles) {
    assertCompositionIdentity(bundle.id, bundle.version, 'bundle')
    if (bundleIds.has(bundle.id)) {
      throw new TypeError(`duplicate capability bundle in ${profile.id}: ${bundle.id}`)
    }
    bundleIds.add(bundle.id)
    if (!Array.isArray(bundle.plugins)) {
      throw new TypeError(`capability bundle plugins must be an array: ${bundle.id}`)
    }
    pluginCount += bundle.plugins.length
    if (pluginCount > MAX_PROFILE_PLUGINS) {
      throw new TypeError(`capability profile has too many plugins: ${profile.id}`)
    }

    const plugins = [...bundle.plugins]
    const manifests = plugins.map((plugin) => {
      const manifest = inspectCapabilityPluginManifest(plugin.manifest)
      if (pluginIds.has(manifest.id)) {
        throw new TypeError(`duplicate capability plugin in ${profile.id}: ${manifest.id}`)
      }
      pluginIds.add(manifest.id)
      return manifest
    })
    preparedBundles.push(Object.freeze({ plugins: Object.freeze(plugins) }))
    snapshotBundles.push(Object.freeze({
      id: bundle.id,
      version: bundle.version,
      plugins: Object.freeze(manifests),
    }))
  }

  return {
    snapshot: Object.freeze({
      schemaVersion: CAPABILITY_PROFILE_SCHEMA_VERSION,
      id: profile.id,
      version: profile.version,
      bundles: Object.freeze(snapshotBundles),
    }),
    bundles: Object.freeze(preparedBundles),
  }
}

function assertCompositionIdentity(id: string, version: string, kind: string): void {
  if (!COMPOSITION_ID.test(id)) throw new TypeError(`invalid capability ${kind} id: ${id}`)
  if (!VERSION.test(version)) {
    throw new TypeError(`invalid capability ${kind} version for ${id}: ${version}`)
  }
}
