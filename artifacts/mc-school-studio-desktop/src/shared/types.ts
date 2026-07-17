// Shared types between main process and renderer (TypeScript-only, not bundled together)

export interface Project {
  id: number
  schoolName: string
  photoDate: string | null
  address: string | null
  contactName: string | null
  contactEmail: string | null
  contactPhone: string | null
  notes: string | null
  watchFolder: string | null
  classCount: number
  studentCount: number
  photoCount: number
  createdAt: string
  updatedAt: string
}

export interface Class {
  id: number
  projectId: number
  className: string
  studentCount: number
  createdAt: string
  updatedAt: string
}

export interface Student {
  id: number
  projectId: number
  classId: number
  className: string
  firstName: string
  lastName: string
  generatedStudentId: string
  simpleQr: string | null
  jsonQr: string | null
  photoCount: number
  createdAt: string
  updatedAt: string
}

export interface Photo {
  id: number
  projectId: number
  studentId: number | null
  filePath: string
  fileName: string
  capturedAt: string
  isMatched: boolean
  thumbnailData: string | null  // base64 data URL
  createdAt: string
}

export interface PhotoMatchedEvent {
  photo: Photo
  student: Student
}

export interface PhotoUnmatchedEvent {
  filePath: string
  fileName: string
  reason: string
}

export type UploadStatus = 'pending' | 'uploading' | 'done' | 'error' | null

export interface UploadStatusChangedEvent {
  photoId: number
  studentId: number
  status: UploadStatus
}

export interface ImportResult {
  project: Project
  classesImported: number
  studentsImported: number
}
