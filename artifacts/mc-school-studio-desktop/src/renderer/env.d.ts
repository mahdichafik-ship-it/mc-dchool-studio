/// <reference types="vite/client" />

import type {
  Project,
  Class,
  Student,
  Photo,
  PhotoMatchedEvent,
  PhotoUnmatchedEvent,
  PhotoDeletedEvent,
  PhotoReassignedEvent,
  ImportResult,
  UploadStatus,
  UploadStatusChangedEvent,
} from '../shared/types'

interface UploadConfig {
  apiUrl: string | null
  uploadKey: string | null
}

interface UploadResult {
  ok: boolean
  error?: string
}

interface ProjectUploadStatusRow {
  id: number
  studentId: number | null
  uploadStatus: UploadStatus
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
  invoke(channel: 'photos:getThumbnail', args: { filePath: string }): Promise<string | null>
  invoke(channel: 'photos:reassign', args: { photoId: number; studentId: number }): Promise<void>
  invoke(channel: 'photos:delete', args: { photoId: number }): Promise<void>
  invoke(channel: 'photos:unmatched', args: { projectId: number }): Promise<Photo[]>
  invoke(channel: 'photos:openInSystem', args: { filePath: string }): Promise<void>
  invoke(channel: 'watcher:start', args: { projectId: number }): Promise<void>
  invoke(channel: 'watcher:stop', args: { projectId: number }): Promise<void>
  invoke(channel: 'watcher:isRunning', args: { projectId: number }): Promise<boolean>
  invoke(channel: 'dialog:openFile', args?: { filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null>
  invoke(channel: 'dialog:openFolder'): Promise<string | null>
  invoke(channel: 'app:openFile', args: { filePath: string }): Promise<void>
  invoke(channel: 'app:getPhotosDir'): Promise<string>
  invoke(channel: 'app:setPhotosDir', args: { dir: string }): Promise<string>
  // Cloud upload
  invoke(channel: 'upload:getConfig'): Promise<UploadConfig>
  invoke(channel: 'upload:setConfig', args: { apiUrl: string; uploadKey: string }): Promise<UploadResult>
  invoke(channel: 'upload:testConnection'): Promise<UploadResult>
  invoke(channel: 'upload:retry', args: { photoId: number }): Promise<UploadResult>
  invoke(channel: 'upload:getProjectStatus', args: { projectId: number }): Promise<ProjectUploadStatusRow[]>
  // Cloud project sync
  invoke(channel: 'cloud:listProjects'): Promise<CloudProjectListResult>
  invoke(channel: 'cloud:pullProject', args: { cloudProjectId: number }): Promise<CloudProjectPullResult>
  on(channel: 'photo:matched', listener: (data: PhotoMatchedEvent) => void): () => void
  on(channel: 'photo:unmatched', listener: (data: PhotoUnmatchedEvent) => void): () => void
  on(channel: 'photo:deleted', listener: (data: PhotoDeletedEvent) => void): () => void
  on(channel: 'photo:reassigned', listener: (data: PhotoReassignedEvent) => void): () => void
  on(channel: 'upload:statusChanged', listener: (data: UploadStatusChangedEvent) => void): () => void
}

declare global {
  interface Window {
    api: ElectronAPI
  }
}
