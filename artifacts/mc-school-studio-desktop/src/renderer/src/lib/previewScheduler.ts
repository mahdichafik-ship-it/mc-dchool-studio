export type PreviewPriority = 'live' | 'gallery'

export interface PreviewSchedulerJob {
  id: string
  priority: PreviewPriority
  execute: (signal: AbortSignal) => Promise<void>
  onCancelled?: () => void
}

interface QueuedJob extends PreviewSchedulerJob {
  cancelled: boolean
}

interface ActiveJob {
  job: QueuedJob
  controller: AbortController
}

export class PreviewScheduler {
  private active: ActiveJob | null = null
  private pendingLive: QueuedJob | null = null
  private galleryQueue: QueuedJob[] = []

  enqueue(job: PreviewSchedulerJob): () => void {
    const queued: QueuedJob = { ...job, cancelled: false }

    if (job.priority === 'live') {
      this.cancelPendingLive()
      this.pendingLive = queued
      if (this.active) this.cancel(this.active.job)
    } else {
      this.galleryQueue.push(queued)
    }

    void this.pump()
    return () => this.cancel(queued)
  }

  private cancelPendingLive(): void {
    if (!this.pendingLive) return
    this.cancel(this.pendingLive)
    this.pendingLive = null
  }

  private cancel(job: QueuedJob): void {
    if (job.cancelled) return
    job.cancelled = true
    if (this.active?.job === job) this.active.controller.abort()
    job.onCancelled?.()
  }

  private nextJob(): QueuedJob | null {
    while (this.pendingLive?.cancelled) this.pendingLive = null
    if (this.pendingLive) {
      const job = this.pendingLive
      this.pendingLive = null
      return job
    }

    while (this.galleryQueue.length > 0) {
      const job = this.galleryQueue.shift()!
      if (!job.cancelled) return job
    }
    return null
  }

  private async pump(): Promise<void> {
    if (this.active) return
    const job = this.nextJob()
    if (!job) return

    const active: ActiveJob = {
      job,
      controller: new AbortController(),
    }
    this.active = active
    try {
      if (!job.cancelled) await job.execute(active.controller.signal)
    } catch {
      // Preview failures are isolated from capture persistence and review.
    } finally {
      if (this.active === active) this.active = null
      void this.pump()
    }
  }
}

export const previewScheduler = new PreviewScheduler()

export async function decodeResizedPreview(
  source: string,
  maxEdge: number,
  signal: AbortSignal,
): Promise<ImageBitmap | null> {
  const response = await fetch(source, { signal })
  if (!response.ok) throw new Error(`Preview request failed: ${response.status}`)

  const bitmap = await createImageBitmap(await response.blob(), {
    resizeWidth: maxEdge,
    resizeQuality: 'high',
  })
  if (signal.aborted) {
    bitmap.close()
    return null
  }
  return bitmap
}

export function waitForPaintFrames(frameCount = 2): Promise<void> {
  return new Promise((resolve) => {
    const wait = (remaining: number) => {
      if (remaining <= 0) {
        resolve()
        return
      }
      requestAnimationFrame(() => wait(remaining - 1))
    }
    wait(frameCount)
  })
}