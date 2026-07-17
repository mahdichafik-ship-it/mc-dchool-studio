import { useState, useEffect, useCallback } from 'react'
import type { Project, Class, Student, Photo, ImportResult, PhotoMatchedEvent, PhotoUnmatchedEvent } from '../../../shared/types'

// Re-export types for convenience
export type { Project, Class, Student, Photo, ImportResult, PhotoMatchedEvent, PhotoUnmatchedEvent }

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

  // Re-fetch the full student list whenever a photo is matched in this project,
  // so photo-count badges in the sidebar stay live without any manual action.
  // Debounced at 300 ms to coalesce rapid-fire events during a burst shoot.
  useEffect(() => {
    if (!projectId) return
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const unsub = api.on('photo:matched', (event: PhotoMatchedEvent) => {
      if (event.student.projectId !== projectId) return
      if (timeoutId) clearTimeout(timeoutId)
      timeoutId = setTimeout(() => { load() }, 300)
    })

    return () => {
      unsub()
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
) {
  useEffect(() => {
    const unsubMatched = onMatched
      ? api.on('photo:matched', onMatched)
      : undefined
    const unsubUnmatched = onUnmatched
      ? api.on('photo:unmatched', onUnmatched)
      : undefined

    return () => {
      unsubMatched?.()
      unsubUnmatched?.()
    }
  }, [onMatched, onUnmatched])
}
