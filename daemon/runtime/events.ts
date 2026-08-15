import type { Disposer } from './effects.js'

export type EventName<Events extends object> = Extract<keyof Events, string>
export type EventListener<Payload> = (payload: Readonly<Payload>) => unknown

export interface RuntimeEventFailure<Name extends string = string> {
  readonly event: Name
  readonly listenerIndex: number
  readonly error: unknown
}

export interface RuntimeEventSource<Events extends object> {
  on<Name extends EventName<Events>>(
    event: Name,
    listener: EventListener<Events[Name]>,
  ): Disposer
}

/**
 * Synchronous, observe-only typed events. Listener failures are contained and
 * returned to the emitter; they never short-circuit later observers.
 */
export class TypedEventBus<Events extends object> implements RuntimeEventSource<Events> {
  readonly #listeners = new Map<EventName<Events>, Set<EventListener<never>>>()
  #disposed = false

  on<Name extends EventName<Events>>(
    event: Name,
    listener: EventListener<Events[Name]>,
  ): Disposer {
    if (this.#disposed) throw new Error('typed event bus is disposed')
    let listeners = this.#listeners.get(event)
    if (!listeners) {
      listeners = new Set()
      this.#listeners.set(event, listeners)
    }
    const erased = listener as EventListener<never>
    listeners.add(erased)
    let active = true
    return () => {
      if (!active) return
      active = false
      listeners?.delete(erased)
      if (listeners?.size === 0) this.#listeners.delete(event)
    }
  }

  emit<Name extends EventName<Events>>(
    event: Name,
    payload: Readonly<Events[Name]>,
  ): RuntimeEventFailure<Name>[] {
    if (this.#disposed) return []
    const listeners = [...(this.#listeners.get(event) ?? [])]
    const failures: RuntimeEventFailure<Name>[] = []
    listeners.forEach((listener, listenerIndex) => {
      try {
        const result = listener(payload as never)
        if (isThenable(result)) {
          void Promise.resolve(result).catch(() => undefined)
          failures.push({
            event,
            listenerIndex,
            error: new TypeError(`runtime event listener must be synchronous: ${event}`),
          })
        }
      } catch (error) {
        failures.push({ event, listenerIndex, error })
      }
    })
    return failures
  }

  listenerCount<Name extends EventName<Events>>(event: Name): number {
    return this.#listeners.get(event)?.size ?? 0
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#listeners.clear()
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object'
    && value !== null
    && 'then' in value
    && typeof value.then === 'function'
}
