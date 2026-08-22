/**
 * Cloud sync IPC handlers.
 * Lets the desktop app list and pull projects directly from the cloud API
 * using the configured apiUrl + connection token — no JSON file needed.
 */

import { ipcMain } from 'electron'
import { eq } from 'drizzle-orm'
import { getDb } from '../db'
import { projectsTable, classesTable, studentsTable } from '../db/schema'
import { getUploadConfig } from './upload'

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

export function registerCloudHandlers() {
  // List all projects available on the cloud API
  ipcMain.handle('cloud:listProjects', async (): Promise<{ ok: boolean; projects?: CloudProject[]; error?: string }> => {
    const { apiUrl, connectionToken } = getUploadConfig()
    if (!apiUrl || !connectionToken) {
      return { ok: false, error: 'Cloud connection not configured. Set API URL and desktop connection token in Settings.' }
    }

    try {
      const url = `${apiUrl.replace(/\/+$/, '')}/api/desktop/projects`
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${connectionToken}` },
        signal: AbortSignal.timeout(10000),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        return { ok: false, error: body.error ?? `Server returned ${res.status}` }
      }

      const projects = await res.json() as CloudProject[]
      return { ok: true, projects }
    } catch (err) {
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
      const { apiUrl, connectionToken } = getUploadConfig()
      if (!apiUrl || !connectionToken) {
        return { ok: false, error: 'Cloud connection not configured' }
      }

      try {
        const url = `${apiUrl.replace(/\/+$/, '')}/api/desktop/projects/${cloudProjectId}/bundle`
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${connectionToken}` },
          signal: AbortSignal.timeout(30000),
        })

        if (!res.ok) {
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

        const db = getDb()
        const { project: p, classes, students } = bundle

        // Upsert project by schoolName
        const existing = db
          .select()
          .from(projectsTable)
          .where(eq(projectsTable.schoolName, p.schoolName))
          .get()

        let localProjectId: number
        if (existing) {
          db.update(projectsTable)
            .set({
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
          localProjectId = existing.id
          // Clear classes/students so we get a clean re-import
          db.delete(classesTable).where(eq(classesTable.projectId, localProjectId)).run()
        } else {
          const result = db
            .insert(projectsTable)
            .values({
              schoolName: p.schoolName,
              photoDate: p.photoDate ?? null,
              address: p.address ?? null,
              contactName: p.contactName ?? null,
              contactEmail: p.contactEmail ?? null,
              contactPhone: p.contactPhone ?? null,
              notes: p.notes ?? null,
            })
            .returning()
            .get()
          localProjectId = result.id
        }

        // Build class id map: cloud id → local id
        const classIdMap = new Map<number, number>()
        let classesImported = 0
        for (const cls of classes) {
          const [inserted] = db
            .insert(classesTable)
            .values({ projectId: localProjectId, className: cls.className })
            .returning()
            .all()
          classIdMap.set(cls.id, inserted.id)
          classesImported++
        }

        // Insert students
        let studentsImported = 0
        for (const s of students) {
          const localClassId = classIdMap.get(s.classId)
          if (!localClassId) continue
          db.insert(studentsTable)
            .values({
              projectId: localProjectId,
              classId: localClassId,
              firstName: s.firstName,
              lastName: s.lastName,
              generatedStudentId: s.generatedStudentId,
              email: s.email ?? null,
              phone: s.phone ?? null,
              simpleQr: s.simpleQr ?? null,
              jsonQr: s.jsonQr ?? null,
            })
            .run()
          studentsImported++
        }

        return { ok: true, classesImported, studentsImported }
      } catch (err) {
        return { ok: false, error: String(err) }
      }
    },
  )
}
