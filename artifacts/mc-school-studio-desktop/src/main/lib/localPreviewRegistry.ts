import { resolve } from 'node:path'

export const LOCAL_PREVIEW_TTL_MS = 5 * 60_000

interface LocalPreviewReference {
  filePath: string
  expiresAt: number
}

const previewFiles = new Map<string, LocalPreviewReference>()

export function registerLocalPreview(traceId: string, filePath: string): void {
  const normalizedPath = resolve(filePath)
  const expiresAt = Date.now() + LOCAL_PREVIEW_TTL_MS
  const reference: LocalPreviewReference = { filePath: normalizedPath, expiresAt }
  previewFiles.set(traceId, reference)

  const cleanup = setTimeout(() => {
    if (previewFiles.get(traceId) === reference) previewFiles.delete(traceId)
  }, LOCAL_PREVIEW_TTL_MS)
  cleanup.unref()
}

export function getLocalPreviewFile(traceId: string, now = Date.now()): string | undefined {
  const reference = previewFiles.get(traceId)
  if (!reference) return undefined
  if (reference.expiresAt <= now) {
    previewFiles.delete(traceId)
    return undefined
  }
  return reference.filePath
}

export function getActiveLocalPreviewPaths(now = Date.now()): ReadonlySet<string> {
  const activePaths = new Set<string>()
  for (const [traceId, reference] of previewFiles) {
    if (reference.expiresAt <= now) {
      previewFiles.delete(traceId)
      continue
    }
    activePaths.add(reference.filePath)
  }
  return activePaths
}