import { performance } from 'node:perf_hooks'
import type {
  ImagePipelinePreviewContext,
  ImagePipelineRendererStage,
  ImagePipelineStage,
} from '../../shared/types'

interface PipelineTrace {
  startedAt: number
  startedAtEpochMs: number
  filePath: string
  burstIndex?: number
  burstSize?: number
  rendererQueue?: {
    activePriority: string | null
    pendingLive: boolean
    galleryQueued: number
    galleryMax: number
  }
  marks: Map<ImagePipelineStage, { elapsedMs: number; details?: string }>
  waitingForPaint: boolean
  paintTimeout?: NodeJS.Timeout
}

const traces = new Map<string, PipelineTrace>()
let sequence = 0
const REPORT_STAGE_ORDER: ImagePipelineStage[] = [
  'filesystem event detected',
  'file became stable',
  'student lookup complete',
  'student assigned',
  'preview preparation started',
  'preview prepared',
  'thumbnail generation complete',
  'IPC event sent',
  'frontend event received',
  'React state update committed',
  'image decode started',
  'image decode complete',
  'image preview superseded',
  'image pixels painted',
  'file move started',
  'file move complete',
  'database write started',
  'database write complete',
  'RAW pairing complete',
  'cloud synchronization complete',
]
const PAINT_REPORT_TIMEOUT_MS = 60_000

function diagnosticsEnabled(): boolean {
  return process.env.MC_IMAGE_PIPELINE_DIAGNOSTICS === '1'
}

function formatDetails(details?: string): string {
  return details ? ` · ${details}` : ''
}

export function startImagePipelineTrace(filePath: string): string {
  const traceId = `capture-${Date.now()}-${sequence++}`
  if (diagnosticsEnabled()) {
    traces.set(traceId, {
      startedAt: performance.now(),
      startedAtEpochMs: Date.now(),
      filePath,
      marks: new Map(),
      waitingForPaint: false,
    })
  }
  markImagePipeline(traceId, 'filesystem event detected', `source=${filePath}`)
  return traceId
}

export function markImagePipeline(
  traceId: string | undefined,
  stage: ImagePipelineStage,
  details?: string,
): void {
  if (!traceId || !diagnosticsEnabled()) return
  const trace = traces.get(traceId)
  if (!trace) return
  const elapsedMs = (performance.now() - trace.startedAt).toFixed(1)
  const elapsed = Number(elapsedMs)
  trace.marks.set(stage, { elapsedMs: elapsed, details })
  console.info(`[ImagePipeline] ${traceId} ${stage} +${elapsedMs}ms${formatDetails(details)}`)
}

export function setImagePipelineBurstContext(
  traceId: string | undefined,
  burstIndex: number,
  burstSize: number,
): void {
  if (!traceId || !diagnosticsEnabled()) return
  const trace = traces.get(traceId)
  if (!trace || !Number.isInteger(burstIndex) || !Number.isInteger(burstSize)) return
  trace.burstIndex = burstIndex
  trace.burstSize = burstSize
}

export function getImagePipelinePreviewContext(
  traceId: string | undefined,
): ImagePipelinePreviewContext | undefined {
  if (!traceId || !diagnosticsEnabled()) return undefined
  const trace = traces.get(traceId)
  if (!trace) return undefined
  return {
    traceId,
    startedAtEpochMs: trace.startedAtEpochMs,
  }
}

export function retainImagePipelineTraceForPaint(traceId: string | undefined): void {
  if (!traceId || !diagnosticsEnabled()) return
  const trace = traces.get(traceId)
  if (!trace) return
  if (trace.waitingForPaint) return
  trace.waitingForPaint = true
  trace.paintTimeout = setTimeout(() => {
    console.warn(`[ImagePipeline] ${traceId} paint report timed out`)
    finishImagePipelineTrace(traceId)
  }, PAINT_REPORT_TIMEOUT_MS)
  trace.paintTimeout.unref()
}

