export function getEligibleUploadJobs<T>(
  jobs: T[],
  getKey: (job: T) => string,
  retryAfterByKey: ReadonlyMap<string, number>,
  now: number,
): T[] {
  return jobs
    .filter((job) => (retryAfterByKey.get(getKey(job)) ?? 0) <= now)
    .sort((left, right) => {
      const leftDeferred = retryAfterByKey.has(getKey(left))
      const rightDeferred = retryAfterByKey.has(getKey(right))
      if (leftDeferred === rightDeferred) return 0
      return leftDeferred ? 1 : -1
    })
}