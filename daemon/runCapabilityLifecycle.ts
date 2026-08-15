import type { Disposer } from './runtime/effects.js'

/**
 * Preserves daemon close errors while independently cleaning the temporary
 * Run capability integration installed by the HTTP/Application adapter.
 */
export async function closeWithRunCapabilityIntegration(
  closeDaemon: () => Promise<void>,
  uninstall: Disposer,
): Promise<void> {
  let closeError: unknown
  try {
    await closeDaemon()
  } catch (error) {
    closeError = error
  }

  let uninstallError: unknown
  try {
    await uninstall()
  } catch (error) {
    uninstallError = error
  }

  if (closeError !== undefined && uninstallError !== undefined) {
    throw new AggregateError(
      [closeError, uninstallError],
      'daemon close and Run capability integration cleanup failed',
    )
  }
  if (closeError !== undefined) throw closeError
  if (uninstallError !== undefined) throw uninstallError
}
