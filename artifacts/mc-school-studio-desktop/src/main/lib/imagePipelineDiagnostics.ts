import { performance } from 'node:perf_hooks'

export type ImagePipelineStage =
  | 'T0 filesystem event received'
  | 'T1 local file finished writing'
  | 'T2 active student identified'
  | 'T3 local copy starts'
  | 'T4 API request starts'
  | 'T5 upload starts'
  | 'T6 upload completes'
  | 'T7 thumbnail creation starts'
  | 'T8 thumbnail ready'
  | 'T9 UI event sent'
  | 'T10 image rendered'
  | 'T11 database persistence completed'
  | 'T12 cloud synchronization completed'

interface PipelineTrace {
  startedAt: number
  filePath: string
}

const traces = new Map<string, PipelineTrace>()
let sequence = 0

function diagnosticsEnabled(): boolean {
  return process.env.MC_IMAGE_PIPELINE_DIAGNOSTICS === '1'
}

function formatDetails(details?: string): string {
  return details ? ` · ${details}` : ''
}

export function startImagePipelineTrace(filePath: string): string {
  const traceId = `capture-${Date.now()}-${sequence++}`
  traces.set(traceId, { startedAt: performance.now(), filePath })
  markImagePipeline(traceId, 'T0 filesystem event received', `source=${filePath}`)
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
  console.info(`[ImagePipeline] ${traceId} ${stage} +${elapsedMs}ms${formatDetails(details)}`)
}

export function finishImagePipelineTrace(traceId: string | undefined): void {
  if (traceId) traces.delete(traceId)
}
