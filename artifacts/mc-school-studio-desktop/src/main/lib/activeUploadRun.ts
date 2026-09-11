/** Register before executing: even an empty/synchronously failing run must clear its lock. */
export function startActiveUploadRun(
  runs: Map<number, Promise<void>>,
  projectId: number,
  work: () => Promise<void>,
  onSettled: () => void,
): Promise<void> {
  const existing = runs.get(projectId)
  if (existing) return existing
  const task = Promise.resolve().then(work).finally(() => {
    if (runs.get(projectId) === task) runs.delete(projectId)
    onSettled()
  })
  runs.set(projectId, task)
  return task
}