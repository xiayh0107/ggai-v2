export type Disposer = () => void | Promise<void>

/**
 * Owns reversible runtime effects and disposes them in reverse registration
 * order. Disposal is idempotent and concurrent callers share one promise.
 */
export class EffectScope {
  readonly #effects: Disposer[] = []
  #disposePromise: Promise<void> | null = null

  get disposed(): boolean {
    return this.#disposePromise !== null
  }

  add(disposer: Disposer): Disposer {
    if (this.disposed) throw new Error('effect scope is already disposing or disposed')
    let active = true
    const release: Disposer = async () => {
      if (!active) return
      active = false
      await disposer()
    }
    this.#effects.push(release)
    return release
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise
    this.#disposePromise = this.#disposeEffects()
    return this.#disposePromise
  }

  async #disposeEffects(): Promise<void> {
    const effects = this.#effects.splice(0).reverse()
    const errors: unknown[] = []
    for (const dispose of effects) {
      try {
        await dispose()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'multiple runtime effects failed to dispose')
  }
}
