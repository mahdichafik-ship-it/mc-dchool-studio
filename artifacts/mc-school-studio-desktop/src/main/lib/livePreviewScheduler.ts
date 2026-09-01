export interface LivePreviewJob {
  traceId?: string
  run: () => Promise<void>
  supersede?: () => void
}

export interface LivePreviewSchedulerStats {
  enqueued: number
  started: number
  completed: number
  superseded: number
}

/**
 * Runs one live-preview generation at a time and keeps only the newest job
 * waiting behind it. Persistence is intentionally outside this scheduler.
 */
export class NewestLivePreviewScheduler {
  private active = false
  private pending: LivePreviewJob | null = null
  private idleWaiters: Array<() => void> = []
  private readonly stats: LivePreviewSchedulerStats = {
    enqueued: 0,
    started: 0,
    completed: 0,
    superseded: 0,
  }

  enqueue(job: LivePreviewJob): void {
    this.stats.enqueued++
    if (this.pending) {
      this.stats.superseded++
      this.pending.supersede?.()
    }
    this.pending = job
    if (!this.active) void this.pump()
  }

  snapshot(): LivePreviewSchedulerStats {
    return { ...this.stats }
  }

  async waitForIdle(): Promise<void> {
    if (!this.active && !this.pending) return
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve))
  }

  private async pump(): Promise<void> {
    if (this.active) return
    this.active = true
    try {
      while (this.pending) {
        const job = this.pending
        this.pending = null
        this.stats.started++
        try {
          await job.run()
        } catch (error) {
          console.error('[LivePreview] Scheduled preview failed', error)
        } finally {
          this.stats.completed++
        }
      }
    } finally {
      this.active = false
      const waiters = this.idleWaiters.splice(0)
      for (const resolve of waiters) resolve()
    }
  }
}