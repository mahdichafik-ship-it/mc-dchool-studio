import { constants, createReadStream } from 'node:fs'
import { copyFile, link, rename, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'

type LinkFile = (existingPath: string, newPath: string) => Promise<void>

interface ManagedCaptureCopyOptions {
  linkFile?: LinkFile
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

export function getManagedCaptureTempPath(
  sourcePath: string,
  destinationPath: string,
): string {
  const sourceToken = createHash('sha256').update(sourcePath).digest('hex').slice(0, 12)
  return `${destinationPath}.partial-${sourceToken}`
}

export async function copyManagedCaptureFile(
  sourcePath: string,
  destinationPath: string,
  options: ManagedCaptureCopyOptions = {},
): Promise<'copied' | 'reconciled'> {
  const temporaryPath = getManagedCaptureTempPath(sourcePath, destinationPath)
  await rm(temporaryPath, { force: true })
  await copyFile(sourcePath, temporaryPath, constants.COPYFILE_EXCL)
  const reconcileExistingDestination = async (): Promise<'reconciled'> => {
    const [sourceHash, destinationHash] = await Promise.all([
      hashFile(sourcePath),
      hashFile(destinationPath),
    ])
    if (sourceHash !== destinationHash) {
      throw new Error(`Managed capture destination already contains different image data: ${destinationPath}`)
    }
    return 'reconciled'
  }
  try {
    await (options.linkFile ?? link)(temporaryPath, destinationPath)
    return 'copied'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return reconcileExistingDestination()
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(code ?? '')) throw error
    try {
      await stat(destinationPath)
      return reconcileExistingDestination()
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError
    }
    await rename(temporaryPath, destinationPath)
    return 'copied'
  } finally {
    await rm(temporaryPath, { force: true })
  }
}