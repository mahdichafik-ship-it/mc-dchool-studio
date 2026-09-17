import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { ipcMain } from 'electron'
import { and, eq, isNull } from 'drizzle-orm'
import { getDb } from '../db'
import {
  capturesTable,
  classesTable,
  groupCapturesTable,
  groupCaptureFilesTable,
  groupMembersTable,
  imageFilesTable,
  projectsTable,
  studentsTable,
} from '../db/schema'

export const PIXIESET_HEADERS = [
  'Collection Name *', 'Email * [Contact]', 'First name * [Contact]',
  'Last name [Contact]', 'Company [Contact]', 'Phone [Contact]',
  'Address Line 1 [Contact]', 'Address Line 2 [Contact]', 'City [Contact]',
  'State/Province [Contact]', 'Zip/Postal Code [Contact]', 'Country [Contact]',
  'Note [Contact]',
] as const

export interface PixiesetIssue {
  studentId: number
  generatedStudentId: string
  studentName: string
  reason: string
}
export interface PixiesetPreflight {
  totalStudents: number
  readyStudents: number
  missingEmail: number
  invalidEmail: number
  missingGuardianFirstName: number
  missingRatedPhotos: number
  issues: PixiesetIssue[]
}
export interface PixiesetExportResult {
  ok: boolean
  outputDir?: string
  csvPath?: string
  reportPath?: string
  collectionsCreated?: number
  portraitPhotosCopied?: number
  groupPhotosCopied?: number
  excluded?: PixiesetIssue[]
  preflight?: PixiesetPreflight
  error?: string
}

export function isPixiesetApprovedCapture(capture: { rating: number; rejected?: boolean }): boolean {
  return capture.rating > 0 && !capture.rejected
}

export function csvEscape(value: string | null | undefined): string {
  const text = value ?? ''
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function isValidPixiesetEmail(value: string | null | undefined): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value?.trim() ?? '')
}

function safeSegment(value: string, fallback: string): string {
  const cleaned = value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback
}

export function safeCollectionName(className: string, firstName: string, lastName: string, id: string): string {
  const base = safeSegment(`${className} - ${firstName} ${lastName}`, '')
  return (base || `Collection-${safeSegment(id, 'student')}`).slice(0, 150)
}

function isInside(parent: string, candidate: string): boolean {
  const root = resolve(parent)
  const path = resolve(candidate)
  return path === root || path.startsWith(`${root}${sep}`)
}

export function uniquePath(directory: string, original: string, used: Set<string>): string {
  const clean = original.normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim() || 'photo.jpg'
  const dot = clean.lastIndexOf('.')
  const stem = dot > 0 ? clean.slice(0, dot) : clean
  const ext = dot > 0 ? clean.slice(dot) : '.jpg'
  let candidate = clean
  let n = 2
  while (used.has(candidate.toLocaleLowerCase()) || existsSync(join(directory, candidate))) {
    candidate = `${stem}-${n++}${ext}`
  }
  used.add(candidate.toLocaleLowerCase())
  return join(directory, candidate)
}

function isJpeg(file: { fileRole: string; fileFormat: string; storedPath: string }): boolean {
  return file.fileRole === 'JPEG' && /jpe?g$/i.test(file.fileFormat || file.storedPath)
}

export function filterPixiesetJpegs<T extends { fileRole: string; fileFormat: string; storedPath: string }>(
  files: T[],
): T[] {
  return files.filter(isJpeg)
}

export function addGroupFilesForMembers<T>(
  current: Map<number, T[]>,
  memberIds: number[],
  files: T[],
): void {
  for (const studentId of memberIds) {
    current.set(studentId, [...(current.get(studentId) ?? []), ...files])
  }
}

