import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, mkdir, copyFile, stat, lstat } from 'node:fs/promises'
import { dirname, join, parse, relative } from 'node:path'
import { eq, and } from 'drizzle-orm'
import type { getDb } from '../db'
import {
  classesTable,
  imageFilesTable,
  photosTable,
  projectsTable,
  qrMarkersTable,
  studentsTable,
} from '../db/schema'
import { formatStudentFolderName } from './photoFileNaming'
import type {
  FolderMigrationPreview,
  FolderMigrationResult,
  FolderMigrationStudent,
} from '../../shared/types'

type DesktopDb = ReturnType<typeof getDb>
type ProjectRow = typeof projectsTable.$inferSelect
type ClassRow = typeof classesTable.$inferSelect
type StudentRow = typeof studentsTable.$inferSelect

interface StudentFolderNames {
  legacy: string
  canonical: string
}

interface FileEntry {
  sourcePath: string
  relativePath: string
  size: number
}

function safeFolderName(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 120) || 'Unknown'
}

export function getStudentFolderNames(student: Pick<StudentRow, 'firstName' | 'lastName' | 'generatedStudentId'>): StudentFolderNames {
  return {
    legacy: safeFolderName(`${student.generatedStudentId}_${student.lastName}_${student.firstName}`),
    canonical: safeFolderName(formatStudentFolderName(
      student.firstName,
      student.lastName,
      student.generatedStudentId,
    )),
  }
}

function normalizeName(name: string): string {
  return name.normalize('NFKC').toLocaleLowerCase()
}

async function findDirectory(parentPath: string, desiredName: string): Promise<string | null> {
  try {
    const entries = await readdir(parentPath, { withFileTypes: true })
    const match = entries
      .filter((entry) => entry.isDirectory() && normalizeName(entry.name) === normalizeName(desiredName))
      .sort((a, b) => a.name.localeCompare(b.name))[0]
    return match ? join(parentPath, match.name) : null
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? (error as { code?: string }).code
      : undefined
    if (code === 'ENOENT') return null
    throw error
  }
}

async function listFiles(rootPath: string, currentPath = rootPath): Promise<FileEntry[]> {
  let entries
  try {
    entries = await readdir(currentPath, { withFileTypes: true })
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? (error as { code?: string }).code
      : undefined
    if (code === 'ENOENT') return []
    throw error
  }

  const files: FileEntry[] = []
  for (const entry of entries) {
    const entryPath = join(currentPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listFiles(rootPath, entryPath))
    } else if (entry.isFile()) {
      const fileStat = await stat(entryPath)
      files.push({
        sourcePath: entryPath,
        relativePath: relative(rootPath, entryPath),
        size: fileStat.size,
      })
    }
    // Symlinks are intentionally ignored. A migration must never follow a
    // link out of the project tree or duplicate an external file.
  }
  return files
}

async function inspectStudentFolder(
  classDir: string,
  student: StudentRow,
): Promise<FolderMigrationStudent> {
  const names = getStudentFolderNames(student)
  const legacyFolderPath = await findDirectory(classDir, names.legacy)
  const canonicalFolderPath = (await findDirectory(classDir, names.canonical))
    ?? join(classDir, names.canonical)
  const files = legacyFolderPath ? await listFiles(legacyFolderPath) : []
  const conflictFiles: string[] = []
  for (const file of files) {
    if (await pathExists(join(canonicalFolderPath, file.relativePath))) {
      conflictFiles.push(file.relativePath)
    }
  }

  return {
    studentId: student.id,
    classId: student.classId,
    studentName: `${student.firstName} ${student.lastName}`,
    legacyFolderPath,
    canonicalFolderPath,
    legacyFolderFound: Boolean(legacyFolderPath),
    canonicalFolderFound: Boolean(await pathExists(canonicalFolderPath)),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    conflicts: conflictFiles.length,
    conflictFiles,
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? (error as { code?: string }).code
      : undefined
    if (code === 'ENOENT') return false
    throw error
  }
}

