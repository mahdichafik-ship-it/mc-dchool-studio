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

export type CapturePairingStatus = 'pending' | 'jpeg_only' | 'raw_only' | 'complete' | 'unpaired'

export interface CaptureFileReview {
  id: number
  fileRole: 'JPEG' | 'RAW'
  fileFormat: string
  originalFilename: string
  storedPath: string
  fileSize: number | null
  uploadStatus: UploadStatus
  fileUrl: string | null
}

export interface CaptureReview {
  id: number
  projectId: number
  studentId: number | null
  classId: number | null
  baseFilename: string
  capturedAt: string
  sequence: number | null
  favorite: boolean
  rejected: boolean
  selected: boolean
  pairingStatus: CapturePairingStatus
  assignmentLocked: boolean
  files: CaptureFileReview[]
  thumbnailData: string | null
  legacyPhoto: Photo | null
}

export interface QrMarkerReview {
  id: number
  projectId: number
  studentId: number
  filePath: string
  fileName: string
  capturedAt: string
  thumbnailData: string | null
  createdAt: string
}

export interface StudentCaptureReview {
  captures: CaptureReview[]
  qrMarkers: QrMarkerReview[]
}

export interface CaptureCompletenessSummary {
  total: number
  complete: number
  jpegOnly: number
  rawOnly: number
  unpaired: number
}

export interface CaptureUpdatedEvent {
  projectId: number
  captureId: number
  studentId: number | null
}

export type CaptureExportMode =
  | 'all'
  | 'paired'
  | 'jpeg_only'
  | 'raw_only'
  | 'selected'
  | 'favorite'
  | 'final_selection'

export interface CaptureFileUploadStatusChangedEvent {
  captureId: number
  fileId: number
  studentId: number
  fileRole: 'JPEG' | 'RAW'
  status: UploadStatus
}

export interface CaptureExportResult {
  ok: boolean
  outputDir?: string
  exportedCaptureCount?: number
  exportedFileCount?: number
  skippedMissingFiles?: number
  error?: string
}

export interface PhotoMatchedEvent {
  photo: Photo
  student: Student
}

export interface PhotoMarkerEvent {
  markerId: number
  fileName: string
  capturedAt: string
  student: Student
}

export interface PhotoUnmatchedEvent {
  projectId: number
  photoId?: number
  filePath: string
  fileName: string
  reason: string
}

export type UploadStatus = 'pending' | 'uploading' | 'done' | 'error' | null

export interface ProjectUploadStatusRow {
  id: number
  studentId: number | null
  uploadStatus: UploadStatus
  fileUrl: string | null
}

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

export interface PhotoDeletedEvent {
  photoId: number
  projectId: number
  studentId: number | null
}

export interface PhotoReassignedEvent {
  photoId: number
  projectId: number
  fromStudentId: number | null
  toStudentId: number
}
