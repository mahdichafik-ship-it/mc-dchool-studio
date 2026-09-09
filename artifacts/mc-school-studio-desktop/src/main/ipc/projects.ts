import { ipcMain } from 'electron'
import { readFileSync, mkdirSync } from 'fs'
import { randomBytes } from 'crypto'
import { dirname, join } from 'path'
import { eq, count, and } from 'drizzle-orm'
import { getDb, getPhotosDir } from '../db'
import { projectsTable, classesTable, studentsTable, photosTable } from '../db/schema'
import type { Project, Class, Student, ImportResult, CreateStudentResult } from '../../shared/types'
import { safeProjectFolderName } from '../lib/retirement'
import {
  ensureProjectStorageLayout,
  getPhotoSystemLayout,
  getProjectStorageLayout,
} from '../lib/storageLayout'
import { formatStudentFolderName } from '../lib/photoFileNaming'
import { syncStudentCloudIdentity } from './upload'

function now() {
  return new Date().toISOString()
}

function generateUniqueLocalStudentId(projectId: number): string {
  const db = getDb()
  const existing = new Set(
    db.select({ id: studentsTable.generatedStudentId })
      .from(studentsTable)
      .where(eq(studentsTable.projectId, projectId))
      .all()
      .map((row) => row.id.toUpperCase()),
  )
  for (let attempt = 0; attempt < 1000; attempt++) {
    const candidate = randomBytes(8)
      .toString('base64url')
      .replace(/[^A-Z0-9]/gi, '')
      .slice(0, 7)
      .toUpperCase()
    if (candidate.length === 7 && !existing.has(candidate)) return candidate
  }
  throw new Error('Could not generate a unique student code.')
}

function toStudent(
  student: typeof studentsTable.$inferSelect,
  className: string,
  photoCount = 0,
): Student {
  return {
    id: student.id,
    projectId: student.projectId,
    classId: student.classId,
    className,
    firstName: student.firstName,
    lastName: student.lastName,
    generatedStudentId: student.generatedStudentId,
    simpleQr: student.simpleQr,
    jsonQr: student.jsonQr,
    photoCount,
    createdAt: student.createdAt,
    updatedAt: student.updatedAt,
  }
}

function enrichProject(
  p: typeof projectsTable.$inferSelect,
  classCount: number,
  studentCount: number,
  photoCount: number,
): Project {
  return {
    id: p.id,
    schoolName: p.schoolName,
    photoDate: p.photoDate,
    address: p.address,
    contactName: p.contactName,
    contactEmail: p.contactEmail,
    contactPhone: p.contactPhone,
    notes: p.notes,
    watchFolder: p.watchFolder,
    finishedAt: p.finishedAt,
    classCount,
    studentCount,
    photoCount,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }
}

export function prepareProjectFolders(
  projectDb: ReturnType<typeof getDb>,
  projectId: number,
): void {
  const project = projectDb.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get()
  if (!project) return

  const projectDir = join(getPhotosDir(), safeProjectFolderName(project.schoolName))
  mkdirSync(projectDir, { recursive: true })

  const classes = projectDb.select().from(classesTable).where(eq(classesTable.projectId, projectId)).all()
  for (const cls of classes) {
    const classDir = join(projectDir, safeProjectFolderName(cls.className))
    mkdirSync(classDir, { recursive: true })

    const students = projectDb.select().from(studentsTable).where(eq(studentsTable.classId, cls.id)).all()
    for (const student of students) {
      mkdirSync(
        join(
          classDir,
          safeProjectFolderName(formatStudentFolderName(
            student.firstName,
            student.lastName,
            student.generatedStudentId,
          )),
        ),
        { recursive: true },
      )
    }
  }

  ensureProjectStorageLayout(
    getProjectStorageLayout(
      getPhotoSystemLayout(dirname(getPhotosDir())),
      project.id,
      project.schoolName,
    ),
  )
}

