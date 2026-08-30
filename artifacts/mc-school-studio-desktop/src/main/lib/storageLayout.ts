import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface PhotoSystemLayout {
  root: string
  jobs: string
  spool: string
  spoolJpeg: string
  spoolRaw: string
  cache: string
  settings: string
}

export interface ProjectStorageLayout {
  root: string
  projectJson: string
  database: string
  images: string
  jpegOriginals: string
  jpegPreviews: string
  jpegThumbnails: string
  rawOriginals: string
  exports: string
  logs: string
}

function safeFolderName(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 120) || 'Unknown'
}

export function getPhotoSystemLayout(homeDir: string, configuredRoot?: string | null): PhotoSystemLayout {
  const root = configuredRoot?.trim() || join(homeDir, 'MC_PhotoSystem')
  return {
    root,
    jobs: join(root, 'Jobs'),
    spool: join(root, 'Spool'),
    spoolJpeg: join(root, 'Spool', 'JPEG'),
    spoolRaw: join(root, 'Spool', 'RAW'),
    cache: join(root, 'Cache'),
    settings: join(root, 'Settings'),
  }
}

export function ensurePhotoSystemLayout(layout: PhotoSystemLayout): PhotoSystemLayout {
  for (const directory of [
    layout.root,
    layout.jobs,
    layout.spool,
    layout.spoolJpeg,
    layout.spoolRaw,
    layout.cache,
    layout.settings,
  ]) {
    mkdirSync(directory, { recursive: true })
  }
  return layout
}

export function getProjectStorageLayout(
  photoSystem: PhotoSystemLayout,
  projectId: number,
  projectName: string,
): ProjectStorageLayout {
  const folderName = `${safeFolderName(projectName)}-${projectId}`
  const root = join(photoSystem.jobs, folderName)
  return {
    root,
    projectJson: join(root, 'project.json'),
    database: join(root, 'database.sqlite'),
    images: join(root, 'Images'),
    jpegOriginals: join(root, 'Images', 'JPEG', 'Originals'),
    jpegPreviews: join(root, 'Images', 'JPEG', 'Previews'),
    jpegThumbnails: join(root, 'Images', 'JPEG', 'Thumbnails'),
    rawOriginals: join(root, 'Images', 'RAW', 'Originals'),
    exports: join(root, 'Exports'),
    logs: join(root, 'Logs'),
  }
}

export function ensureProjectStorageLayout(layout: ProjectStorageLayout): ProjectStorageLayout {
  for (const directory of [
    layout.root,
    layout.images,
    layout.jpegOriginals,
    layout.jpegPreviews,
    layout.jpegThumbnails,
    layout.rawOriginals,
    layout.exports,
    layout.logs,
  ]) {
    mkdirSync(directory, { recursive: true })
  }
  return layout
}