import { basename, dirname, join, resolve } from 'node:path'

export interface WatchFolderResolution {
  mode: 'legacy' | 'dual'
  root: string
  paths: string[]
}

/**
 * A selected Spool folder owns sibling JPEG and RAW folders. Older Smart
 * Shooter setups can still point directly at one flat folder, so dual mode is
 * enabled only when the folder is recognizably a spool root or has either
 * sibling directory already present.
 */
export function resolveWatchFolders(
  folderPath: string,
  folderExists: (path: string) => boolean = () => false,
): WatchFolderResolution {
  const selected = resolve(folderPath)
  const selectedName = basename(selected).toLowerCase()
  const root = selectedName === 'jpeg' || selectedName === 'raw' ? dirname(selected) : selected
  const jpeg = join(root, 'JPEG')
  const raw = join(root, 'RAW')
  const dual = selectedName === 'spool'
    || selectedName === 'jpeg'
    || selectedName === 'raw'
    || folderExists(jpeg)
    || folderExists(raw)

  return dual
    ? { mode: 'dual', root, paths: [jpeg, raw] }
    : { mode: 'legacy', root: selected, paths: [selected] }
}