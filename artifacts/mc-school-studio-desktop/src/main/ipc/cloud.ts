/**
 * Cloud sync IPC handlers.
 * Lets the desktop app list and pull projects directly from the cloud API
 * using the configured apiUrl + connection token — no JSON file needed.
 */

import { ipcMain } from 'electron'
import { eq } from 'drizzle-orm'
import { getDb } from '../db'
import { projectsTable, classesTable, studentsTable } from '../db/schema'
import { prepareProjectFolders } from './projects'
import {
  getUploadConfig,
  getSetting,
  invalidateDesktopCredentials,
  isCloudSessionVerified,
  markCloudSessionUnavailable,
  markCloudSessionVerified,
} from './upload'
import { WorkBarrier } from '../lib/workBarrier'

function now() {
  return new Date().toISOString()
}

export interface CloudProject {
  id: number
  schoolName: string
  photoDate: string | null
  address: string | null
  contactName: string | null
  classCount: number
  studentCount: number
  updatedAt: string
}

const cloudImportBarrier = new WorkBarrier()

export function disableCloudImportsForRetirement(): Promise<void> {
  return cloudImportBarrier.disableAndDrain()
}

export function enableCloudImportsAfterSignIn(): void {
  cloudImportBarrier.enable()
}

export function registerCloudHandlers() {
  // List all projects available on the cloud API
  ipcMain.handle('cloud:listProjects', async (): Promise<{ ok: boolean; projects?: CloudProject[]; error?: string }> => {
    const { apiUrl, connectionToken } = getUploadConfig()
    if (!apiUrl || !connectionToken) {
       return { ok: false, error: 'Sign in to Volume Capture before syncing projects.' }
    }
    if (!isCloudSessionVerified()) {
      return { ok: false, error: 'Cloud sync needs an internet connection. Local projects remain available offline.' }
    }

    try {
      const url = `${apiUrl.replace(/\/+$/, '')}/api/desktop/projects`
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${connectionToken}` },
        signal: AbortSignal.timeout(10000),
      })

      if (!res.ok) {
        if (res.status === 401) invalidateDesktopCredentials(true)
        else if (res.status >= 500) markCloudSessionUnavailable()
        const body = await res.json().catch(() => ({})) as { error?: string }
        return { ok: false, error: body.error ?? `Server returned ${res.status}` }
      }

      const projects = await res.json() as CloudProject[]
      markCloudSessionVerified()
      return { ok: true, projects }
    } catch (err) {
      markCloudSessionUnavailable()
      return { ok: false, error: String(err) }
    }
  })

  // Pull a specific project bundle from the cloud and import it into local SQLite
  ipcMain.handle(
    'cloud:pullProject',
    async (_e, { cloudProjectId }: { cloudProjectId: number }): Promise<{
      ok: boolean
      classesImported?: number
      studentsImported?: number
      error?: string
    }> => {
      if (cloudImportBarrier.isDisabled() || getSetting('desktop_retired') === '1') {
        return { ok: false, error: 'Cloud sync is disabled because this desktop was retired.' }
      }
      const { apiUrl, connectionToken } = getUploadConfig()
      if (!apiUrl || !connectionToken) {
         return { ok: false, error: 'Sign in to Volume Capture before pulling projects.' }
      }
      if (!isCloudSessionVerified()) {
        return { ok: false, error: 'Cloud sync needs an internet connection. Local projects remain available offline.' }
      }

      const task = cloudImportBarrier.run(async () => {
        try {
        const url = `${apiUrl.replace(/\/+$/, '')}/api/desktop/projects/${cloudProjectId}/bundle`
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${connectionToken}` },
          signal: AbortSignal.timeout(30000),
        })

        if (!res.ok) {
          if (res.status === 401) invalidateDesktopCredentials(true)
          else if (res.status >= 500) markCloudSessionUnavailable()
          const body = await res.json().catch(() => ({})) as { error?: string }
          return { ok: false, error: body.error ?? `Server returned ${res.status}` }
        }

        const bundle = await res.json() as {
          project: {
            id: number; schoolName: string; photoDate?: string; address?: string
            contactName?: string; contactEmail?: string; contactPhone?: string; notes?: string
          }
          classes: { id: number; className: string }[]
          students: {
            id: number; classId: number; className: string | null
            firstName: string; lastName: string; generatedStudentId: string
            email?: string | null; phone?: string | null
            simpleQr?: string | null; jsonQr?: string | null
          }[]
        }
        markCloudSessionVerified()

        if (cloudImportBarrier.isDisabled() || getSetting('desktop_retired') === '1') {
          return { ok: false, error: 'Cloud sync stopped because this desktop was retired.' }
        }

        const db = getDb()
        const { project: p, classes, students } = bundle

        const imported = db.transaction((tx) => {
          const localProjects = tx.select().from(projectsTable).all()
          const existingProject = localProjects.find((project) => project.cloudId === p.id)
            ?? localProjects.find((project) => project.cloudId === null && project.schoolName === p.schoolName)

          const projectValues = {
            cloudId: p.id,
            schoolName: p.schoolName,
            photoDate: p.photoDate ?? null,
            address: p.address ?? null,
            contactName: p.contactName ?? null,
            contactEmail: p.contactEmail ?? null,
            contactPhone: p.contactPhone ?? null,
            notes: p.notes ?? null,
            updatedAt: now(),
          }
          const localProject = existingProject
            ? tx.update(projectsTable)
              .set(projectValues)
              .where(eq(projectsTable.id, existingProject.id))
              .returning()
              .get()
            : tx.insert(projectsTable)
              .values(projectValues)
              .returning()
              .get()

          // Reconcile in place so photos keep their local student foreign keys.
          // Missing cloud rows are deliberately retained; removing roster rows
          // here could orphan captures that still need to upload.
          const localClasses = tx
            .select()
            .from(classesTable)
            .where(eq(classesTable.projectId, localProject.id))
            .all()
          const classIdMap = new Map<number, number>()
          for (const cls of classes) {
            const existingClass = localClasses.find((row) => row.cloudId === cls.id)
              ?? localClasses.find((row) => row.cloudId === null && row.className === cls.className)
            const localClass = existingClass
              ? tx.update(classesTable)
                .set({ cloudId: cls.id, className: cls.className, updatedAt: now() })
                .where(eq(classesTable.id, existingClass.id))
                .returning()
                .get()
              : tx.insert(classesTable)
                .values({ cloudId: cls.id, projectId: localProject.id, className: cls.className })
                .returning()
                .get()
            classIdMap.set(cls.id, localClass.id)
          }

          const localStudents = tx
            .select()
            .from(studentsTable)
            .where(eq(studentsTable.projectId, localProject.id))
            .all()
          let studentsImported = 0
          for (const student of students) {
            const localClassId = classIdMap.get(student.classId)
            if (!localClassId) continue
            const existingStudent = localStudents.find((row) => row.cloudId === student.id)
              ?? localStudents.find((row) =>
                row.cloudId === null && row.generatedStudentId === student.generatedStudentId)
            const studentValues = {
              cloudId: student.id,
              projectId: localProject.id,
              classId: localClassId,
              firstName: student.firstName,
              lastName: student.lastName,
              generatedStudentId: student.generatedStudentId,
              email: student.email ?? null,
              phone: student.phone ?? null,
              simpleQr: student.simpleQr ?? null,
              jsonQr: student.jsonQr ?? null,
              updatedAt: now(),
            }
            if (existingStudent) {
              tx.update(studentsTable)
                .set(studentValues)
                .where(eq(studentsTable.id, existingStudent.id))
                .run()
            } else {
              tx.insert(studentsTable).values(studentValues).run()
            }
            studentsImported++
          }

          return { projectId: localProject.id, classesImported: classes.length, studentsImported }
        })

        prepareProjectFolders(db, imported.projectId)
        return { ok: true, ...imported }
      } catch (err) {
        return { ok: false, error: String(err) }
      }
      })
      return task ?? { ok: false, error: 'Cloud sync is disabled because this desktop was retired.' }
    },
  )
}
