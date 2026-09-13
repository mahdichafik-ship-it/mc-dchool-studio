export class AsyncTaskLimiter {
  private active = 0
  private readonly waiting: Array<() => void> = []
  private readonly limit: number

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('Upload concurrency limit must be a positive integer.')
    }
    this.limit = limit
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    }
    this.active++
    try {
      return await task()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}

export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0
  const workerCount = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++]
      await worker(item)
    }
  }))
}