export type RawMarkerPersistenceResult<T> =
  | { kind: 'discarded-marker-mate' }
  | { kind: 'persisted'; value: T }

/**
 * Recheck QR state after RAW copy I/O and immediately before the synchronous
 * database write. This closes the window where marker decoding can finish
 * while a large RAW is still being copied.
 */
export async function persistRawAtMarkerBoundary<T>(options: {
  hasMarkerMate: () => boolean
  discardCopiedFile: () => Promise<void>
  persistSynchronously: () => T
}): Promise<RawMarkerPersistenceResult<T>> {
  if (options.hasMarkerMate()) {
    await options.discardCopiedFile()
    return { kind: 'discarded-marker-mate' }
  }
  return { kind: 'persisted', value: options.persistSynchronously() }
}