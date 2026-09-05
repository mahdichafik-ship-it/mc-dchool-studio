import { protocol } from 'electron'
import { readFile } from 'node:fs/promises'

const previewFiles = new Map<string, string>()
const PREVIEW_TTL_MS = 5 * 60_000

export function registerLocalPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'mc-preview',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  }])
}

export function registerLocalPreviewProtocol(): void {
  protocol.handle('mc-preview', async (request) => {
    const key = decodeURIComponent(new URL(request.url).hostname)
    const filePath = previewFiles.get(key)
    if (!filePath) return new Response('Preview not found', { status: 404 })

    try {
      const bytes = await readFile(filePath)
      return new Response(bytes, {
        headers: {
          'Cache-Control': 'no-store',
          'Content-Length': String(bytes.byteLength),
          'Content-Type': 'image/jpeg',
        },
      })
    } catch {
      return new Response('Preview unavailable', { status: 404 })
    }
  })
}

export function createLocalPreviewUrl(filePath: string, traceId: string): string {
  previewFiles.set(traceId, filePath)
  const cleanup = setTimeout(() => previewFiles.delete(traceId), PREVIEW_TTL_MS)
  cleanup.unref()
  return `mc-preview://${encodeURIComponent(traceId)}`
}