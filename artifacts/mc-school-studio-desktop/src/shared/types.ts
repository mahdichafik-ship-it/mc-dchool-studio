// Shared types between main process and renderer (TypeScript-only, not bundled together)

export interface Project {
  id: number
  projectType: ProjectType
  schoolName: string
  photoDate: string | null
  address: string | null
  contactName: string | null
  contactEmail: string | null
  contactPhone: string | null
  notes: string | null
  watchFolder: string | null
  finishedAt: string | null
  syncStatus: ProjectSyncStatus
  syncCompletedFiles: number
  syncTotalFiles: number
  syncFailedFiles: number
  syncError: string | null
  classCount: number
  studentCount: number
  photoCount: number
  createdAt: string
  updatedAt: string
}

export type ProjectType = 'school' | 'corporate'
export type ProjectSyncStatus = 'active' | 'finished_local' | 'syncing' | 'sync_failed' | 'synced'

export function normalizeProjectType(value: unknown): ProjectType {
  return value === 'corporate' ? 'corporate' : 'school'
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
  schoolId: string | null
  email: string | null
  phone: string | null
  secondaryEmail: string | null
  guardianFirstName: string | null
  guardianLastName: string | null
  company: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  stateProvince: string | null
  zipPostalCode: string | null
  country: string | null
  contactNote: string | null
  jobTitle: string | null
  officeLocation: string | null
  photoSession: string | null
  captureNotes: string | null
  simpleQr: string | null
  jsonQr: string | null
  photoCount: number
  createdAt: string
  updatedAt: string
}

export interface FolderMigrationStudent {
  studentId: number
  classId: number
  studentName: string
  legacyFolderPath: string | null
  canonicalFolderPath: string
  legacyFolderFound: boolean
  canonicalFolderFound: boolean
  fileCount: number
  totalBytes: number
  conflicts: number
  conflictFiles: string[]
}

export interface FolderMigrationPreview {
  projectId: number
  projectFolderPath: string
  legacyFolderCount: number
  fileCount: number
  totalBytes: number
  conflictCount: number
  students: FolderMigrationStudent[]
}

export interface FolderMigrationResult {
  projectId: number
  legacyFolderCount: number
  migratedFiles: number
  skippedFiles: number
  conflictCount: number
  originalsPreserved: boolean
}

export interface StudentGroup {
  id: number
  cloudId?: number | null
  projectId: number
  classId: number | null
  name: string
  isDefaultClassGroup: boolean
  memberStudentIds: number[]
  createdAt: string
  updatedAt: string
}

export interface GroupCaptureFileReview {
  id: number
  fileRole: 'JPEG' | 'RAW'
  fileFormat: string
  originalFilename: string
  storedPath: string
  fileSize: number | null
  uploadStatus: UploadStatus
  fileUrl: string | null
  galleryReady: boolean
  previewUrl?: string
}

export interface GroupCaptureReview {
  id: number
  projectId: number
  groupId: number
  baseFilename: string
  capturedAt: string
  pairingStatus: CapturePairingStatus
  rating: number
  files: GroupCaptureFileReview[]
}

export interface CreateStudentResult {
  student: Student
  cloudSynced: boolean
  syncError?: string
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
  previewKey?: string
  previewUrl?: string
}

export type ImagePipelineStage =
  | 'filesystem event detected'
  | 'file became stable'
  | 'student lookup complete'
  | 'student assigned'
  | 'preview preparation started'
  | 'preview prepared'
  | 'thumbnail generation complete'
  | 'IPC event sent'
  | 'frontend event received'
  | 'React state update committed'
  | 'image decode started'
  | 'image decode complete'
  | 'image preview superseded'
  | 'image pixels painted'
  | 'database write started'
  | 'database write complete'
  | 'file move started'
  | 'file move complete'
  | 'RAW pairing complete'
  | 'cloud synchronization complete'

export interface ImagePipelinePreviewContext {
  traceId: string
  startedAtEpochMs: number
}