export function markImagePipelineRendererStage(event: ImagePipelineRendererStage): void {
  if (!diagnosticsEnabled()) return
  const trace = traces.get(event.traceId)
  if (!trace) return
  const elapsedMs = Math.max(0, event.atEpochMs - trace.startedAtEpochMs)
  trace.marks.set(event.stage, { elapsedMs, details: event.details })
  if (event.stage === 'image decode started' && event.details) {
    const queue = event.details.match(
      /active=(\w+)\s+pendingLive=(\d+)\s+galleryQueued=(\d+)\s+galleryMax=(\d+)/,
    )
    if (queue) {
      trace.rendererQueue = {
        activePriority: queue[1] === 'none' ? null : queue[1],
        pendingLive: queue[2] === '1',
        galleryQueued: Number(queue[3]),
        galleryMax: Number(queue[4]),
      }
    }
  }
  console.info(
    `[ImagePipeline] ${event.traceId} ${event.stage} +${elapsedMs.toFixed(1)}ms`
      + formatDetails(event.details),
  )
  if (event.stage === 'image pixels painted' || event.stage === 'image preview superseded') {
    reportAndDeleteTrace(event.traceId)
  }
}

export function markImagePipelinePreviewSuperseded(
  traceId: string | undefined,
  details?: string,
): void {
  if (!traceId) return
  markImagePipelineRendererStage({
    traceId,
    stage: 'image preview superseded',
    atEpochMs: Date.now(),
    details,
  })
}

function reportAndDeleteTrace(traceId: string): void {
  const trace = traces.get(traceId)
  if (!trace) return
  const stages: Record<string, { elapsedMs: number; durationMs?: number; details?: string }> = {}
  let previousElapsed = 0
  let slowest: { stage: string; durationMs: number } | null = null

  for (const stage of REPORT_STAGE_ORDER) {
    const mark = trace.marks.get(stage)
    if (!mark) continue
    const durationMs = Math.max(0, mark.elapsedMs - previousElapsed)
    stages[stage] = { elapsedMs: mark.elapsedMs, durationMs, details: mark.details }
    if (!slowest || durationMs > slowest.durationMs) {
      slowest = { stage, durationMs }
    }
    previousElapsed = mark.elapsedMs
  }

  const paintedAt = trace.marks.get('image pixels painted')?.elapsedMs
  const burstIndex = trace.burstIndex
  const burstSize = trace.burstSize
  const burstMilestone = burstIndex === undefined || burstSize === undefined
    ? undefined
    : burstIndex === 1
      ? 'image 1'
      : burstIndex === 5
        ? 'image 5'
        : burstIndex === 10
          ? 'image 10'
          : burstIndex === burstSize
            ? 'final image'
            : undefined
  console.info(
    `[ImagePipeline] REPORT ${traceId} `
      + JSON.stringify({
        filePath: trace.filePath,
        totalToVisibleMs: paintedAt ?? null,
        newestImageVisibleLatencyMs: paintedAt ?? null,
        rendererDecodeQueue: trace.rendererQueue
          ? {
            ...trace.rendererQueue,
            queueAccumulated: trace.rendererQueue.galleryMax > 0,
          }
          : null,
        ...(burstIndex === undefined || burstSize === undefined
          ? {}
          : {
            burst: {
              imageIndex: burstIndex,
              imageCount: burstSize,
              milestone: burstMilestone ?? null,
            },
          }),
        cloudSynchronization: 'deferred by explicit project sync',
        slowest,
        stages,
      }),
  )
  if (trace.paintTimeout) clearTimeout(trace.paintTimeout)
  traces.delete(traceId)
}

export function finishImagePipelineTrace(traceId: string | undefined): void {
  if (!traceId || !diagnosticsEnabled()) return
  const trace = traces.get(traceId)
  if (!trace || trace.waitingForPaint) return
  reportAndDeleteTrace(traceId)
}
