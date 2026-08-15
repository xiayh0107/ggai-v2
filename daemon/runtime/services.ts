declare const serviceType: unique symbol

export interface ServiceKey<T> {
  readonly id: string
  readonly [serviceType]?: (value: T) => T
}

interface ServiceProvider {
  readonly owner: string
  readonly value: unknown
}

const SERVICE_ID = /^ggai\.[a-z0-9][a-z0-9.-]*\.v[1-9][0-9]*$/u

export function defineService<T>(id: string): ServiceKey<T> {
  if (!SERVICE_ID.test(id)) {
    throw new TypeError(`invalid service id: ${id}`)
  }
  return Object.freeze({ id }) as ServiceKey<T>
}

/**
 * A hierarchical service context. A child may shadow a parent provider, while
 * duplicate providers in the same scope are rejected.
 */
export class ServiceScope {
  readonly #parent: ServiceScope | null
  readonly #label: string
  readonly #providers = new Map<string, ServiceProvider>()
  readonly #children = new Set<ServiceScope>()
  #disposed = false

  constructor(options: { parent?: ServiceScope; label?: string } = {}) {
    this.#parent = options.parent ?? null
    this.#label = options.label ?? 'root'
  }

  get label(): string {
    return this.#label
  }

  get disposed(): boolean {
    return this.#disposed
  }

  fork(label: string): ServiceScope {
    this.#assertActive()
    const child = new ServiceScope({ parent: this, label })
    this.#children.add(child)
    return child
  }

  provide<T>(key: ServiceKey<T>, value: T, owner = this.#label): () => void {
    this.#assertActive()
    if (this.#providers.has(key.id)) {
      throw new Error(`service already provided in ${this.#label}: ${key.id}`)
    }
    const provider: ServiceProvider = { owner, value }
    this.#providers.set(key.id, provider)
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.#providers.get(key.id) === provider) this.#providers.delete(key.id)
    }
  }

  get<T>(key: ServiceKey<T>): T | undefined {
    const local = this.#providers.get(key.id)
    if (local) return local.value as T
    return this.#parent?.get(key)
  }

  require<T>(key: ServiceKey<T>): T {
    const service = this.get(key)
    if (service === undefined) {
      throw new Error(`required service is unavailable in ${this.#label}: ${key.id}`)
    }
    return service
  }

  ownerOf<T>(key: ServiceKey<T>): string | undefined {
    const local = this.#providers.get(key.id)
    if (local) return local.owner
    return this.#parent?.ownerOf(key)
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    const children = [...this.#children].reverse()
    this.#children.clear()
    for (const child of children) await child.dispose()
    this.#providers.clear()
    if (this.#parent) this.#parent.#children.delete(this)
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error(`service scope is disposed: ${this.#label}`)
  }
}
