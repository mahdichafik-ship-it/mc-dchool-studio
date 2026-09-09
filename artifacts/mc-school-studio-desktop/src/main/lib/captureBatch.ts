export function assertCaptureBatchComplete(payload: unknown): void {
  if (!payload || typeof payload !== 'object') {
    throw new Error('The server did not confirm that the capture batch completed.')
  }
  const root = payload as Record<string, unknown>
  const batch = root.batch && typeof root.batch === 'object'
    ? root.batch as Record<string, unknown>
    : root
  if (batch.status !== 'complete') {
    throw new Error(`The capture batch is ${String(batch.status ?? 'unconfirmed')}; retry Upload & Finish.`)
  }
  if ('completionGate' in root) {
    const gate = root.completionGate
    const accepted = gate === true || (
      Boolean(gate)
      && typeof gate === 'object'
      && (
        (gate as Record<string, unknown>).complete === true
        || (gate as Record<string, unknown>).ready === true
        || (gate as Record<string, unknown>).ok === true
        || (gate as Record<string, unknown>).passed === true
      )
    )
    if (!accepted) {
      throw new Error('The server completion gate has not passed; retry Upload & Finish.')
    }
  }
}