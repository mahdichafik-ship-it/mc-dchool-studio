import { exiftool } from 'exiftool-vendored'
import { copyFile, mkdir, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { extname, join } from 'node:path'
import sharp from 'sharp'
import { getPhotoSystemLayout } from './storageLayout.ts'

export const LIVE_PREVIEW_EDGE = 1440
export const LIVE_PREVIEW_QUALITY = 84

const RAW_EXTENSIONS = new Set([
  '.nef', '.nrw', '.cr2', '.cr3', '.arw', '.raf', '.orf', '.rw2', '.dng',
])
const EMBEDDED_PREVIEW_TAGS = ['PreviewImage', 'JpgFromRaw', 'ThumbnailImage'] as const

export interface LivePreviewOptions {
  cacheDir: string
  previewKey: string
}

function isRawFile(filePath: string): boolean {
  return RAW_EXTENSIONS.has(extname(filePath).toLowerCase())
}

function cacheName(previewKey: string): string {
  return `${createHash('sha256').update(previewKey).digest('hex').slice(0, 32)}.jpg`
}

export function getLivePreviewCacheDir(homeDir: string): string {
  return join(getPhotoSystemLayout(homeDir).cache, 'Previews')
}

async function existingFileSize(filePath: string): Promise<number | null> {
  try {
    const result = await stat(filePath)
    return result.isFile() && result.size > 0 ? result.size : null
  } catch {
    return null
  }
}

async function extractEmbeddedPreview(sourcePath: string, destinationPath: string): Promise<boolean> {
  for (const tag of EMBEDDED_PREVIEW_TAGS) {
    await rm(destinationPath, { force: true }).catch(() => {})
    try {
      await exiftool.extractBinaryTag(tag, sourcePath, destinationPath, {
        ignoreMinorErrors: true,
      })
      if (await existingFileSize(destinationPath)) return true
    } catch {
      // RAW vendors use different embedded preview tag names. Try the next
      // supported tag without ever falling back to decoding the full RAW.
    }
  }
  return false
}

/**
 * Creates a small JPEG artifact for the live preview path.
 *
 * JPEGs are resized directly by libvips. RAW files are limited to embedded
 * JPEG previews; the original RAW is never decoded, modified, or replaced.
 */
export async function generateLivePreview(
  sourcePath: string,
  { previewKey, cacheDir }: LivePreviewOptions,
): Promise<string | null> {
  const destinationPath = join(cacheDir, cacheName(previewKey))
  const embeddedPath = join(cacheDir, `.embedded-${cacheName(previewKey)}`)
  let inputPath = sourcePath

  try {
    await mkdir(cacheDir, { recursive: true })
    if (await existingFileSize(destinationPath)) return destinationPath

    if (isRawFile(sourcePath)) {
      const extracted = await extractEmbeddedPreview(sourcePath, embeddedPath)
      if (!extracted) {
        console.warn(`[LivePreview] No embedded JPEG preview found for ${sourcePath}`)
        return null
      }
      inputPath = embeddedPath
    }

    await sharp(inputPath, { failOn: 'none' })
      .rotate()
      .resize({
        width: LIVE_PREVIEW_EDGE,
        height: LIVE_PREVIEW_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: LIVE_PREVIEW_QUALITY, mozjpeg: true })
      .toFile(destinationPath)

    return destinationPath
  } catch (error) {
    await rm(destinationPath, { force: true }).catch(() => {})
    console.warn(`[LivePreview] Could not create preview for ${sourcePath}:`, error)
    return null
  } finally {
    if (inputPath === embeddedPath) {
      await rm(embeddedPath, { force: true }).catch(() => {})
    }
  }
}