export interface ImagePipelineRendererStage {
  traceId: string
  stage: Extract<
    ImagePipelineStage,
    | 'frontend event received'
    | 'React state update committed'
    | 'image decode started'
    | 'image decode complete'
    | 'image preview superseded'
    | 'image pixels painted'
  >
  atEpochMs: number
  details?: string
}

export type CapturePairingStatus = 'pending' | 'jpeg_only' | 'raw_only' | 'complete' | 'unpaired'
export type CaptureColorLabel = 'none' | 'red' | 'yellow' | 'green' | 'blue' | 'purple'
export type CaptureAspectRatio = 'original' | '1:1' | '4:5' | '3:2' | '16:9'

export interface CaptureFraming {
  cropX: number
  cropY: number
  cropScale: number
  aspectRatio: CaptureAspectRatio
  straightenAngle: number
  rotation: 0 | 90 | 180 | 270
  pending: boolean
}

export interface CaptureFileReview {
  id: number
  fileRole: 'JPEG' | 'RAW'
  fileFormat: string
  originalFilename: string
  storedPath: string
  fileSize: number | null
  uploadStatus: UploadStatus
  fileUrl: string | null
  previewUrl?: string
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
  rating: number
  colorLabel: CaptureColorLabel
  pairingStatus: CapturePairingStatus
  assignmentLocked: boolean
  files: CaptureFileReview[]
  thumbnailData: string | null
  legacyPhoto: Photo | null
  framing: CaptureFraming
  previewPipeline?: ImagePipelinePreviewContext
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
  jpegFiles: number
  rawFiles: number
  incompletePairs: number
}

export interface CaptureUpdatedEvent {
  projectId: number
  captureId: number
  studentId: number | null
}

export interface ActiveCaptureTargetEvent {
  projectId: number
  studentId: number | null
  groupId?: number | null
  targetType?: 'student' | 'group' | 'none'
  source: 'manual' | 'qr' | 'none'
}

export type DroppedCaptureFileStatus = 'imported' | 'duplicate' | 'unsupported' | 'error'

export interface DroppedCaptureFileResult {
  filePath: string
  fileName: string
  status: DroppedCaptureFileStatus
  reason?: string
}

export interface DroppedCaptureBatchResult {
  projectId: number
  studentId: number
  total: number
  imported: number
  duplicates: number
  skipped: number
  errors: number
  files: DroppedCaptureFileResult[]
}

export interface DroppedCaptureProgressEvent {
  projectId: number
  studentId: number
  completed: number
  total: number
  result: DroppedCaptureFileResult
}

export type CaptureExportMode =
  | 'all'
  | 'paired'
  | 'jpeg_only'
  | 'raw_only'
  | 'selected'
  | 'favorite'
  | 'final_selection'

export type CaptureExportLayout = 'capture_folders' | 'lightroom_watch_folder'

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
  skippedExistingFiles?: number
  error?: string
}

export interface ProjectSyncProgressEvent {
  projectId: number
  phase: 'syncing' | 'finished-locally' | 'finished' | 'error'
  completed: number
  total: number
  failed: number
  error?: string
}

export interface ProjectSyncResult {
  ok: boolean
  completed: number
  total: number
  failed: number
  error?: string
  finishedAt?: string
  localFinished?: boolean
  syncStatus?: ProjectSyncStatus
}

export interface ProjectFinishOptions {
  photographerComment?: string
}

export interface LiveUploadState {
  projectId: number
  enabled: boolean
  running: boolean
  cloudReady: boolean
  pending: number
  uploading: number
  done: number
  error: number
  blocked: number
  total: number
  lastUploadedAt?: string
  lastError?: string
}

export interface LiveUploadQueueItem {
  key: string
  kind: 'portrait' | 'group' | 'legacy'
  fileName: string
  fileRole: 'JPEG' | 'RAW'
  subject: string
  capturedAt: string
  status: 'queued' | 'uploading' | 'failed' | 'preparing_gallery' | 'blocked'
  blockedReason?: string
  attempts: number
  retryAt?: string
  lastError?: string
}

export interface PhotoMatchedEvent {
  photo: Photo
  student: Student
  captureId?: number
  preview?: boolean
  previewKey?: string
  pipeline?: ImagePipelinePreviewContext
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
