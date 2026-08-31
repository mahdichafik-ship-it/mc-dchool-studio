import { useState, useEffect, useCallback } from 'react'
import type {
  Project,
  Class,
  Student,
  Photo,
  ImportResult,
  CaptureReview,
  StudentCaptureReview,
  CaptureCompletenessSummary,
  CaptureUpdatedEvent,
  CaptureFileUploadStatusChangedEvent,
  CaptureExportMode,
  CaptureExportResult,
  PhotoMatchedEvent,
  PhotoMarkerEvent,
  PhotoUnmatchedEvent,
  PhotoDeletedEvent,
  PhotoReassignedEvent,
  UploadStatus,
  UploadStatusChangedEvent,
  ProjectUploadStatusRow,
} from '../../../shared/types'

// Re-export types for convenience
export type {
  Project,
  Class,
  Student,
  Photo,
  ImportResult,
  CaptureReview,
  StudentCaptureReview,
  CaptureCompletenessSummary,
  CaptureUpdatedEvent,
  CaptureFileUploadStatusChangedEvent,
  CaptureExportMode,
  CaptureExportResult,
  PhotoMatchedEvent,
  PhotoMarkerEvent,
  PhotoUnmatchedEvent,
  PhotoDeletedEvent,
  PhotoReassignedEvent,
  UploadStatus,
  UploadStatusChangedEvent,
  ProjectUploadStatusRow,
}

const api = window.api

// Projects
export function useProjects() {
  const [data, setData] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setLoading(true)
      const result = await api.invoke('projects:list')
      setData(result as Project[])
      setError(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  return { data, loading, error, reload: load }
}

export function useProject(projectId: number | null) {
  const [data, setData] = useState<Project | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const result = await api.invoke('projects:get', { projectId })
      setData(result as Project | null)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { load() }, [load])

  // Re-fetch project aggregates (classCount, studentCount, photoCount) whenever
  // a photo is matched, unmatched, deleted, or reassigned so the header stays
  // live during an active shoot. Debounced at 300 ms to coalesce burst events.
  useEffect(() => {
    if (!projectId) return
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const scheduleReload = () => {
      if (timeoutId) clearTimeout(timeoutId)
      timeoutId = setTimeout(() => { load() }, 300)
    }

    const unsubMatched = api.on('photo:matched', (event: PhotoMatchedEvent) => {
      if (event.student.projectId !== projectId) return
      scheduleReload()
    })

    const unsubUnmatched = api.on('photo:unmatched', (event: PhotoUnmatchedEvent) => {
      if (event.projectId === projectId) scheduleReload()
    })

    const unsubDeleted = api.on('photo:deleted', (event: PhotoDeletedEvent) => {
      if (event.projectId !== projectId) return
      scheduleReload()
    })

    const unsubReassigned = api.on('photo:reassigned', (event: PhotoReassignedEvent) => {
      if (event.projectId !== projectId) return
      scheduleReload()
    })

    return () => {
      unsubMatched()
      unsubUnmatched()
      unsubDeleted()
      unsubReassigned()
      if (timeoutId) clearTimeout(timeoutId)
    }
  }, [projectId, load])

  return { data, loading, reload: load }
}

export function useClasses(projectId: number | null) {
  const [data, setData] = useState<Class[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const result = await api.invoke('classes:list', { projectId })
      setData(result as Class[])
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { load() }, [load])
  return { data, loading, reload: load }
}

export function useStudents(projectId: number | null, classId?: number) {
  const [data, setData] = useState<Student[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const result = await api.invoke('students:list', { projectId, classId })
      setData(result as Student[])
    } finally {
      setLoading(false)
    }
  }, [projectId, classId])

  useEffect(() => { load() }, [load])

  // Re-fetch the full student list whenever a photo is matched, deleted, or
  // reassigned in this project, so photo-count badges in the sidebar stay live
  // without any manual action. Debounced at 300 ms to coalesce burst events.
  useEffect(() => {
    if (!projectId) return
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const scheduleReload = () => {
      if (timeoutId) clearTimeout(timeoutId)
      timeoutId = setTimeout(() => { load() }, 300)
    }

    const unsubMatched = api.on('photo:matched', (event: PhotoMatchedEvent) => {
      if (event.student.projectId !== projectId) return
      scheduleReload()
    })

    const unsubDeleted = api.on('photo:deleted', (event: PhotoDeletedEvent) => {
      if (event.projectId !== projectId) return
      scheduleReload()
    })

    const unsubReassigned = api.on('photo:reassigned', (event: PhotoReassignedEvent) => {
      if (event.projectId !== projectId) return
      scheduleReload()
    })

    return () => {
      unsubMatched()
      unsubDeleted()
      unsubReassigned()
      if (timeoutId) clearTimeout(timeoutId)
    }
  }, [projectId, load])

  return { data, loading, reload: load }
}

