export const shootWorkspaceViewports = [
  { width: 1024, height: 700 },
  { width: 1280, height: 800 },
] as const

export type CaptureFileUploadState = {
  fileRole: 'JPEG' | 'RAW'
  uploadStatus: 'pending' | 'uploading' | 'done' | 'error' | null
  galleryReady?: boolean
}

export function captureUploadLabel(files: CaptureFileUploadState[]) {
  if (files.some((file) => file.uploadStatus === 'error')) return 'Upload failed'
  if (files.some((file) => file.uploadStatus === 'uploading')) return 'Uploading'
  if (files.some((file) => file.uploadStatus !== 'done')) return 'Queued'
  if (files.some((file) => file.fileRole === 'JPEG' && !file.galleryReady)) return 'Preparing gallery'
  return 'Uploaded'
}

export const shootWorkspaceLayoutContract = {
  root: 'shoot-workspace',
  toolbar: 'shoot-toolbar',
  watchStatus: 'shoot-watch-status',
  primaryAction: 'shoot-primary-action',
  subjectHeader: 'shoot-subject-header',
  subjectName: 'shoot-subject-name',
  captureArea: 'shoot-capture-area',
  completeness: 'shoot-completeness',
  groupBody: 'shoot-group-body',
} as const