export function buildPixiesetCsv(rows: Array<{
  collectionName: string
  email: string
  firstName: string
  lastName?: string | null
  company?: string | null
  phone?: string | null
  addressLine1?: string | null
  addressLine2?: string | null
  city?: string | null
  stateProvince?: string | null
  zipPostalCode?: string | null
  country?: string | null
  contactNote?: string | null
}>): string {
  const lines = [PIXIESET_HEADERS.join(',')]
  for (const row of rows) {
    lines.push([
      row.collectionName, row.email, row.firstName, row.lastName, row.company,
      row.phone, row.addressLine1, row.addressLine2, row.city, row.stateProvince,
      row.zipPostalCode, row.country, row.contactNote,
    ].map(csvEscape).join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}

export function exportPixiesetPackage(
  projectId: number,
  destinationDir: string,
  options: { isCancelled?: () => boolean } = {},
): PixiesetExportResult {
  const db = getDb()
  const project = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get()
  if (!project) return { ok: false, error: 'Project not found.' }
  const classes = db.select().from(classesTable).where(eq(classesTable.projectId, projectId)).all()
  const classById = new Map(classes.map((item) => [item.id, item.className]))
  const students = db.select().from(studentsTable).where(eq(studentsTable.projectId, projectId)).all()
  const portraitByStudent = new Map<number, typeof imageFilesTable.$inferSelect[]>()
  const captures = db.select().from(capturesTable)
    .where(and(eq(capturesTable.projectId, projectId), isNull(capturesTable.groupId))).all()
  for (const capture of captures) {
    if (!capture.studentId || !isPixiesetApprovedCapture(capture)) continue
    const files = db.select().from(imageFilesTable).where(eq(imageFilesTable.captureId, capture.id)).all()
      .filter(isJpeg)
    portraitByStudent.set(capture.studentId, [...(portraitByStudent.get(capture.studentId) ?? []), ...files])
  }
  const groupPhotosByStudent = new Map<number, typeof groupCaptureFilesTable.$inferSelect[]>()
  const groups = db.select().from(groupMembersTable).all()
  const approvedGroups = db.select().from(groupCapturesTable)
    .where(eq(groupCapturesTable.projectId, projectId)).all()
    .filter((capture) => isPixiesetApprovedCapture(capture))
  for (const capture of approvedGroups) {
    const files = filterPixiesetJpegs(
      db.select().from(groupCaptureFilesTable).where(eq(groupCaptureFilesTable.captureId, capture.id)).all(),
    )
    addGroupFilesForMembers(
      groupPhotosByStudent,
      groups.filter((item) => item.groupId === capture.groupId).map((member) => member.studentId),
      files,
    )
  }

  const issues: PixiesetIssue[] = []
  const rows: Array<{
    student: typeof students[number]
    collectionName: string
    portraitFiles: typeof imageFilesTable.$inferSelect[]
    groupFiles: typeof groupCaptureFilesTable.$inferSelect[]
  }> = []
  const collectionNames = new Set<string>()
  const issueFor = (student: typeof students[number], reason: string): PixiesetIssue => ({
    studentId: student.id,
    generatedStudentId: student.generatedStudentId,
    studentName: `${student.firstName} ${student.lastName}`.trim(),
    reason,
  })
  for (const student of students) {
    const portraitFiles = portraitByStudent.get(student.id) ?? []
    const groupFiles = groupPhotosByStudent.get(student.id) ?? []
    if (!student.email?.trim()) issues.push(issueFor(student, 'Missing parent email'))
    else if (!isValidPixiesetEmail(student.email)) issues.push(issueFor(student, 'Invalid parent email'))
    if (!student.guardianFirstName?.trim()) issues.push(issueFor(student, 'Missing parent first name'))
    if (portraitFiles.length === 0 && groupFiles.length === 0) issues.push(issueFor(student, 'No rated photographs'))
    if (!isValidPixiesetEmail(student.email) || !student.guardianFirstName?.trim() || portraitFiles.length + groupFiles.length === 0) continue
    let collectionName = safeCollectionName(
      classById.get(student.classId) ?? 'Unassigned',
      student.firstName,
      student.lastName,
      student.generatedStudentId,
    )
    let duplicate = 1
    const baseCollectionName = collectionName
    while (collectionNames.has(collectionName.toLocaleLowerCase())) {
      const safeId = safeSegment(student.generatedStudentId, 'student')
      const suffix = duplicate === 1 ? ` [${safeId}]` : ` [${safeId}-${duplicate}]`
      collectionName = `${baseCollectionName.slice(0, Math.max(1, 150 - suffix.length))}${suffix}`
      duplicate++
    }
    collectionNames.add(collectionName.toLocaleLowerCase())
    rows.push({
      student,
      collectionName,
      portraitFiles,
      groupFiles,
    })
  }
  const preflight: PixiesetPreflight = {
    totalStudents: students.length,
    readyStudents: rows.length,
    missingEmail: students.filter((student) => !student.email?.trim()).length,
    invalidEmail: students.filter((student) => student.email?.trim() && !isValidPixiesetEmail(student.email)).length,
    missingGuardianFirstName: students.filter((student) => !student.guardianFirstName?.trim()).length,
    missingRatedPhotos: students.filter((student) => (portraitByStudent.get(student.id)?.length ?? 0) + (groupPhotosByStudent.get(student.id)?.length ?? 0) === 0).length,
    issues,
  }
  if (rows.length === 0) return { ok: false, preflight, excluded: issues, error: 'No students are ready for Pixieset export.' }

  const parent = resolve(destinationDir)
  mkdirSync(parent, { recursive: true })
  let finalDir = join(parent, 'Pixieset Export')
  let suffix = 2
  while (existsSync(finalDir)) finalDir = join(parent, `Pixieset Export (${suffix++})`)
  const staging = join(parent, `.pixieset-staging-${Date.now()}-${process.pid}`)
  const collectionsDir = join(staging, 'Collections')
  const csvRows: Parameters<typeof buildPixiesetCsv>[0] = []
  let portraitPhotosCopied = 0
  let groupPhotosCopied = 0
  try {
    mkdirSync(collectionsDir, { recursive: true })
    for (const row of rows) {
      if (options.isCancelled?.()) throw new Error('Pixieset export cancelled.')
      const folder = join(collectionsDir, row.collectionName)
      mkdirSync(folder, { recursive: true })
      const used = new Set<string>()
      for (const file of [...row.portraitFiles, ...row.groupFiles]) {
        if (!existsSync(file.storedPath)) continue
        const output = uniquePath(folder, file.originalFilename, used)
        if (!isInside(collectionsDir, output)) throw new Error('Unsafe export path.')
        copyFileSync(file.storedPath, output)
        if (row.portraitFiles.includes(file)) portraitPhotosCopied++
        else groupPhotosCopied++
      }
      if (readdirSync(folder).length === 0) {
        rmSync(folder, { recursive: true, force: true })
        issues.push(issueFor(row.student, 'Rated source photographs are missing'))
        continue
      }
      csvRows.push({
        collectionName: row.collectionName,
        email: row.student.email!.trim(),
        firstName: row.student.guardianFirstName!.trim(),
        lastName: row.student.guardianLastName?.trim() || null,
        company: row.student.company,
        phone: row.student.phone,
        addressLine1: row.student.addressLine1,
        addressLine2: row.student.addressLine2,
        city: row.student.city,
        stateProvince: row.student.stateProvince,
        zipPostalCode: row.student.zipPostalCode,
        country: row.student.country,
        contactNote: row.student.contactNote,
      })
    }
    if (csvRows.length === 0) {
      throw new Error('No complete Pixieset collections could be created because the rated source files are missing.')
    }
    const csvPath = join(staging, 'pixieset-collection-upload.csv')
    writeFileSync(csvPath, buildPixiesetCsv(csvRows), 'utf8')
    const collectionFolders = readdirSync(collectionsDir)
    const folderSet = new Set(collectionFolders)
    if (csvRows.some((row) => !folderSet.has(row.collectionName))
      || collectionFolders.some((folder) => !csvRows.some((row) => row.collectionName === folder))) {
      throw new Error('Pixieset CSV and collection folders do not match.')
    }
    if (options.isCancelled?.()) throw new Error('Pixieset export cancelled.')
    const reportName = 'pixieset-export-report.json'
    writeFileSync(join(staging, reportName), JSON.stringify({
      status: 'complete',
      generatedAt: new Date().toISOString(),
      project: project.schoolName,
      collectionsCreated: csvRows.length,
      portraitPhotosCopied,
      groupPhotosCopied,
      excluded: issues,
    }, null, 2), 'utf8')
    renameSync(staging, finalDir)
    return {
      ok: true, outputDir: finalDir, csvPath: join(finalDir, 'pixieset-collection-upload.csv'),
      reportPath: join(finalDir, reportName),
      collectionsCreated: csvRows.length, portraitPhotosCopied, groupPhotosCopied,
      excluded: issues, preflight,
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    return { ok: false, excluded: issues, preflight, error: error instanceof Error ? error.message : String(error) }
  }
}

export function registerPixiesetExportHandlers(): void {
  ipcMain.handle('pixieset:export', (_event, input: { projectId: number; destinationDir: string }) => {
    if (!input?.destinationDir || !Number.isInteger(input.projectId)) {
      return { ok: false, error: 'Choose a destination folder and a valid project.' }
    }
    return exportPixiesetPackage(input.projectId, input.destinationDir)
  })
}