export function usePhotos(studentId: number | null) {
  const [data, setData] = useState<Photo[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!studentId) return
    setLoading(true)
    try {
      const result = await api.invoke('photos:list', { studentId })
      setData(result as Photo[])
    } finally {
      setLoading(false)
    }
  }, [studentId])

  useEffect(() => { load() }, [load])
  return { data, loading, reload: load }
}

export function useUnmatchedPhotos(projectId: number | null) {
  const [data, setData] = useState<Photo[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const result = await api.invoke('photos:unmatched', { projectId })
      setData(result as Photo[])
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!projectId) return
    const unsubUnmatched = api.on('photo:unmatched', (event: PhotoUnmatchedEvent) => {
      if (event.projectId === projectId) void load()
    })
    const unsubReassigned = api.on('photo:reassigned', (event: PhotoReassignedEvent) => {
      if (event.projectId === projectId) void load()
    })
    const unsubDeleted = api.on('photo:deleted', (event: PhotoDeletedEvent) => {
      if (event.projectId === projectId) void load()
    })
    return () => {
      unsubUnmatched()
      unsubReassigned()
      unsubDeleted()
    }
  }, [projectId, load])

  return { data, loading, reload: load }
}

export function useCaptures(studentId: number | null) {
  const [data, setData] = useState<StudentCaptureReview>({ captures: [], qrMarkers: [] })
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!studentId) return
    setLoading(true)
    try {
      const result = await api.invoke('captures:list', { studentId })
      setData(result as StudentCaptureReview)
    } finally {
      setLoading(false)
    }
  }, [studentId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!studentId) return
    const unsubCapture = api.on('capture:updated', (event: CaptureUpdatedEvent) => {
      if (event.studentId === studentId) void load()
    })
    const unsubMatched = api.on('photo:matched', (event: PhotoMatchedEvent) => {
      if (event.student.id === studentId) void load()
    })
    const unsubMarker = api.on('photo:marker', (event: PhotoMarkerEvent) => {
      if (event.student.id === studentId) void load()
    })
    const unsubFileUpload = api.on('capture:fileUploadStatusChanged', (event: CaptureFileUploadStatusChangedEvent) => {
      if (event.studentId === studentId) void load()
    })
    return () => {
      unsubCapture()
      unsubMatched()
      unsubMarker()
      unsubFileUpload()
    }
  }, [studentId, load])

  return { data, loading, reload: load }
}

export function useCaptureSummary(projectId: number | null) {
  const [data, setData] = useState<CaptureCompletenessSummary>({
    total: 0,
    complete: 0,
    jpegOnly: 0,
    rawOnly: 0,
    unpaired: 0,
  })

  const load = useCallback(async () => {
    if (!projectId) return
    const result = await api.invoke('captures:summary', { projectId })
    setData(result as CaptureCompletenessSummary)
  }, [projectId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!projectId) return
    const refresh = (event: CaptureUpdatedEvent) => {
      if (event.projectId === projectId) void load()
    }
    const unsubCapture = api.on('capture:updated', refresh)
    const unsubMatched = api.on('photo:matched', (event: PhotoMatchedEvent) => {
      if (event.student.projectId === projectId) void load()
    })
    const unsubUnmatched = api.on('photo:unmatched', (event: PhotoUnmatchedEvent) => {
      if (event.projectId === projectId) void load()
    })
    return () => {
      unsubCapture()
      unsubMatched()
      unsubUnmatched()
    }
  }, [projectId, load])

  return { data, reload: load }
}

