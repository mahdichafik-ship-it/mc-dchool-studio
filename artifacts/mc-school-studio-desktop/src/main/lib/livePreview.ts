import { exiftool } from 'exiftool-vendored'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { extname, join } from 'node:path'
import sharp from 'sharp'
import { getPhotoSystemLayout } from './storageLayout.ts'
import { assessImageContent } from './imageContent.ts'

export const LIVE_PREVIEW_EDGE = 1440
export const LIVE_PREVIEW_QUALITY = 84

const RAW_EXTENSIONS = new Set([
  '.nef', '.nrw', '.cr2', '.cr3', '.arw', '.raf', '.orf', '.rw2', '.dng',
])
const EMBEDDED_PREVIEW_TAGS = ['PreviewImage', 'JpgFromRaw', 'ThumbnailImage'] as const

export interface LivePreviewOptions {
  cacheDir: string
  previewKey: string
  /**
   * Snapshot taken after the watched source passed stability checks. When
   * present, no decoder or preview stage reopens the mutable source path.
   */
  sourceBuffer?: Buffer
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

export async function getCachedLivePreview(
  previewKey: string,
  cacheDir: string,
): Promise<string | null> {
  const previewPath = join(cacheDir, cacheName(previewKey))
  return (await existingFileSize(previewPath)) ? previewPath : null
}

async function existingFileSize(filePath: string): Promise<number | null> {
  try {
    const result = await stat(filePath)
    return result.isFile() && result.size > 0 ? result.size : null
  } catch {
    return null
  }
}

async function usablePreview(filePath: string): Promise<boolean> {
  if (!(await existingFileSize(filePath))) return false
  try {
    return (await assessImageContent(await readFile(filePath))).usable
  } catch {
    return false
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
  options: LivePreviewOptions,
): Promise<string | null> {
  const destinationPath = join(options.cacheDir, cacheName(options.previewKey))
  const active = previewJobs.get(destinationPath)
  if (active) return active
  const job = generateLivePreviewFromSource(sourcePath, options)
  previewJobs.set(destinationPath, job)
  try {
    return await job
  } finally {
    if (previewJobs.get(destinationPath) === job) previewJobs.delete(destinationPath)
  }
}

const previewJobs = new Map<string, Promise<string | null>>()

async function generateLivePreviewFromSource(
  sourcePath: string,
  { previewKey, cacheDir, sourceBuffer }: LivePreviewOptions,
): Promise<string | null> {
  const destinationPath = join(cacheDir, cacheName(previewKey))
  const embeddedPath = join(cacheDir, `.embedded-${cacheName(previewKey)}`)
  const sourceCopyPath = join(cacheDir, `.source-${cacheName(previewKey)}${extname(sourcePath)}`)
  let sourceBytes: Buffer | undefined
  let inputBuffer: Buffer | undefined

  try {
    await mkdir(cacheDir, { recursive: true })
    if (await usablePreview(destinationPath)) return destinationPath
    await rm(destinationPath, { force: true }).catch(() => {})

    if (isRawFile(sourcePath)) {
      // exiftool also gets a stable managed copy for RAW files. Sharp never
      // receives either the camera path or the extraction path.
      sourceBytes = Buffer.from(sourceBuffer ?? await readFile(sourcePath))
      await writeFile(sourceCopyPath, sourceBytes)
      const extracted = await extractEmbeddedPreview(sourceCopyPath, embeddedPath)
      if (!extracted) {
        console.warn(`[LivePreview] No embedded JPEG preview found for ${sourcePath}`)
        return null
      }
      inputBuffer = await readFile(embeddedPath)
    } else {
      // Make a private copy even when a caller supplied a Buffer so a
      // concurrently-running caller cannot mutate the decoder input.
      inputBuffer = Buffer.from(sourceBuffer ?? await readFile(sourcePath))
    }

    const sourceAssessment = await assessImageContent(inputBuffer)
    if (!sourceAssessment.usable) {
      throw new Error(`Source image is not usable (${sourceAssessment.reason ?? 'uniform frame'})`)
    }

    const previewBytes = await sharp(inputBuffer, { failOn: 'warning' })
      .rotate()
      .resize({
        width: LIVE_PREVIEW_EDGE,
        height: LIVE_PREVIEW_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: LIVE_PREVIEW_QUALITY, mozjpeg: true })
      .toBuffer()
    await writeFile(destinationPath, previewBytes)

    const previewAssessment = await assessImageContent(previewBytes)
    if (!previewAssessment.usable) {
      throw new Error(`Generated preview is not usable (${previewAssessment.reason ?? 'uniform frame'})`)
    }

    return destinationPath
  } catch (error) {
    await rm(destinationPath, { force: true }).catch(() => {})
    console.warn(`[LivePreview] Could not create preview for ${sourcePath}:`, error)
    return null
  } finally {
    await rm(embeddedPath, { force: true }).catch(() => {})
    await rm(sourceCopyPath, { force: true }).catch(() => {})
  }
}
