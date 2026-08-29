import { relative, resolve, sep } from 'node:path'

export type RetirementProject = {
  id: number
  schoolName: string
}

export interface RetirementStore {
  listProjects(): RetirementProject[]
  listPhotoPaths(): string[]
  clearProjects(): void
}

export interface RetirementFileSystem {
  remove(path: string): void
}

export function safeProjectFolderName(value: string): string {
  return value.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').slice(0, 120) || 'Unknown'
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate))
  return pathFromRoot !== '' && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`)
}

export function retireLocalProjects(
  store: RetirementStore,
  fileSystem: RetirementFileSystem,
  photosRoot: string,
): { projectsCleared: number; pathsRemoved: number } {
  const projects = store.listProjects()
  const paths = new Set<string>()

  for (const filePath of store.listPhotoPaths()) {
    if (isInside(photosRoot, filePath)) paths.add(resolve(filePath))
  }
  for (const project of projects) {
    paths.add(resolve(photosRoot, safeProjectFolderName(project.schoolName)))
    paths.add(resolve(photosRoot, String(project.id)))
  }

  const orderedPaths = [...paths].sort((left, right) => right.length - left.length)
  for (const path of orderedPaths) {
    if (isInside(photosRoot, path)) fileSystem.remove(path)
  }

  store.clearProjects()
  return { projectsCleared: projects.length, pathsRemoved: orderedPaths.length }
}