export function useWatcherStatus(projectId: number | null) {
  const [isRunning, setIsRunning] = useState(false)

  const check = useCallback(async () => {
    if (!projectId) return
    const result = await api.invoke('watcher:isRunning', { projectId })
    setIsRunning(result as boolean)
  }, [projectId])

  useEffect(() => { check() }, [check])

  const start = useCallback(async () => {
    if (!projectId) return
    await api.invoke('watcher:start', { projectId })
    setIsRunning(true)
  }, [projectId])

  const stop = useCallback(async () => {
    if (!projectId) return
    await api.invoke('watcher:stop', { projectId })
    setIsRunning(false)
  }, [projectId])

  return { isRunning, start, stop, refresh: check }
}

// Toast notifications for photo events
export function usePhotoEvents(
  onMatched?: (data: PhotoMatchedEvent) => void,
  onUnmatched?: (data: PhotoUnmatchedEvent) => void,
  onMarker?: (data: PhotoMarkerEvent) => void,
) {
  useEffect(() => {
    const unsubMatched = onMatched
      ? api.on('photo:matched', onMatched)
      : undefined
    const unsubMarker = onMarker
      ? api.on('photo:marker', onMarker)
      : undefined
    const unsubUnmatched = onUnmatched
      ? api.on('photo:unmatched', onUnmatched)
      : undefined

    return () => {
      unsubMatched?.()
      unsubMarker?.()
      unsubUnmatched?.()
    }
  }, [onMatched, onUnmatched, onMarker])
}

// Upload status per student: Map<studentId, { pending, uploading, done, error } counts>
export interface StudentUploadSummary {
  pending: number
  uploading: number
  done: number
  error: number
  total: number
}

export function useUploadStatus(projectId: number | null) {
  // Map from studentId → counts
  const [statusMap, setStatusMap] = useState<Map<number, StudentUploadSummary>>(new Map())
  // Map from photoId → status and server URL for the detail panel
  const [photoStatusMap, setPhotoStatusMap] = useState<Map<number, ProjectUploadStatusRow>>(new Map())
  // Photo IDs with error status in this project
  const [errorPhotoIds, setErrorPhotoIds] = useState<number[]>([])

  const load = useCallback(async () => {
    if (!projectId) return
    const rows = await api.invoke('upload:getProjectStatus', { projectId }) as ProjectUploadStatusRow[]

    const map = new Map<number, StudentUploadSummary>()
    const photoMap = new Map<number, ProjectUploadStatusRow>()
    const errIds: number[] = []
    for (const row of rows) {
      photoMap.set(row.id, row)
      if (!row.studentId) continue
      const existing = map.get(row.studentId) ?? { pending: 0, uploading: 0, done: 0, error: 0, total: 0 }
      existing.total++
      if (row.uploadStatus === 'pending') existing.pending++
      else if (row.uploadStatus === 'uploading') existing.uploading++
      else if (row.uploadStatus === 'done') existing.done++
      else if (row.uploadStatus === 'error') { existing.error++; errIds.push(row.id) }
      map.set(row.studentId, existing)
    }
    setStatusMap(map)
    setPhotoStatusMap(photoMap)
    setErrorPhotoIds(errIds)
  }, [projectId])

  useEffect(() => {
    load()
  }, [load])

  // Refresh whenever any upload status changes
  useEffect(() => {
    if (!projectId) return
    const unsub = api.on('upload:statusChanged', (_event: UploadStatusChangedEvent) => {
      load()
    })
    return unsub
  }, [projectId, load])

  return { statusMap, photoStatusMap, errorPhotoIds, reload: load }
}

// Total failed upload count across all projects (for Settings screen)
export function useGlobalErrorCount() {
  const [count, setCount] = useState(0)

  const load = useCallback(async () => {
    const result = await api.invoke('upload:getGlobalErrorCount') as number
    setCount(result)
  }, [])

  useEffect(() => { load() }, [load])

  // Refresh whenever any upload status changes
  useEffect(() => {
    const unsub = api.on('upload:statusChanged', (_event: UploadStatusChangedEvent) => {
      load()
    })
    return unsub
  }, [load])

  return { count, reload: load }
}