export function registerProjectHandlers() {
  const db = getDb()

  ipcMain.handle('projects:list', async (): Promise<Project[]> => {
    const projects = db.select().from(projectsTable).orderBy(projectsTable.updatedAt).all()
    return projects.map((p) => {
      const [{ classCount }] = db
        .select({ classCount: count() })
        .from(classesTable)
        .where(eq(classesTable.projectId, p.id))
        .all()
      const [{ studentCount }] = db
        .select({ studentCount: count() })
        .from(studentsTable)
        .where(eq(studentsTable.projectId, p.id))
        .all()
      const [{ photoCount }] = db
        .select({ photoCount: count() })
        .from(photosTable)
        .where(eq(photosTable.projectId, p.id))
        .all()
      return enrichProject(p, classCount, studentCount, photoCount)
    })
  })

  ipcMain.handle('projects:get', async (_e, { projectId }: { projectId: number }): Promise<Project | null> => {
    const [p] = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).all()
    if (!p) return null
    const [{ classCount }] = db.select({ classCount: count() }).from(classesTable).where(eq(classesTable.projectId, p.id)).all()
    const [{ studentCount }] = db.select({ studentCount: count() }).from(studentsTable).where(eq(studentsTable.projectId, p.id)).all()
    const [{ photoCount }] = db.select({ photoCount: count() }).from(photosTable).where(eq(photosTable.projectId, p.id)).all()
    prepareProjectFolders(db, projectId)
    return enrichProject(p, classCount, studentCount, photoCount)
  })

  ipcMain.handle(
    'projects:setWatchFolder',
    async (_e, { projectId, folderPath }: { projectId: number; folderPath: string }) => {
      db.update(projectsTable)
        .set({ watchFolder: folderPath, updatedAt: now() })
        .where(eq(projectsTable.id, projectId))
        .run()
    },
  )

  ipcMain.handle('projects:import', async (_e, { filePath }: { filePath: string }): Promise<ImportResult> => {
    const raw = readFileSync(filePath, 'utf-8')
    const bundle = JSON.parse(raw)
    const { project: p, classes, students } = bundle

    // Upsert project by schoolName
    const existing = db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.schoolName, p.schoolName))
      .get()

    let projectId: number
    if (existing) {
      db.update(projectsTable)
        .set({
          cloudId: Number.isInteger(p.id) ? p.id : existing.cloudId,
          schoolName: p.schoolName,
          photoDate: p.photoDate ?? null,
          address: p.address ?? null,
          contactName: p.contactName ?? null,
          contactEmail: p.contactEmail ?? null,
          contactPhone: p.contactPhone ?? null,
          notes: p.notes ?? null,
          updatedAt: now(),
        })
        .where(eq(projectsTable.id, existing.id))
        .run()
      projectId = existing.id
      // Clear and re-import classes/students
      db.delete(classesTable).where(eq(classesTable.projectId, projectId)).run()
    } else {
      const result = db
        .insert(projectsTable)
        .values({
          cloudId: Number.isInteger(p.id) ? p.id : null,
          schoolName: p.schoolName,
          photoDate: p.photoDate ?? null,
          address: p.address ?? null,
          contactName: p.contactName ?? null,
          contactEmail: p.contactEmail ?? null,
          contactPhone: p.contactPhone ?? null,
          notes: p.notes ?? null,
          createdAt: p.createdAt ?? now(),
          updatedAt: now(),
        })
        .returning()
        .get()
      projectId = result.id
    }

    const classIdMap = new Map<number, number>()
    for (const cls of classes) {
      const result = db
        .insert(classesTable)
        .values({
          cloudId: Number.isInteger(cls.id) ? cls.id : null,
          projectId,
          className: cls.className,
          createdAt: cls.createdAt ?? now(),
          updatedAt: cls.updatedAt ?? now(),
        })
        .returning()
        .get()
      classIdMap.set(cls.id, result.id)
    }

    let studentsImported = 0
    for (const stu of students) {
      const localClassId = classIdMap.get(stu.classId)
      if (!localClassId) continue
      db.insert(studentsTable)
        .values({
          cloudId: Number.isInteger(stu.id) ? stu.id : null,
          projectId,
          classId: localClassId,
          firstName: stu.firstName,
          lastName: stu.lastName,
          generatedStudentId: stu.generatedStudentId,
          simpleQr: stu.simpleQr ?? null,
          jsonQr: stu.jsonQr ?? null,
          createdAt: stu.createdAt ?? now(),
          updatedAt: stu.updatedAt ?? now(),
        })
        .run()
      studentsImported++
    }

    const proj = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get()!
    prepareProjectFolders(db, projectId)
    return {
      project: enrichProject(proj, classes.length, studentsImported, 0),
      classesImported: classes.length,
      studentsImported,
    }
  })

  // Classes
  ipcMain.handle('classes:list', async (_e, { projectId }: { projectId: number }): Promise<Class[]> => {
    const rows = db
      .select()
      .from(classesTable)
      .where(eq(classesTable.projectId, projectId))
      .orderBy(classesTable.className)
      .all()

    return rows.map((c) => {
      const [{ studentCount }] = db
        .select({ studentCount: count() })
        .from(studentsTable)
        .where(eq(studentsTable.classId, c.id))
        .all()
      return {
        id: c.id,
        projectId: c.projectId,
        className: c.className,
        studentCount,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      }
    })
  })

  // Students
  ipcMain.handle(
    'students:create',
    async (
      _e,
      input: { projectId: number; classId: number; firstName: string; lastName: string },
    ): Promise<CreateStudentResult> => {
      const firstName = input.firstName.trim()
      const lastName = input.lastName.trim()
      if (!firstName || !lastName || firstName.length > 100 || lastName.length > 100) {
        throw new Error('Enter a first and last name (maximum 100 characters each).')
      }

      const project = db.select().from(projectsTable).where(eq(projectsTable.id, input.projectId)).get()
      if (!project) throw new Error('Project not found.')
      if (project.finishedAt) throw new Error('This project is finished and its roster can no longer be changed.')

      const cls = db
        .select()
        .from(classesTable)
        .where(and(eq(classesTable.id, input.classId), eq(classesTable.projectId, input.projectId)))
        .get()
      if (!cls) throw new Error('Choose a class from this project.')

      const timestamp = now()
      const student = db.insert(studentsTable).values({
        projectId: input.projectId,
        classId: input.classId,
        firstName,
        lastName,
        generatedStudentId: generateUniqueLocalStudentId(input.projectId),
        createdAt: timestamp,
        updatedAt: timestamp,
      }).returning().get()

      prepareProjectFolders(db, input.projectId)
      const sync = await syncStudentCloudIdentity(input.projectId, student.id)
      const refreshed = db.select().from(studentsTable).where(eq(studentsTable.id, student.id)).get() ?? student
      return {
        student: toStudent(refreshed, cls.className),
        cloudSynced: sync.synced,
        ...(sync.error ? { syncError: sync.error } : {}),
      }
    },
  )

  ipcMain.handle(
    'students:list',
    async (
      _e,
      { projectId, classId }: { projectId: number; classId?: number },
    ): Promise<Student[]> => {
      const rows = db
        .select({
          student: studentsTable,
          className: classesTable.className,
        })
        .from(studentsTable)
        .leftJoin(classesTable, eq(studentsTable.classId, classesTable.id))
        .where(eq(studentsTable.projectId, projectId))
        .orderBy(classesTable.className, studentsTable.lastName, studentsTable.firstName)
        .all()
        .filter((r) => !classId || r.student.classId === classId)

      return rows.map(({ student: s, className }) => {
        const [{ photoCount }] = db
          .select({ photoCount: count() })
          .from(photosTable)
          .where(eq(photosTable.studentId, s.id))
          .all()
        return toStudent(s, className ?? '', photoCount)
      })
    },
  )
}
