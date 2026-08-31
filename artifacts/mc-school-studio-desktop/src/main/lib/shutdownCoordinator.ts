export interface ShutdownEvent {
  preventDefault(): void
}

interface ShutdownCoordinatorOptions {
  drain: () => Promise<void>
  quit: () => void
  onError?: (error: unknown) => void
}

/**
 * Electron's before-quit event is synchronous, so shutdown work must prevent
 * the first quit request and explicitly continue once critical work drains.
 */
export function createShutdownCoordinator({
  drain,
  quit,
  onError = () => {},
}: ShutdownCoordinatorOptions): (event: ShutdownEvent) => void {
  let shutdownRequested = false

  return (event) => {
    if (shutdownRequested) return
    shutdownRequested = true
    event.preventDefault()

    void drain()
      .catch((error) => {
        onError(error)
      })
      .finally(quit)
  }
}