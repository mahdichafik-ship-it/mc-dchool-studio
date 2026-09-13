import { open, readFile, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'

export const FILE_STABILITY_DELAY_MS = 75
export const FILE_STABILITY_ATTEMPTS = 20

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

async function readableFile(filePath: string): Promise<boolean> {
  try {
    const handle = await open(filePath, 'r')
    await handle.close()
    return true
  } catch {
    return false
  }
}

/**
 * Wait for a newly-created capture to stop growing without imposing a
 * multi-second chokidar awaitWriteFinish delay.
 */
export async function waitForStableFile(
  filePath: string,
  statFile: (path: string) => Promise<Stats>,
  delayMs = FILE_STABILITY_DELAY_MS,
  attempts = FILE_STABILITY_ATTEMPTS,
): Promise<Stats> {
  let previous = await statFile(filePath)
  if (!previous.isFile()) throw new Error(`Capture path is not a file: ${filePath}`)

  for (let attempt = 0; attempt < attempts; attempt++) {
    await wait(delayMs)
    const current = await statFile(filePath)
    if (
      current.isFile()
      && current.size === previous.size
      && current.size > 0
      && await readableFile(filePath)
    ) {
      return current
    }
    previous = current
  }

  throw new Error(`Capture file did not become stable: ${filePath}`)
}

/**
 * Read a capture only after waitForStableFile has confirmed that it stopped
 * growing. The returned bytes are the input boundary for all image work:
 * callers must pass this Buffer to decoders instead of reopening filePath.
 *
 * A final size check catches a truncation/replacement that happened between
 * the stability check and the snapshot. Even when a camera replaces a file
 * immediately afterwards, libvips still only ever sees the already-read
 * bytes.
 */
export async function readStableFile(
  filePath: string,
  expectedSize?: number,
): Promise<Buffer> {
  const bytes = await readFile(filePath)
  const current = await stat(filePath)
  if (
    !current.isFile()
    || (expectedSize !== undefined && current.size !== expectedSize)
    || current.size !== bytes.length
  ) {
    throw new Error(`Capture file changed while it was being snapshotted: ${filePath}`)
  }
  return bytes
}