export async function previewStudentFolderMigration(input: {
  projectId: number
  photosDir: string
  project: Pick<ProjectRow, 'schoolName'>
  classes: Array<Pick<ClassRow, 'id' | 'className'>>
  students: Array<Pick<StudentRow, 'id' | 'classId' | 'firstName' | 'lastName' | 'generatedStudentId'>>
}): Promise<FolderMigrationPreview> {
  const projectDir = join(input.photosDir, safeFolderName(input.project.schoolName))
  const items: FolderMigrationStudent[] = []

  for (const classRow of input.classes) {
    const classDir = join(projectDir, safeFolderName(classRow.className))
    const students = input.students.filter((student) => student.classId === classRow.id)
    for (const student of students) {
      items.push(await inspectStudentFolder(classDir, student as StudentRow))
    }
  }

  const legacyItems = items.filter((item) => item.legacyFolderFound)
  return {
    projectId: input.projectId,
    projectFolderPath: projectDir,
    legacyFolderCount: legacyItems.length,
    fileCount: legacyItems.reduce((sum, item) => sum + item.fileCount, 0),
    totalBytes: legacyItems.reduce((sum, item) => sum + item.totalBytes, 0),
    conflictCount: legacyItems.reduce((sum, item) => sum + item.conflicts, 0),
    students: items,
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function sameFile(left: string, right: string, leftSize: number): Promise<boolean> {
  try {
    const rightStat = await stat(right)
    return rightStat.isFile()
      && rightStat.size === leftSize
      && (await hashFile(left)) === (await hashFile(right))
  } catch {
    return false
  }
}

async function copyWithoutOverwrite(sourcePath: string, destinationPath: string, sourceSize: number): Promise<{
  path: string
  copied: boolean
  conflict: boolean
}> {
  await mkdir(dirname(destinationPath), { recursive: true })
  if (await pathExists(destinationPath)) {
    if (await sameFile(sourcePath, destinationPath, sourceSize)) {
      return { path: destinationPath, copied: false, conflict: false }
    }
    const parsed = parse(destinationPath)
    let suffix = 2
    let candidate = join(parsed.dir, `${parsed.name}-legacy-${suffix}${parsed.ext}`)
    while (await pathExists(candidate)) {
      if (await sameFile(sourcePath, candidate, sourceSize)) {
        return { path: candidate, copied: false, conflict: true }
      }
      suffix++
      candidate = join(parsed.dir, `${parsed.name}-legacy-${suffix}${parsed.ext}`)
    }
    await copyFile(sourcePath, candidate)
    return { path: candidate, copied: true, conflict: true }
  }
  await copyFile(sourcePath, destinationPath)
  return { path: destinationPath, copied: true, conflict: false }
}

export async function migrateStudentFolderFiles(
  legacyFolderPath: string,
  canonicalFolderPath: string,
  onFileCopied?: (sourcePath: string, destinationPath: string) => void,
): Promise<{ migratedFiles: number; skippedFiles: number; conflictCount: number }> {
  const sourceFiles = await listFiles(legacyFolderPath)
  let migratedFiles = 0
  let skippedFiles = 0
  let conflictCount = 0
  for (const sourceFile of sourceFiles) {
    const destinationPath = join(canonicalFolderPath, sourceFile.relativePath)
    const result = await copyWithoutOverwrite(sourceFile.sourcePath, destinationPath, sourceFile.size)
    if (result.copied) migratedFiles++
    else skippedFiles++
    if (result.conflict) conflictCount++
    onFileCopied?.(sourceFile.sourcePath, result.path)
  }
  return { migratedFiles, skippedFiles, conflictCount }
}

function updatePathReferences(db: DesktopDb, projectId: number, sourcePath: string, destinationPath: string): void {
  db.update(photosTable)
    .set({ filePath: destinationPath })
    .where(and(eq(photosTable.projectId, projectId), eq(photosTable.filePath, sourcePath)))
    .run()
  db.update(imageFilesTable)
    .set({ storedPath: destinationPath })
    .where(eq(imageFilesTable.storedPath, sourcePath))
    .run()
  db.update(qrMarkersTable)
    .set({ filePath: destinationPath })
    .where(and(eq(qrMarkersTable.projectId, projectId), eq(qrMarkersTable.filePath, sourcePath)))
    .run()
}

export async function migrateStudentFoldersAt(
  db: DesktopDb,
  projectId: number,
  photosDir: string,
): Promise<FolderMigrationResult> {
  const project = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get()
  if (!project) throw new Error(`Project ${projectId} not found`)
  const classes = db.select().from(classesTable).where(eq(classesTable.projectId, projectId)).all()
  const students = db.select().from(studentsTable).where(eq(studentsTable.projectId, projectId)).all()
  const preview = await previewStudentFolderMigration({
    projectId,
    photosDir,
    project,
    classes,
    students,
  })

  let migratedFiles = 0
  let skippedFiles = 0
  let conflictCount = 0
  for (const item of preview.students.filter((candidate) => candidate.legacyFolderFound)) {
    const folderResult = await migrateStudentFolderFiles(
      item.legacyFolderPath!,
      item.canonicalFolderPath,
      (sourcePath, destinationPath) => updatePathReferences(db, projectId, sourcePath, destinationPath),
    )
    migratedFiles += folderResult.migratedFiles
    skippedFiles += folderResult.skippedFiles
    conflictCount += folderResult.conflictCount
  }

  return {
    projectId,
    legacyFolderCount: preview.legacyFolderCount,
    migratedFiles,
    skippedFiles,
    conflictCount,
    originalsPreserved: true,
  }
}
