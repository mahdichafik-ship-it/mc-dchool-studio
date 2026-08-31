/// <reference types="vite/client" />

import type {
  Project,
  Class,
  Student,
  Photo,
  PhotoMatchedEvent,
  PhotoMarkerEvent,
  PhotoUnmatchedEvent,
  PhotoDeletedEvent,
  PhotoReassignedEvent,
  ImportResult,
  UploadStatus,
  UploadStatusChangedEvent,
  ProjectUploadStatusRow,
  CaptureReview,
  StudentCaptureReview,
  CaptureCompletenessSummary,
  CaptureUpdatedEvent,
  ActiveCaptureTargetEvent,
  CaptureExportMode,
  CaptureExportResult,
  CaptureFileUploadStatusChangedEvent,
  ProjectSyncProgressEvent,
} from '../shared/types'

interface UploadConfig {
  apiUrl: string | null
  connectionToken: string | null
}

interface UploadResult {
  ok: boolean
  error?: string
}

interface AuthMember {
  email: string
  role: 'owner' | 'admin' | 'assistant' | 'photographer'
}

interface AuthSession {
  signedIn: boolean
  member?: AuthMember
  error?: string
  offline?: boolean
}

interface UpdateState {
  status: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'unsupported'
  version?: string
  percent?: number
  message?: string
}

interface CloudProject {
  id: number
  schoolName: string
  photoDate: string | null
  address: string | null
  contactName: string | null
  classCount: number
  studentCount: number
  updatedAt: string
}

interface CloudProjectListResult {
  ok: boolean
  projects?: CloudProject[]
  error?: string
}

interface CloudProjectPullResult {
  ok: boolean
  classesImported?: number
  studentsImported?: number
  error?: string
}

interface ElectronAPI {
  invoke(channel: 'projects:list'): Promise<Project[]>
  invoke(channel: 'projects:get', args: { projectId: number }): Promise<Project | null>
  invoke(channel: 'projects:import', args: { filePath: string }): Promise<ImportResult>
  invoke(channel: 'projects:setWatchFolder', args: { projectId: number; folderPath: string }): Promise<void>
  invoke(channel: 'classes:list', args: { projectId: number }): Promise<Class[]>
  invoke(channel: 'students:list', args: { projectId: number; classId?: number }): Promise<Student[]>
  invoke(channel: 'photos:list', args: { studentId: number }): Promise<Photo[]>
  invoke(channel: 'captures:list', args: { studentId: number }): Promise<StudentCaptureReview>
  invoke(channel: 'captures:summary', args: { projectId: number }): Promise<CaptureCompletenessSummary>
  invoke(channel: 'captures:updateReview', args: {
    captureId: number
    favorite?: boolean
    rejected?: boolean
    selected?: boolean
  }): Promise<CaptureReview | null>
  invoke(channel: 'photos:getThumbnail', args: { filePath: string }): Promise<string | null>
  invoke(channel: 'photos:reassign', args: { photoId: number; studentId: number }): Promise<void>
  invoke(channel: 'photos:delete', args: { photoId: number }): Promise<void>
  invoke(channel: 'photos:unmatched', args: { projectId: number }): Promise<Photo[]>
  invoke(channel: 'photos:openInSystem', args: { filePath: string }): Promise<void>
  invoke(channel: 'watcher:start', args: { projectId: number }): Promise<void>
  invoke(channel: 'watcher:stop', args: { projectId: number }): Promise<void>
  invoke(channel: 'watcher:isRunning', args: { projectId: number }): Promise<boolean>
  invoke(channel: 'watcher:getActiveStudent', args: { projectId: number }): Promise<number | null>
  invoke(channel: 'watcher:setActiveStudent', args: { projectId: number; studentId: number | null }): Promise<number | null>
  invoke(channel: 'dialog:openFile', args?: { filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null>
  invoke(channel: 'dialog:openFolder'): Promise<string | null>
  invoke(channel: 'app:openFile', args: { filePath: string }): Promise<void>
  invoke(channel: 'app:getPhotosDir'): Promise<string>
  invoke(channel: 'app:getSpoolDir'): Promise<string>
  invoke(channel: 'app:getVersion'): Promise<string>
  invoke(channel: 'app:setPhotosDir', args: { dir: string }): Promise<string>
  // Cloud upload
  invoke(channel: 'upload:testConnection'): Promise<UploadResult>
  invoke(channel: 'auth:getSession'): Promise<AuthSession>
  invoke(channel: 'auth:refresh'): Promise<AuthSession>
  invoke(channel: 'auth:signIn'): Promise<AuthSession>
  invoke(channel: 'auth:signOut'): Promise<{ ok: boolean }>
  invoke(channel: 'upload:retry', args: { photoId: number }): Promise<UploadResult>
  invoke(channel: 'upload:retryFile', args: { fileId: number }): Promise<UploadResult>
  invoke(channel: 'upload:getProjectStatus', args: { projectId: number }): Promise<ProjectUploadStatusRow[]>
  invoke(channel: 'upload:getGlobalErrorCount'): Promise<number>
  invoke(channel: 'project:uploadAndFinish', args: { projectId: number }): Promise<import('../shared/types').ProjectSyncResult>
  invoke(channel: 'captures:export', args: {
    projectId: number
    destinationDir: string
    mode: CaptureExportMode
  }): Promise<CaptureExportResult>
  // Desktop updates
  invoke(channel: 'update:getState'): Promise<UpdateState>
  invoke(channel: 'update:check'): Promise<UpdateState>
  invoke(channel: 'update:install'): Promise<UpdateState>
  // Cloud project sync
  invoke(channel: 'cloud:listProjects'): Promise<CloudProjectListResult>
  invoke(channel: 'cloud:pullProject', args: { cloudProjectId: number }): Promise<CloudProjectPullResult>
  invoke(channel: 'imagePipeline:rendererStage', args: import('../shared/types').ImagePipelineRendererStage): Promise<{ ok: boolean }>
  on(channel: 'photo:matched', listener: (data: PhotoMatchedEvent) => void): () => void
  on(channel: 'photo:marker', listener: (data: PhotoMarkerEvent) => void): () => void
  on(channel: 'photo:unmatched', listener: (data: PhotoUnmatchedEvent) => void): () => void
  on(channel: 'photo:deleted', listener: (data: PhotoDeletedEvent) => void): () => void
  on(channel: 'photo:reassigned', listener: (data: PhotoReassignedEvent) => void): () => void
  on(channel: 'upload:statusChanged', listener: (data: UploadStatusChangedEvent) => void): () => void
  on(channel: 'update:status', listener: (data: UpdateState) => void): () => void
  on(channel: 'auth:retired', listener: (session: AuthSession) => void): () => void
  on(channel: 'auth:sessionInvalidated', listener: (session: AuthSession) => void): () => void
  on(channel: 'capture:updated', listener: (event: CaptureUpdatedEvent) => void): () => void
  on(channel: 'watcher:activeStudentChanged', listener: (event: ActiveCaptureTargetEvent) => void): () => void
  on(channel: 'capture:fileUploadStatusChanged', listener: (event: CaptureFileUploadStatusChangedEvent) => void): () => void
  on(channel: 'project:syncProgress', listener: (event: ProjectSyncProgressEvent) => void): () => void
}

declare global {
  interface Window {
    api: ElectronAPI
  }
}
