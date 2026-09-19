import React, { useState, useEffect, useRef } from 'react'
import {
  ArrowLeft, Folder, Play, Square, Search, Image, User,
  ChevronRight, ArrowRight, Camera, AlertCircle, ExternalLink, Download,
  Upload, CloudUpload, CheckCircle, XCircle, Loader,
  RefreshCw, Star, Check, Plus, Pencil, Trash2, QrCode, RotateCw, Maximize2, FolderSync
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  useProject,
  useStudents,
  useGroups,
  useGroupCaptures,
  useCaptures,
  useCaptureSummary,
  useUnmatchedPhotos,
  useWatcherStatus,
  useActiveCaptureTarget,
  useUploadStatus,
  useLiveUpload,
} from '@/hooks/useApi'
import { addToast } from '@/components/ui/toast'
import {
  decodeResizedPreview,
  previewScheduler,
  waitForPaintFrames,
} from '@/lib/previewScheduler'
import { CaptureFramingPreview } from '@/lib/CaptureFramingPreview'
import {
  capturePreviewViewportStyle,
  getCaptureCropGeometry,
} from '@/lib/captureFraming'
import { captureUploadLabel } from '@/lib/shootWorkspace'
import { getEmployeeCaptureContext } from '@/lib/employeeCaptureContext'
import {
  isRosterShortcutEditingTarget,
  resolveRosterShortcut,
} from '@/lib/rosterShortcuts'
import { filterRosterStudents } from '@/lib/rosterFilter'
import { createGroupMemberStudentIdSet } from '@/lib/groupMembership'
import type {
  Student,
  Class,
  Photo,
  CaptureReview,
  StudentUploadSummary,
  ProjectUploadStatusRow,
  UploadStatus,
  CaptureExportMode,
  CaptureExportLayout,
  ProjectSyncProgressEvent,
  CreateStudentResult,
  LiveUploadQueueItem,
  StudentGroup,
  GroupCaptureReview,
} from '@/hooks/useApi'
import type {
  CaptureAspectRatio,
  CaptureFraming,
  DroppedCaptureFileResult,
  DroppedCaptureProgressEvent,
  FolderMigrationPreview,
  MoveStudentResult,
} from '@shared/types'

interface Props {
  projectId: number
  onBack: () => void
  classes: Class[]
  selectedClassId: number | null
  onSelectedClassIdChange: (classId: number | null) => void
  reloadClasses: () => Promise<void>
  offline?: boolean
}

type CaptureFilter = 'all' | CaptureReview['pairingStatus']

const captureFilterOptions: Array<{ value: CaptureFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'complete', label: 'JPEG + RAW' },
  { value: 'jpeg_only', label: 'JPEG only' },
  { value: 'raw_only', label: 'RAW only' },
  { value: 'unpaired', label: 'Needs review' },
]

interface DropProgressState {
  studentId: number
  completed: number
  total: number
  results: DroppedCaptureFileResult[]
}

export function ProjectView({
  projectId,
  onBack,
  classes,
  selectedClassId,
  onSelectedClassIdChange,
  reloadClasses,
  offline = false,
}: Props) {
  const { data: project, reload: reloadProject } = useProject(projectId)
  const projectSynced = project?.syncStatus === 'synced'
  const isCorporate = project?.projectType === 'corporate'
  const departmentLabel = isCorporate ? 'Department' : 'Class'
  const employeeLabel = isCorporate ? 'Employee' : 'Student'
  const employeePlural = `${employeeLabel}s`
  const { data: captureSummary } = useCaptureSummary(projectId)
  const [groupCaptureCount, setGroupCaptureCount] = useState(0)
  const { data: students, reload: reloadStudents } = useStudents(projectId, selectedClassId ?? undefined)
  const { data: allProjectStudents, reload: reloadAllProjectStudents } = useStudents(projectId)
  const { data: groups, reload: reloadGroups } = useGroups(projectId, selectedClassId ?? undefined)
  const [selectedGroup, setSelectedGroup] = useState<StudentGroup | null>(null)
  const { data: groupCaptures, reload: reloadGroupCaptures } = useGroupCaptures(projectId, selectedGroup?.id ?? null)
  const {
    data: unmatchedPhotos,
    loading: unmatchedLoading,
    reload: reloadUnmatchedPhotos,
  } = useUnmatchedPhotos(projectId)
  const [selectedStudent, setSelectedStudent] = useState<Student | null>(null)
  const { isRunning, start: startWatcher, stop: stopWatcher } = useWatcherStatus(projectId)
  const {
    studentId: activeStudentId,
    groupId: activeGroupId,
    source: activeStudentSource,
    setTarget: setActiveCaptureTarget,
    setGroupTarget: setActiveGroupTarget,
  } = useActiveCaptureTarget(projectId)
  const { statusMap: uploadStatusMap, photoStatusMap, errorPhotoIds, reload: reloadUploadStatus } = useUploadStatus(projectId)
  const {
    state: liveUpload,
    load: reloadLiveUpload,
    setEnabled: setLiveUploadEnabled,
    runNow: runUploadNow,
    retryFailed: retryProjectFailed,
  } = useLiveUpload(projectId)
  const [search, setSearch] = useState('')
  const filteredStudents = filterRosterStudents(students, search)
  const selectedClass = classes.find((projectClass) => projectClass.id === selectedClassId)
  const defaultClassGroup = selectedClassId === null
    ? null
    : groups.find((group) => group.isDefaultClassGroup) ?? null
  const captureTargetGroups = groups.filter(
    (group) => !group.isDefaultClassGroup || group.id === defaultClassGroup?.id,
  )
  const [addStudentOpen, setAddStudentOpen] = useState(false)
  const [moveStudentOpen, setMoveStudentOpen] = useState(false)
  const [reassignDialogPhoto, setReassignDialogPhoto] = useState<Photo | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [exportMode, setExportMode] = useState<CaptureExportMode>('all')
  const [exporting, setExporting] = useState<CaptureExportLayout | null>(null)
  const [pixiesetExporting, setPixiesetExporting] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [renamingGroupId, setRenamingGroupId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [syncProgress, setSyncProgress] = useState<ProjectSyncProgressEvent | null>(null)
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false)
  const [uploadQueue, setUploadQueue] = useState<LiveUploadQueueItem[]>([])
  const [deletingQueueItem, setDeletingQueueItem] = useState<string | null>(null)
  const [finishDialogOpen, setFinishDialogOpen] = useState(false)
  const [folderMigrationRunning, setFolderMigrationRunning] = useState(false)
  const [photographerComment, setPhotographerComment] = useState('')
  const [uploadActionRunning, setUploadActionRunning] = useState(false)
  const [reviewSummary, setReviewSummary] = useState<{
    unratedPortraits: number
    unratedGroups: number
  }>({ unratedPortraits: 0, unratedGroups: 0 })
  const [dropProgress, setDropProgress] = useState<DropProgressState | null>(null)
  const [draggedStudentId, setDraggedStudentId] = useState<number | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const autoStartAttemptedRef = useRef<number | null>(null)

  useEffect(() => {
    if (!project) return
    void reloadGroups()
  }, [project?.id, reloadGroups])

  const actionsRef = useRef({
    handleSelectCaptureStudent,
    handleClearCaptureStudent,
    setActiveGroupTarget,
    setSelectedGroup
  })
  actionsRef.current = {
    handleSelectCaptureStudent,
    handleClearCaptureStudent,
    setActiveGroupTarget,
    setSelectedGroup
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (isRosterShortcutEditingTarget(target)) {
        if (e.key === 'Escape' && target === searchInputRef.current) {
          setSearch('')
          target.blur()
        }
        return
      }

      const anyDialogOpen =
        addStudentOpen ||
        uploadDialogOpen ||
        finishDialogOpen ||
        reassignDialogPhoto !== null ||
        renamingGroupId !== null ||
        document.querySelector('[role="dialog"], [aria-modal="true"]') !== null

      const action = resolveRosterShortcut({
        key: e.key,
        students: filteredStudents,
        selectedStudentId: selectedStudent?.id ?? null,
        activeStudentId,
        hasSearch: search.length > 0,
        hasActiveTarget:
          activeStudentId !== null ||
          selectedStudent !== null ||
          activeGroupId !== null ||
          selectedGroup !== null,
        blocked: anyDialogOpen || Boolean(project?.finishedAt),
      })

      if (action.type === 'focus-search') {
        e.preventDefault()
        searchInputRef.current?.focus()
        return
      }

      if (action.type === 'clear-search') {
        setSearch('')
        return
      }

      if (action.type === 'clear-target') {
        void actionsRef.current.handleClearCaptureStudent()
        setSelectedStudent(null)
        actionsRef.current.setSelectedGroup(null)
        void actionsRef.current.setActiveGroupTarget(null)
        return
      }

      if (action.type === 'select-student') {
        e.preventDefault()
        void actionsRef.current.handleSelectCaptureStudent(action.student)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    addStudentOpen,
    uploadDialogOpen,
    finishDialogOpen,
    reassignDialogPhoto,
    renamingGroupId,
    project?.finishedAt,
    search,
    activeStudentId,
    selectedStudent,
    selectedGroup,
    activeGroupId,
    filteredStudents,
  ])

  useEffect(() => {
    if (selectedStudent) {
      const el = document.querySelector(`[data-student-row="${selectedStudent.id}"]`)
      if (el) {
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
    }
  }, [selectedStudent])

  const pendingUploadCount = liveUpload
    ? liveUpload.pending + liveUpload.uploading
    : [...uploadStatusMap.values()].reduce(
      (count, summary) => count + summary.pending + summary.uploading,
      0,
    )

  useEffect(() => {
    void window.api.invoke('groupCaptures:summary', { projectId }).then(setGroupCaptureCount)
  }, [projectId, groupCaptures])

  useEffect(() => {
    if (!uploadDialogOpen) return
    void window.api.invoke('upload:getQueue', { projectId })
      .then((items) => setUploadQueue(items as LiveUploadQueueItem[]))
  }, [
    uploadDialogOpen,
    projectId,
    liveUpload?.pending,
    liveUpload?.uploading,
    liveUpload?.error,
    liveUpload?.blocked,
    liveUpload?.lastUploadedAt,
    liveUpload?.lastError,
  ])

  useEffect(() => {
    return window.api.on('project:syncProgress', (event) => {
      if (event.projectId === projectId) setSyncProgress(event)
    })
  }, [projectId])

  // The lifecycle and file counters are persisted in SQLite, so restore the
  // banner/progress after switching projects or restarting the desktop.
  useEffect(() => {
    if (!project || project.syncStatus === 'active') {
      setSyncProgress(null)
      return
    }
    setSyncProgress({
      projectId,
      phase: project.syncStatus === 'synced'
        ? 'finished'
        : project.syncStatus === 'finished_local'
          ? 'finished-locally'
          : project.syncStatus === 'syncing' ? 'syncing' : 'error',
      completed: project.syncCompletedFiles,
      total: project.syncTotalFiles,
      failed: project.syncFailedFiles,
      ...(project.syncError ? { error: project.syncError } : {}),
    })
  }, [project, projectId])

  useEffect(() => {
    return window.api.on('watcher:dropProgress', (event: DroppedCaptureProgressEvent) => {
      if (event.projectId !== projectId) return
      setDropProgress((current) => ({
        studentId: event.studentId,
        completed: event.completed,
        total: event.total,
        results: [...(current?.studentId === event.studentId ? current.results : []), event.result],
      }))
    })
  }, [projectId])

  useEffect(() => {
    return () => {
      void stopWatcher()
    }
  }, [stopWatcher])

  useEffect(() => {
    if (
      !project?.watchFolder
      || project.finishedAt
      || isRunning
      || autoStartAttemptedRef.current === projectId
    ) {
      return
    }
    autoStartAttemptedRef.current = projectId
    void startWatcher().catch((error) => {
      addToast({
        type: 'error',
        title: 'Watch folder could not start automatically',
        description: String(error),
      })
    })
  }, [isRunning, project?.finishedAt, project?.watchFolder, projectId, startWatcher])

  useEffect(() => {
    if (selectedStudent) {
      const refreshed = students.find((s) => s.id === selectedStudent.id)
      if (refreshed) {
        setSelectedStudent(refreshed)
      } else {
        setSelectedStudent(null)
      }
    }
  }, [students])

  useEffect(() => {
    if (activeStudentId === null) return
    const activeStudent = students.find((student) => student.id === activeStudentId)
    if (activeStudent) setSelectedStudent(activeStudent)
  }, [activeStudentId, students])

  useEffect(() => {
    if (selectedGroup && !groups.some((group) => group.id === selectedGroup.id)) {
      setSelectedGroup(null)
      if (activeGroupId === selectedGroup.id) void setActiveGroupTarget(null)
    }
  }, [groups, selectedGroup, activeGroupId, setActiveGroupTarget])

  async function handleSelectGroup(group: StudentGroup) {
    setSelectedGroup(group)
    setSelectedStudent(null)
    try {
      await setActiveGroupTarget(group.id)
    } catch (error) {
      addToast({ type: 'error', title: 'Could not select capture group', description: String(error) })
    }
  }

  async function handleCreateGroup() {
    const name = window.prompt('Group name')
    if (!name?.trim()) return
    try {
      const group = await window.api.invoke('groups:create', {
        projectId, classId: selectedClassId, name,
        memberStudentIds: selectedClassId ? students.map((student) => student.id) : [],
      })
      await reloadGroups()
      await handleSelectGroup(group)
    } catch (error) {
      addToast({ type: 'error', title: 'Could not create group', description: String(error) })
    }
  }

  async function handleRenameGroup(group: StudentGroup) {
    const name = renameValue.trim()
    if (!name || name === group.name) {
      setRenamingGroupId(null)
      return
    }
    try {
      const updated = await window.api.invoke('groups:update', {
        projectId, groupId: group.id, name,
      })
      if (selectedGroup?.id === group.id) setSelectedGroup(updated)
      setRenamingGroupId(null)
      await reloadGroups()
    } catch (error) {
      addToast({ type: 'error', title: 'Could not rename group', description: String(error) })
    }
  }

  async function handleDeleteGroup(group: StudentGroup) {
    if (!window.confirm(`Delete the custom group "${group.name}"? Its captured files will be kept.`)) return
    try {
      await window.api.invoke('groups:delete', { projectId, groupId: group.id })
      if (selectedGroup?.id === group.id) {
        setSelectedGroup(null)
        if (activeGroupId === group.id) await setActiveGroupTarget(null)
      }
      await reloadGroups()
    } catch (error) {
      addToast({ type: 'error', title: 'Could not delete group', description: String(error) })
    }
  }

  async function handleGroupMembership(group: StudentGroup, studentId: number, checked: boolean) {
    const memberStudentIds = checked
      ? [...new Set([...group.memberStudentIds, studentId])]
      : group.memberStudentIds.filter((id) => id !== studentId)
    const updated = await window.api.invoke('groups:update', { projectId, groupId: group.id, memberStudentIds })
    setSelectedGroup(updated)
    await reloadGroups()
  }

  async function handleSelectCaptureStudent(student: Student) {
    try {
      await setActiveCaptureTarget(student.id)
      setSelectedStudent(student)
      setSelectedGroup(null)
    } catch (error) {
      addToast({
        type: 'error',
        title: 'Could not select capture student',
        description: String(error),
      })
    }
  }

  async function handleClearCaptureStudent() {
    try {
      await setActiveCaptureTarget(null)
    } catch (error) {
      addToast({
        type: 'error',
        title: 'Could not clear capture student',
        description: String(error),
      })
    }
  }

  async function handleStudentCreated(result: CreateStudentResult) {
    await Promise.all([reloadStudents(), reloadAllProjectStudents(), reloadClasses(), reloadProject()])
    onSelectedClassIdChange(result.student.classId)
    setSelectedStudent(result.student)
    let selectedForCapture = false
    try {
      await setActiveCaptureTarget(result.student.id)
      selectedForCapture = true
    } catch (error) {
      addToast({
        type: 'error',
        title: 'Student added, but not selected for capture',
        description: error instanceof Error ? error.message : String(error),
      })
    }
    addToast({
      type: 'success',
      title: `${result.student.firstName} ${result.student.lastName} added`,
      description: [
        result.student.className,
        result.cloudSynced ? 'synced to cloud' : 'saved locally; cloud sync will retry during Upload & Finish',
        selectedForCapture ? 'selected for capture' : null,
      ].filter(Boolean).join(' · '),
    })
  }

  async function handleStudentMoved(result: MoveStudentResult) {
    await Promise.all([reloadStudents(), reloadAllProjectStudents(), reloadClasses(), reloadProject()])
    setSelectedStudent(null)
    addToast({
      type: 'success',
      title: `${result.student.firstName} ${result.student.lastName} moved`,
      description: result.cloudSynced
        ? `Moved to ${result.student.className} and synced to cloud.`
        : `Moved to ${result.student.className} locally; cloud sync will retry when connected.`,
    })
  }

  async function handleSetWatchFolder() {
    const folder = await window.api.invoke('dialog:openFolder') as string | null
    if (!folder) return
    await window.api.invoke('projects:setWatchFolder', { projectId, folderPath: folder })
    reloadProject()
    addToast({ type: 'success', title: 'Watch folder set', description: folder })
  }

  async function handleConsolidateStudentFolders() {
    if (folderMigrationRunning) return
    setFolderMigrationRunning(true)
    try {
      const preview = await window.api.invoke('projects:previewFolderMigration', { projectId }) as FolderMigrationPreview
      if (preview.legacyFolderCount === 0) {
        addToast({
          type: 'success',
          title: 'Student folders are already consolidated',
          description: 'No legacy ID_LastName_FirstName folders were found.',
        })
        return
      }
      const conflictDetails = preview.students
        .filter((student) => student.conflictFiles.length > 0)
        .map((student) => [
          student.studentName,
          ...student.conflictFiles.map((fileName) => `  • ${fileName}`),
        ].join('\n'))
        .join('\n\n')
      const confirmed = window.confirm([
        `Found ${preview.legacyFolderCount} legacy student folder${preview.legacyFolderCount === 1 ? '' : 's'} containing ${preview.fileCount} file${preview.fileCount === 1 ? '' : 's'}.`,
        preview.conflictCount > 0
          ? [
              `${preview.conflictCount} existing destination file${preview.conflictCount === 1 ? '' : 's'} will remain unchanged. The legacy copies will be added with a -legacy suffix:`,
              conflictDetails,
            ].join('\n\n')
          : 'Photos, RAW files, and QR markers will be copied into the new FirstName_LastName_ID folders.',
        'Original folders will not be deleted. Continue?',
      ].join('\n\n'))
      if (!confirmed) return
      const result = await window.api.invoke('projects:migrateFolderMigration', {
        projectId,
        confirmed: true,
      })
      addToast({
        type: 'success',
        title: 'Student folders consolidated',
        description: `${result.migratedFiles} copied, ${result.skippedFiles} already present. Original folders were preserved.`,
      })
    } catch (error) {
      addToast({
        type: 'error',
        title: 'Could not consolidate student folders',
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setFolderMigrationRunning(false)
    }
  }

  async function handleToggleWatcher() {
    if (!project?.watchFolder) {
      addToast({ type: 'error', title: 'No watch folder', description: 'Set a watch folder first' })
      return
    }
    try {
      if (isRunning) {
        await stopWatcher()
        addToast({ type: 'info', title: 'Watcher stopped' })
      } else {
        await startWatcher()
        addToast({ type: 'success', title: 'Watcher started', description: `Watching: ${project.watchFolder}` })
      }
    } catch (e) {
      addToast({ type: 'error', title: 'Watcher error', description: String(e) })
    }
  }

  async function handleDropForStudent(
    studentId: number,
    event: React.DragEvent<HTMLElement>,
  ) {
    event.preventDefault()
    event.stopPropagation()
    setDraggedStudentId(null)
    if (project?.finishedAt) {
      addToast({
        type: 'error',
        title: 'Project is finished',
        description: 'Finished projects cannot import more captures.',
      })
      return
    }

    const droppedFiles = Array.from(event.dataTransfer.files)
    if (droppedFiles.length === 0) {
      addToast({
        type: 'error',
        title: 'No files dropped',
        description: 'Drop JPEG or RAW files from Finder onto a student.',
      })
      return
    }

    setDropProgress({ studentId, completed: 0, total: droppedFiles.length, results: [] })
    try {
      const result = await window.api.ingestDroppedFiles(projectId, studentId, droppedFiles)
      await reloadStudents()
      if (result.imported > 0) {
        addToast({
          type: result.errors > 0 ? 'error' : 'success',
          title: result.errors > 0 ? 'Drop completed with errors' : 'Photos imported',
          description: [
            `${result.imported} imported`,
            result.duplicates > 0 ? `${result.duplicates} duplicate${result.duplicates === 1 ? '' : 's'} skipped` : null,
            result.skipped > 0 ? `${result.skipped} unsupported skipped` : null,
            result.errors > 0 ? `${result.errors} error${result.errors === 1 ? '' : 's'}` : null,
          ].filter(Boolean).join(' · '),
        })
      } else {
        const hasErrors = result.errors > 0
        addToast({
          type: hasErrors ? 'error' : 'info',
          title: hasErrors ? 'No photos imported' : 'No new photos imported',
          description: [
            result.duplicates > 0 ? `${result.duplicates} duplicate${result.duplicates === 1 ? '' : 's'}` : null,
            result.skipped > 0 ? `${result.skipped} unsupported` : null,
            result.errors > 0 ? `${result.errors} error${result.errors === 1 ? '' : 's'}` : null,
          ].filter(Boolean).join(' · ') || 'The dropped files could not be imported.',
        })
      }
      window.setTimeout(() => setDropProgress(null), 1200)
    } catch (error) {
      setDropProgress(null)
      addToast({
        type: 'error',
        title: 'Photo drop failed',
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function handleRetryFailed() {
    if (errorPhotoIds.length === 0 || retrying) return
    setRetrying(true)
    let successCount = 0
    let failCount = 0
    for (const photoId of errorPhotoIds) {
      try {
        const result = await window.api.invoke('upload:retry', { photoId }) as { ok: boolean; error?: string }
        if (result.ok) successCount++
        else failCount++
      } catch {
        failCount++
      }
    }
    setRetrying(false)
    await reloadUploadStatus()
    if (failCount === 0) {
      addToast({ type: 'success', title: 'Retry complete', description: `${successCount} photo${successCount !== 1 ? 's' : ''} uploaded successfully` })
    } else {
      addToast({ type: 'error', title: 'Retry finished with errors', description: `${successCount} succeeded, ${failCount} still failed` })
    }
  }

  async function handleExportCaptures(layout: CaptureExportLayout = 'capture_folders') {
    const destinationDir = await window.api.invoke('dialog:openFolder') as string | null
    if (!destinationDir) return
    setExporting(layout)
    try {
      const result = await window.api.invoke('captures:export', {
        projectId,
        destinationDir,
        mode: exportMode,
        layout,
      })
      if (!result.ok) {
        addToast({
          type: 'error',
          title: layout === 'lightroom_watch_folder' ? 'Lightroom export failed' : 'Export failed',
          description: result.error,
        })
        return
      }
      const skipped = result.skippedExistingFiles ?? 0
      addToast({
        type: 'success',
        title: layout === 'lightroom_watch_folder'
          ? 'Sent to Lightroom watched folder'
          : 'Capture export complete',
        description: `${result.exportedFileCount ?? 0} file${result.exportedFileCount === 1 ? '' : 's'} from ${result.exportedCaptureCount ?? 0} capture${result.exportedCaptureCount === 1 ? '' : 's'} exported${skipped > 0 ? ` · ${skipped} already there` : ''}`,
      })
    } catch (error) {
      addToast({ type: 'error', title: 'Export failed', description: String(error) })
    } finally {
      setExporting(null)
    }
  }

  async function handlePixiesetExport() {
    const destinationDir = await window.api.invoke('dialog:openFolder') as string | null
    if (!destinationDir) return
    setPixiesetExporting(true)
    try {
      const result = await window.api.invoke('pixieset:export', { projectId, destinationDir })
      if (!result.ok) {
        const readiness = result.preflight
          ? ` ${result.preflight.readyStudents}/${result.preflight.totalStudents} contacts ready.`
          : ''
        addToast({ type: 'error', title: 'Pixieset export not ready', description: `${result.error ?? 'Resolve the listed roster or rating issues first.'}${readiness}` })
        return
      }
      const excluded = result.excluded?.length ?? 0
      const exclusionSummary = result.excluded?.slice(0, 3)
        .map((issue) => `${issue.studentName}: ${issue.reason}`)
        .join(' · ')
      addToast({
        type: 'success',
        title: 'Pixieset export complete',
        description: `${result.collectionsCreated ?? 0} collections · ${(result.portraitPhotosCopied ?? 0) + (result.groupPhotosCopied ?? 0)} rated JPEGs copied${excluded ? ` · ${excluded} excluded. ${exclusionSummary}${excluded > 3 ? ' · See the export report for all issues.' : ''}` : ''}`,
      })
    } catch (error) {
      addToast({ type: 'error', title: 'Pixieset export failed', description: String(error) })
    } finally {
      setPixiesetExporting(false)
    }
  }

  async function handleUploadAndFinish() {
    if (!project || projectSynced || finishing) return
    setFinishing(true)
    setSyncProgress({
      projectId,
      phase: 'syncing',
      completed: 0,
      total: 0,
      failed: 0,
    })
    try {
      const result = await window.api.invoke('project:uploadAndFinish', {
        projectId,
        photographerComment: photographerComment.trim() || undefined,
      })
      await reloadProject()
      await reloadUploadStatus()
      if (result.ok) {
        setFinishDialogOpen(false)
        setUploadDialogOpen(false)
        addToast({
          type: 'success',
          title: 'Project uploaded and finished',
          description: `${result.completed} local file${result.completed === 1 ? '' : 's'} synchronized successfully`,
        })
      } else {
        addToast({
          type: result.localFinished ? 'info' : 'error',
          title: result.localFinished ? 'Project finished locally' : 'Project remains unfinished',
          description: result.error ?? 'Some local files could not be synchronized.',
        })
      }
    } catch (error) {
      addToast({ type: 'error', title: 'Could not finish project', description: String(error) })
    } finally {
      setFinishing(false)
      await reloadLiveUpload()
    }
  }

  async function loadReviewSummary() {
    const summary = await window.api.invoke('captures:reviewSummary', { projectId }) as {
      unratedPortraits: number
      unratedGroups: number
    }
    setReviewSummary(summary)
    return summary
  }

  async function openUploadDialog() {
    try {
      await loadReviewSummary()
      setUploadDialogOpen(true)
    } catch (error) {
      addToast({ type: 'error', title: 'Could not check photo ratings', description: String(error) })
    }
  }

  async function openFinishDialog() {
    try {
      await loadReviewSummary()
      setFinishDialogOpen(true)
    } catch (error) {
      addToast({ type: 'error', title: 'Could not check photo ratings', description: String(error) })
    }
  }

  async function handleToggleLiveUpload() {
    if (!liveUpload || project?.finishedAt) return
    setUploadActionRunning(true)
    try {
      await setLiveUploadEnabled(!liveUpload.enabled)
      addToast({
        type: 'success',
        title: liveUpload.enabled ? 'Live Upload paused' : 'Live Upload enabled',
        description: liveUpload.enabled
          ? 'New captures stay queued locally until you resume or finish.'
          : 'New captures will upload in the background. This does not finish the shoot.',
      })
    } catch (error) {
      addToast({ type: 'error', title: 'Could not change Live Upload', description: String(error) })
    } finally {
      setUploadActionRunning(false)
    }
  }

  async function handleUploadNow(retryFailed = false) {
    setUploadActionRunning(true)
    try {
      if (retryFailed) await retryProjectFailed()
      else await runUploadNow()
      await reloadUploadStatus()
      addToast({
        type: 'success',
        title: retryFailed ? 'Retry started' : 'Upload started',
        description: 'Upload continues in the background. Keep this window open to monitor progress.',
      })
    } catch (error) {
      addToast({ type: 'error', title: 'Upload could not continue', description: String(error) })
    } finally {
      setUploadActionRunning(false)
    }
  }

  const errCount = liveUpload
    ? liveUpload.error
    : errorPhotoIds.length

  const uploadingCount = liveUpload
    ? liveUpload.uploading
    : [...uploadStatusMap.values()].reduce((count, s) => count + s.uploading, 0)

  const blockedCount = liveUpload?.blocked ?? 0

  let LocalIcon = Folder
  let localColor = "text-slate-400"
  let localText = "Waiting for photos"

  if (unmatchedPhotos.length > 0) {
    localColor = "text-rose-400"
    localText = `${captureSummary.total} captures · ${captureSummary.jpegFiles} JPEG · ${captureSummary.rawFiles} RAW`
      + ` · ${captureSummary.incompletePairs} incomplete · ${unmatchedPhotos.length} unmatched`
    LocalIcon = AlertCircle
  } else if (captureSummary.total === 0) {
    localText = !isRunning && !project?.finishedAt
      ? "No captures · watcher paused"
      : "Waiting for photos"
  } else {
    LocalIcon = CheckCircle
    localColor = !isRunning && !project?.finishedAt ? "text-amber-400" : "text-emerald-400"
    localText = `${captureSummary.total} captures · ${captureSummary.jpegFiles} JPEG · ${captureSummary.rawFiles} RAW`
      + (captureSummary.incompletePairs > 0 ? ` · ${captureSummary.incompletePairs} incomplete` : "")
      + (!isRunning && !project?.finishedAt ? " · watcher paused" : "")
  }

  let CloudIcon = CloudUpload
  let cloudColor = "text-slate-400"
  let cloudText = liveUpload ? "No uploads waiting" : "Checking cloud…"
  let showUploadDots = false

  if (errCount > 0) {
    cloudColor = "text-rose-400"
    cloudText = `${errCount} failed${blockedCount > 0 ? ` · ${blockedCount} blocked` : ""}`
    CloudIcon = XCircle
  } else if (blockedCount > 0) {
    cloudColor = "text-amber-400"
    cloudText = `${blockedCount} blocked`
    CloudIcon = AlertCircle
  } else if (liveUpload && !liveUpload.cloudReady) {
    cloudColor = "text-amber-400"
    cloudText = "Cloud unavailable · files stay local"
  } else if (uploadingCount > 0) {
    cloudColor = "text-teal-400"
    cloudText = `${uploadingCount}/3 uploading${(liveUpload?.pending ?? 0) > 0 ? ` · ${liveUpload?.pending} queued` : ""}`
    showUploadDots = true
  } else if ((liveUpload?.pending ?? 0) > 0) {
    cloudColor = liveUpload?.enabled ? "text-blue-400" : "text-amber-400"
    cloudText = `${liveUpload?.pending} queued${liveUpload?.enabled ? "" : " · Live Upload off"}`
  } else if (captureSummary.total === 0) {
    cloudColor = "text-slate-500"
    cloudText = "Ready when captures arrive"
  } else {
    CloudIcon = CheckCircle
    cloudColor = "text-emerald-400"
    cloudText = "Cloud queue clear"
  }

  const activeDots = Math.min(3, uploadingCount)
  const shootHealthLabel = `Shoot health. Local: ${localText}. Cloud: ${cloudText}. Open upload activity.`

  return (
    <div
      className="shoot-workspace flex flex-col h-full font-sans bg-slate-50"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => event.preventDefault()}
    >
      {dropProgress && (
        <div className="fixed bottom-5 left-1/2 z-40 -translate-x-1/2 rounded-xl border border-teal-200 bg-white px-5 py-3 shadow-xl">
          <div className="flex items-center gap-3 text-sm font-bold text-slate-800">
            <Loader className="size-4 animate-spin text-teal-600" />
            Importing photos {Math.min(dropProgress.completed, dropProgress.total)}/{dropProgress.total}
          </div>
          <div className="mt-2 h-1.5 w-64 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-teal-500 transition-all"
              style={{
                width: `${dropProgress.total > 0
                  ? Math.min(100, (dropProgress.completed / dropProgress.total) * 100)
                  : 0}%`,
              }}
            />
          </div>
        </div>
      )}
      {/* Header bar */}
       <header className="shoot-toolbar bg-slate-950 border-b border-slate-900 px-6 py-3 shrink-0 flex flex-wrap items-center justify-between gap-y-3 shadow-sm z-20">
        <div className="flex items-center gap-5 min-w-0">
          <button onClick={onBack} aria-label="Back to projects" className="text-slate-400 hover:text-white transition-colors bg-slate-900 hover:bg-slate-800 p-1.5 rounded-md shrink-0">
            <ArrowLeft className="size-4" />
          </button>
          <div className="min-w-0">
            <h1 className="font-extrabold text-white text-base tracking-tight truncate">
              {project?.schoolName ?? '…'}
            </h1>
            {isCorporate && <div className="text-[10px] font-bold uppercase tracking-widest text-teal-400">Headshot Session</div>}
            <div className="flex items-center gap-2.5 text-[11px] font-medium text-slate-400 mt-0.5 whitespace-nowrap">
              <span>{project?.classCount} {departmentLabel.toLowerCase()}{project?.classCount === 1 ? '' : 's'}</span>
              <span className="w-1 h-1 rounded-full bg-slate-700" />
              <span>{project?.studentCount} {employeePlural.toLowerCase()}</span>
              <span className="w-1 h-1 rounded-full bg-slate-700 sm:hidden" />
              <span className="text-slate-300 sm:hidden">
                {captureSummary.total > 0 ? `${captureSummary.total} captures` : `${project?.photoCount ?? 0} photos`}
              </span>
            </div>
          </div>
        </div>

          <div className="flex w-full flex-wrap items-center justify-end gap-2 lg:w-auto">
           <details className="relative">
             <summary
               className="flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 text-[10px] font-bold uppercase tracking-wider text-slate-300 transition-colors hover:border-slate-600 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-500/60"
               title="Open photographer group-photo controls"
             >
               <User className="size-3.5" />
               Photo groups
               <Badge className="bg-slate-700 px-1.5 py-0 text-[10px] text-slate-300 hover:bg-slate-700">{groups.length}</Badge>
             </summary>
             <div className="absolute right-0 top-10 z-40 w-80 overflow-hidden rounded-lg border border-slate-700 bg-white text-left shadow-2xl">
               <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2.5">
                 <div>
                    <p className="text-xs font-bold text-slate-900">Manage groups</p>
                    <p className="text-[10px] text-slate-500">Create, rename, or delete custom groups.</p>
                 </div>
                 {!project?.finishedAt && (
                   <button type="button" onClick={() => void handleCreateGroup()} className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-teal-600 hover:text-teal-700">
                     <Plus className="size-3" /> New
                   </button>
                 )}
               </div>
               <div className="max-h-72 overflow-y-auto py-1">
                 {groups.map((group) => (
                   <div key={group.id} className={cn("border-b border-slate-100 last:border-0", selectedGroup?.id === group.id ? "bg-teal-50/60" : "bg-white")}>
                     {renamingGroupId === group.id ? (
                       <div className="px-3 py-2">
                         <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void handleRenameGroup(group) }}>
                           <input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} className="h-7 min-w-0 flex-1 rounded border border-slate-300 px-2 text-xs font-medium focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500" />
                           <Button type="submit" size="sm" className="h-7 px-2 bg-teal-600 text-[10px] font-bold uppercase tracking-wider text-white hover:bg-teal-700">Save</Button>
                         </form>
                       </div>
                     ) : (
                        <div className="flex items-center px-3 py-2 transition-colors border-l-4 border-transparent hover:bg-slate-50">
                          <div className="mr-2 flex min-w-0 flex-1 items-center justify-between gap-2 text-left">
                            <span className="truncate text-xs font-bold text-slate-800">{group.name}</span>
                           <Badge className="bg-slate-200 px-1.5 py-0 text-[10px] font-bold text-slate-700 shadow-none hover:bg-slate-200">{group.memberStudentIds.length}</Badge>
                          </div>
                         {!group.isDefaultClassGroup && !project?.finishedAt && (
                           <div className="flex items-center gap-1">
                             <button type="button" onClick={() => { setRenamingGroupId(group.id); setRenameValue(group.name) }} className="p-1 text-slate-400 hover:text-teal-600" title="Rename group">
                               <Pencil className="size-3.5" />
                             </button>
                             <button type="button" onClick={() => void handleDeleteGroup(group)} className="p-1 text-slate-400 hover:text-red-600" title="Delete group">
                               <Trash2 className="size-3.5" />
                             </button>
                           </div>
                         )}
                       </div>
                     )}
                   </div>
                 ))}
                 {groups.length === 0 && <p className="px-3 py-4 text-center text-xs text-slate-500">No group photos yet.</p>}
               </div>
             </div>
           </details>
           <Button
             size="sm"
             onClick={() => void openFinishDialog()}
             data-testid="shoot-primary-action"
             disabled={finishing || projectSynced || (captureSummary.total === 0 && groupCaptureCount === 0)}
             className={cn(
               "h-8 px-4 text-[10px] font-bold uppercase tracking-wider transition-colors shrink-0",
               projectSynced ? "bg-slate-800 text-slate-400 hover:bg-slate-800" : "bg-blue-600 text-white hover:bg-blue-500 shadow-md"
             )}
           >
             {finishing ? (
               <Loader className="size-3.5 mr-1.5 animate-spin" />
             ) : projectSynced ? (
               <CheckCircle className="size-3.5 mr-1.5" />
             ) : (
               <CloudUpload className="size-3.5 mr-1.5" />
             )}
             {finishing
               ? (syncProgress && syncProgress.total > 0 ? `Uploading ${syncProgress.completed}/${syncProgress.total}` : 'Preparing…')
               : projectSynced
                 ? 'Finished'
                 : project?.syncStatus === 'finished_local' || project?.syncStatus === 'sync_failed'
                   ? 'Retry Upload & Finish'
                   : 'Finish My Shoot'}
           </Button>
         </div>
      </header>
      {project && project.syncStatus !== 'active' && (
        <div className={cn(
          "flex items-center justify-between gap-4 border-b px-6 py-2.5 text-xs",
          projectSynced
            ? "border-emerald-200 bg-emerald-50 text-emerald-800"
            : project.syncStatus === 'finished_local'
              ? "border-amber-200 bg-amber-50 text-amber-900"
              : project.syncStatus === 'syncing'
                ? "border-blue-200 bg-blue-50 text-blue-900"
                : "border-red-200 bg-red-50 text-red-900",
        )}>
          <span className="font-semibold">
            {projectSynced
              ? 'Fully synced to Volume Capture.'
              : project.syncStatus === 'finished_local'
                ? 'Finished locally. Cloud sync is waiting for a connection.'
                : project.syncStatus === 'syncing'
                  ? 'Cloud sync in progress.'
                  : 'Cloud sync needs recovery. Local captures are safe.'}
          </span>
          {syncProgress && syncProgress.total > 0 && (
            <span className="shrink-0 font-medium">
              {Math.min(syncProgress.completed, syncProgress.total)}/{syncProgress.total} files
              {syncProgress.failed > 0 ? ` · ${syncProgress.failed} failed` : ''}
            </span>
          )}
          {!projectSynced && (
            <button
              type="button"
              onClick={() => void openFinishDialog()}
              className="shrink-0 font-bold underline underline-offset-2 hover:no-underline"
            >
              Retry when connected
            </button>
          )}
        </div>
      )}

      <Dialog
        open={uploadDialogOpen}
        onClose={() => setUploadDialogOpen(false)}
        title="Upload Activity"
        className="max-w-lg"
      >
        <div className="space-y-5">
          <p className="text-sm text-slate-600">
            Uploads can continue while you photograph and while this window is closed.
            They do not finish the shoot.
          </p>
          <div className="grid grid-cols-5 gap-2">
            {[
              ['Uploaded', liveUpload?.done ?? 0, 'text-emerald-700 bg-emerald-50'],
              ['Uploading', liveUpload?.uploading ?? 0, 'text-blue-700 bg-blue-50'],
              ['Queued', liveUpload?.pending ?? 0, 'text-amber-700 bg-amber-50'],
              ['Failed', liveUpload?.error ?? 0, 'text-red-700 bg-red-50'],
              ['Blocked', liveUpload?.blocked ?? 0, 'text-slate-700 bg-slate-100'],
            ].map(([label, value, color]) => (
              <div key={String(label)} className={cn("rounded-lg p-3 text-center", String(color))}>
                <div className="text-xl font-extrabold">{String(value)}</div>
                <div className="text-[10px] font-bold uppercase tracking-wider">{String(label)}</div>
              </div>
            ))}
          </div>
          {(reviewSummary.unratedPortraits > 0 || reviewSummary.unratedGroups > 0) && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
              <div className="flex gap-3">
                <AlertCircle className="size-5 shrink-0 text-amber-600" />
                <div>
                  <p className="font-bold text-amber-900">Review photos before uploading</p>
                  <p className="mt-1 text-sm text-amber-800">
                    {reviewSummary.unratedPortraits > 0
                      ? `${reviewSummary.unratedPortraits} portrait${reviewSummary.unratedPortraits === 1 ? '' : 's'} need a rating or “Do not share”.`
                      : ''}
                    {reviewSummary.unratedPortraits > 0 && reviewSummary.unratedGroups > 0 ? ' ' : ''}
                    {reviewSummary.unratedGroups > 0
                      ? `${reviewSummary.unratedGroups} group photo${reviewSummary.unratedGroups === 1 ? '' : 's'} need a rating.`
                      : ''}
                  </p>
                </div>
              </div>
            </div>
          )}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Files still waiting
              </span>
              <span className="text-xs text-slate-400">
                {liveUpload?.pending ?? uploadQueue.length} uploadable
                {(liveUpload?.blocked ?? 0) > 0 ? ` · ${liveUpload?.blocked} blocked` : ''}
              </span>
            </div>
            <div className="max-h-56 space-y-2 overflow-y-auto rounded-lg border border-slate-200 bg-white p-2">
              {uploadQueue.length === 0 ? (
                <p className="px-2 py-4 text-center text-sm text-slate-500">No files are waiting.</p>
              ) : uploadQueue.map((item) => {
                const waitingForRetry = item.retryAt && new Date(item.retryAt).getTime() > Date.now()
                const statusLabel = item.status === 'preparing_gallery'
                  ? 'Preparing gallery'
                  : item.status === 'blocked'
                    ? 'Waiting for match'
                    : item.status === 'uploading'
                      ? 'Uploading'
                      : item.status === 'failed'
                        ? 'Failed'
                        : waitingForRetry ? 'Retry scheduled' : 'Queued'
                return (
                  <div key={item.key} className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold text-slate-800">{item.fileName}</p>
                        <p className="truncate text-xs text-slate-500">
                          {item.subject} · {item.kind === 'group' ? 'Group' : 'Portrait'} · {item.fileRole}
                        </p>
                      </div>
                      <Badge className={cn(
                        "shrink-0 border-0 text-[10px]",
                        item.status === 'blocked' ? "bg-slate-200 text-slate-700"
                          : item.status === 'failed' ? "bg-red-100 text-red-700"
                          : item.status === 'uploading' ? "bg-blue-100 text-blue-700"
                            : item.status === 'preparing_gallery' ? "bg-violet-100 text-violet-700"
                              : waitingForRetry ? "bg-orange-100 text-orange-700"
                                : "bg-amber-100 text-amber-700",
                      )}>
                        {statusLabel}
                      </Badge>
                    </div>
                    {(item.attempts > 0 || item.lastError || item.blockedReason) && (
                      <div className="mt-1.5 text-xs text-slate-500">
                        {item.attempts > 0 && (
                          <span>{item.attempts} attempt{item.attempts === 1 ? '' : 's'}</span>
                        )}
                        {waitingForRetry && (
                          <span> · retry at {new Date(item.retryAt!).toLocaleTimeString()}</span>
                        )}
                        {item.blockedReason && (
                          <p className="mt-1 break-words text-slate-600">{item.blockedReason}</p>
                        )}
                        {item.lastError && (
                          <p className="mt-1 break-words text-red-600">{item.lastError}</p>
                        )}
                      </div>
                    )}
                    {item.status === 'blocked' && (
                      <Button
                        variant="outline"
                        className="mt-2 text-red-700"
                        disabled={deletingQueueItem !== null}
                        onClick={async () => {
                          setDeletingQueueItem(item.key)
                          try {
                            await window.api.invoke('upload:deleteUnmatched', { projectId, key: item.key })
                            setUploadQueue(await window.api.invoke('upload:getQueue', { projectId }))
                            await reloadLiveUpload()
                          } catch (error) {
                            addToast({ type: 'error', title: 'Could not delete file', description: String(error) })
                          } finally {
                            setDeletingQueueItem(null)
                          }
                        }}
                      >
                        <Trash2 className="mr-1 size-3" />
                        {deletingQueueItem === item.key ? 'Confirming…' : 'Delete from project'}
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-bold text-slate-700">Cloud connection</span>
              <span className={cn("font-bold", liveUpload?.cloudReady ? "text-emerald-600" : "text-amber-600")}>
                {liveUpload?.cloudReady ? 'Connected' : 'Waiting for connection'}
              </span>
            </div>
            {liveUpload?.lastUploadedAt && (
              <div className="mt-2 text-slate-500">
                Last upload {new Date(liveUpload.lastUploadedAt).toLocaleTimeString()}
              </div>
            )}
            {liveUpload?.lastError && (
              <div className="mt-2 text-red-600 break-words">{liveUpload.lastError}</div>
            )}
          </div>
          <div className="flex flex-wrap gap-2 justify-end">
            <Button
              variant="outline"
              disabled={uploadActionRunning || Boolean(project?.finishedAt)}
              onClick={() => void handleToggleLiveUpload()}
            >
              {liveUpload?.enabled ? 'Pause Live Upload' : 'Resume Live Upload'}
            </Button>
            {(liveUpload?.error ?? 0) > 0 && (
              <Button
                variant="outline"
                disabled={uploadActionRunning || !liveUpload?.cloudReady}
                onClick={() => void handleUploadNow(true)}
              >
                Retry Failed
              </Button>
            )}
            <Button
              disabled={
                uploadActionRunning
                || !liveUpload?.cloudReady
                || reviewSummary.unratedPortraits > 0
                || reviewSummary.unratedGroups > 0
              }
              onClick={() => void handleUploadNow()}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              {uploadActionRunning && <Loader className="size-4 mr-2 animate-spin" />}
              Upload Now
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={finishDialogOpen}
        onClose={() => !finishing && setFinishDialogOpen(false)}
        title="Finish My Shoot?"
        className="max-w-lg"
      >
        <div className="space-y-5">
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
            <div className="flex gap-3">
              <AlertCircle className="size-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold text-amber-900">This stops capture intake on this computer.</p>
                <p className="text-sm text-amber-800 mt-1">
                  Volume Capture will drain the watch folder and save local completion first.
                  When connected, it will then upload every remaining file and finish this photographer’s batch.
                  It does not close the studio’s entire project.
                </p>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-slate-50 p-3">
              <div className="text-xl font-extrabold text-slate-900">{liveUpload?.done ?? 0}</div>
              <div className="text-[10px] font-bold uppercase text-slate-500">Uploaded</div>
            </div>
            <div className="rounded-lg bg-amber-50 p-3">
              <div className="text-xl font-extrabold text-amber-700">{(liveUpload?.pending ?? 0) + (liveUpload?.uploading ?? 0)}</div>
              <div className="text-[10px] font-bold uppercase text-amber-700">Remaining</div>
            </div>
            <div className="rounded-lg bg-red-50 p-3">
              <div className="text-xl font-extrabold text-red-700">{liveUpload?.error ?? 0}</div>
              <div className="text-[10px] font-bold uppercase text-red-700">Need retry</div>
            </div>
          </div>
          {(reviewSummary.unratedPortraits > 0 || reviewSummary.unratedGroups > 0) && (
            <div className="rounded-xl border border-red-300 bg-red-50 p-4">
              <div className="flex gap-3">
                <AlertCircle className="size-5 shrink-0 text-red-600" />
                <div>
                  <p className="font-bold text-red-900">Photo review is not complete</p>
                  <p className="mt-1 text-sm text-red-800">
                    Review {reviewSummary.unratedPortraits} portrait{reviewSummary.unratedPortraits === 1 ? '' : 's'}
                    {reviewSummary.unratedGroups > 0
                      ? ` and ${reviewSummary.unratedGroups} group photo${reviewSummary.unratedGroups === 1 ? '' : 's'}`
                      : ''}.
                    Rate photos to share, or choose “Do not share” for portraits that must stay private.
                  </p>
                </div>
              </div>
            </div>
          )}
          {!liveUpload?.cloudReady && (
            <p className="text-sm font-medium text-amber-700">
              You are offline. Finish locally now; reconnect later and use Retry Upload &amp; Finish.
              Your local captures remain safe.
            </p>
          )}
          <div>
            <label htmlFor="photographer-comment" className="text-xs font-extrabold uppercase tracking-wider text-slate-600">
              Photographer comment <span className="font-medium normal-case tracking-normal text-slate-400">(optional)</span>
            </label>
            <textarea
              id="photographer-comment"
              value={photographerComment}
              onChange={(event) => setPhotographerComment(event.target.value)}
              disabled={finishing}
              maxLength={2000}
              rows={3}
              placeholder="Anything the studio should know about this shoot?"
              className="mt-2 w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50"
            />
            <p className="mt-1 text-right text-[10px] text-slate-400">{photographerComment.length}/2000</p>
          </div>
          <div className="flex gap-3 justify-end">
            <Button variant="outline" disabled={finishing} onClick={() => setFinishDialogOpen(false)}>
              Keep Shooting
            </Button>
            <Button
              disabled={
                finishing
                || reviewSummary.unratedPortraits > 0
                || reviewSummary.unratedGroups > 0
              }
              onClick={() => void handleUploadAndFinish()}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              {finishing && <Loader className="size-4 mr-2 animate-spin" />}
              {finishing && syncProgress?.total
                ? `Uploading ${syncProgress.completed}/${syncProgress.total}`
                : !liveUpload?.cloudReady && project?.syncStatus === 'active'
                  ? 'Finish Locally & Sync Later'
                  : 'Upload Remaining & Finish'}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Body: split panel */}
      <div className="shoot-body flex-1 flex overflow-hidden">
        {/* Left panel: classes + students */}
        <div className="shoot-roster-panel w-[340px] max-w-full flex-shrink-0 bg-white border-r border-slate-200 shadow-[4px_0_24px_rgba(0,0,0,0.02)] z-10 flex flex-col">
          <details open className="shrink-0 border-b border-slate-200 bg-slate-50/80">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-[10px] font-extrabold uppercase tracking-widest text-slate-600 hover:bg-slate-100">
              <span>Project actions</span>
              <ChevronRight className="size-4 transition-transform [details[open]>&]:rotate-90" />
            </summary>
            <div className="space-y-2 px-3 pb-3">
              {/* Watch folder control */}
              {project?.watchFolder ? (
                <div data-testid="shoot-watch-status" className={cn(
                  "flex items-center h-9 rounded-md border transition-colors overflow-hidden w-full",
                  isRunning ? "bg-teal-500/10 border-teal-500/20" : "bg-white border-slate-200"
                )}>
                  <div className="flex min-w-0 flex-1 items-center gap-2 px-3">
                    <div className={cn("w-2 h-2 rounded-full shrink-0", isRunning ? "bg-teal-400 animate-pulse shadow-[0_0_8px_rgba(45,212,191,0.6)]" : "bg-slate-400")} />
                    <span className={cn("truncate text-[10px] font-bold uppercase tracking-wider", isRunning ? "text-teal-700" : "text-slate-500")}>
                      {isRunning ? "Live" : "Paused"}
                    </span>
                  </div>
                  <button onClick={handleToggleWatcher} className={cn("px-3 h-full text-[10px] font-bold uppercase tracking-wider transition-colors flex items-center gap-1", isRunning ? "text-teal-700 hover:text-teal-900 hover:bg-teal-500/20" : "text-slate-600 hover:text-slate-900 hover:bg-slate-100")}>
                    {isRunning ? <Square className="size-3 fill-current" /> : <Play className="size-3 fill-current" />}
                    {isRunning ? "Stop" : "Start"}
                  </button>
                  <button onClick={handleSetWatchFolder} aria-label="Change watch folder" className="px-2.5 h-full border-l border-slate-200 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900" title="Change folder">
                    <Folder className="size-3.5" />
                  </button>
                </div>
              ) : (
                <Button size="sm" variant="outline" onClick={handleSetWatchFolder} className="h-9 w-full justify-start bg-white text-slate-700 text-[10px] font-bold uppercase tracking-wider">
                  <Folder className="size-3.5 mr-1.5" /> Set Watch Folder
                </Button>
              )}

              <button
                onClick={() => void handleConsolidateStudentFolders()}
                disabled={folderMigrationRunning}
                className="flex h-9 w-full items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-left text-[10px] font-bold uppercase tracking-wider text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:cursor-wait disabled:opacity-60"
                title="Preview and consolidate legacy student folders"
              >
                <FolderSync className={cn("size-3.5", folderMigrationRunning && "animate-pulse")} />
                {folderMigrationRunning ? 'Checking…' : 'Consolidate folders'}
              </button>

              <button
                onClick={() => void openUploadDialog()}
                aria-label={shootHealthLabel}
                className="hidden xl:flex w-full items-center justify-between gap-3 rounded-md border border-slate-200 bg-white px-3 py-2 text-left transition-all hover:bg-slate-100 hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-teal-500/50 group"
                title={shootHealthLabel}
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium leading-none">
                    <LocalIcon className={cn("size-3.5 shrink-0", localColor)} />
                    <span className="truncate text-slate-700">{localText}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] font-medium leading-none">
                    <CloudIcon className={cn("size-3.5 shrink-0", cloudColor)} />
                    <span className="truncate text-slate-700">{cloudText}</span>
                  </div>
                </div>
                {showUploadDots ? (
                  <div className="flex gap-1 items-center pl-1.5 border-l border-slate-200 h-6">
                    {[0, 1, 2].map(i => (
                      <span
                        key={i}
                        className={cn(
                          "w-1.5 h-1.5 rounded-full transition-all duration-300",
                          i < activeDots ? "bg-teal-400 animate-pulse" : "bg-slate-200"
                        )}
                      />
                    ))}
                  </div>
                ) : (
                  <ChevronRight className="size-3.5 shrink-0 text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                )}
              </button>

              <div className="flex flex-wrap items-center gap-2">
                <div className={cn(
                  "flex min-w-0 flex-1 items-center h-9 rounded-md border overflow-hidden",
                  liveUpload?.enabled ? "bg-blue-50 border-blue-200" : "bg-white border-slate-200",
                )}>
                  <button
                    onClick={() => void handleToggleLiveUpload()}
                    disabled={uploadActionRunning || Boolean(project?.finishedAt)}
                    className={cn(
                      "h-full min-w-0 flex-1 px-3 flex items-center gap-1.5 text-left text-[10px] font-bold uppercase tracking-wider disabled:opacity-50",
                      liveUpload?.enabled ? "text-blue-700 hover:bg-blue-100" : "text-slate-600 hover:bg-slate-100",
                    )}
                    title="Uploads captures in the background without finishing the shoot"
                  >
                    {liveUpload?.running ? <Loader className="size-3 shrink-0 animate-spin" /> : <CloudUpload className="size-3 shrink-0" />}
                    <span className="truncate">Live Upload {liveUpload?.enabled ? 'On' : 'Off'}</span>
                  </button>
                  <button
                    onClick={() => void openUploadDialog()}
                    className="h-full border-l border-slate-200 px-2.5 text-slate-600 hover:bg-slate-100 hover:text-slate-900 text-[10px] font-bold"
                    title="Open upload activity"
                  >
                    {liveUpload?.uploading ? `${liveUpload.uploading} ↑` : liveUpload?.pending ? `${liveUpload.pending} queued` : 'Status'}
                  </button>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void openUploadDialog()}
                  disabled={uploadActionRunning || projectSynced || (captureSummary.total === 0 && groupCaptureCount === 0)}
                  className="h-9 border-blue-200 bg-blue-50 px-3 text-[10px] font-bold uppercase tracking-wider text-blue-700 hover:bg-blue-100 hover:text-blue-900"
                >
                  {liveUpload?.running || uploadActionRunning
                    ? <Loader className="size-3.5 mr-1.5 animate-spin" />
                    : <Upload className="size-3.5 mr-1.5" />}
                  {liveUpload?.uploading
                    ? `Uploading ${liveUpload.uploading}`
                    : pendingUploadCount > 0
                      ? `Upload ${pendingUploadCount}`
                      : 'Upload'}
                </Button>
              </div>

              {(captureSummary.total > 0 || groupCaptureCount > 0) && (
                <div className="flex w-full items-center h-9 rounded-md bg-white border border-slate-200 overflow-hidden">
                  <select
                    aria-label="Export selection"
                    value={exportMode}
                    onChange={(event) => setExportMode(event.target.value as CaptureExportMode)}
                    className="h-full min-w-0 flex-1 bg-transparent px-2 text-[10px] font-bold uppercase tracking-wider text-slate-600 focus:outline-none border-r border-slate-200 cursor-pointer hover:bg-slate-100 transition-colors"
                  >
                    <option value="all">All</option>
                    <option value="paired">Paired</option>
                    <option value="jpeg_only">JPEG Only</option>
                    <option value="raw_only">RAW Only</option>
                    <option value="selected">Selected</option>
                    <option value="favorite">Favorites</option>
                    <option value="final_selection">Final</option>
                  </select>
                  <button onClick={() => void handleExportCaptures('capture_folders')} disabled={exporting !== null} className="px-2.5 h-full text-[10px] font-bold uppercase tracking-wider text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors flex items-center gap-1 disabled:opacity-50">
                    {exporting === 'capture_folders' ? <Loader className="size-3 animate-spin" /> : <Download className="size-3" />}
                    Export
                  </button>
                  <button onClick={() => void handleExportCaptures('lightroom_watch_folder')} disabled={exporting !== null} className="px-2.5 h-full border-l border-slate-200 text-[10px] font-bold uppercase tracking-wider text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors flex items-center gap-1 disabled:opacity-50" title="Send to Lightroom Auto Import">
                    {exporting === 'lightroom_watch_folder' ? <Loader className="size-3 animate-spin" /> : <Image className="size-3" />}
                    Lightroom
                  </button>
                  <button onClick={() => void handlePixiesetExport()} disabled={exporting !== null || pixiesetExporting} className="px-2.5 h-full border-l border-slate-200 text-[10px] font-bold uppercase tracking-wider text-amber-700 hover:text-amber-900 hover:bg-amber-50 transition-colors flex items-center gap-1 disabled:opacity-50" title="Create a separate Pixieset package from rated JPEGs only">
                    {pixiesetExporting ? <Loader className="size-3 animate-spin" /> : <Download className="size-3" />}
                    Pixieset
                  </button>
                </div>
              )}
            </div>
          </details>

          {/* Search */}
          <div className="p-3 border-b border-slate-100 bg-slate-50/50 shrink-0">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-2.5 size-4 text-slate-400" />
                <input
                  ref={searchInputRef}
                  type="text"
                  aria-keyshortcuts="/"
                  title="Press / to search the roster"
                   placeholder={`Search ${employeePlural.toLowerCase()}...`}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 text-sm font-medium border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500 transition-all shadow-sm placeholder:text-slate-400"
                />
              </div>
              <button
                type="button"
                onClick={() => setAddStudentOpen(true)}
                disabled={classes.length === 0 || Boolean(project?.finishedAt)}
                 aria-label={`Add ${employeeLabel.toLowerCase()}`}
                className="size-[38px] bg-slate-900 text-white rounded-lg flex items-center justify-center hover:bg-slate-800 disabled:opacity-50 transition-colors shadow-sm shrink-0"
                 title={project?.finishedAt ? 'This project is finished' : `Add ${employeeLabel.toLowerCase()}`}
              >
                <Plus className="size-4" />
              </button>
               {selectedClassId !== null
                 && !project?.finishedAt
                 && allProjectStudents.some((student) => student.classId !== selectedClassId) && (
                 <button
                   type="button"
                   onClick={() => setMoveStudentOpen(true)}
                   aria-label={`Move ${employeeLabel.toLowerCase()} here`}
                   className="h-[38px] rounded-lg border border-teal-200 bg-teal-50 px-3 text-[10px] font-bold uppercase tracking-wider text-teal-700 transition-colors hover:bg-teal-100"
                   title={`Move an existing ${employeeLabel.toLowerCase()} into this ${departmentLabel.toLowerCase()}`}
                 >
                   <ArrowRight className="mr-1.5 inline size-3.5" />
                   Move here
                 </button>
               )}
            </div>
          </div>

          {/* Retry failed uploads button */}
          {errorPhotoIds.length > 0 && (
            <div className="px-3 py-2 border-b border-red-100 bg-red-50 shrink-0">
              <button
                onClick={handleRetryFailed}
                disabled={retrying}
                className="w-full flex items-center justify-center gap-1.5 text-xs font-bold uppercase tracking-wider text-red-700 bg-red-100 hover:bg-red-200 disabled:opacity-60 rounded-md px-2 py-2 transition-colors"
              >
                {retrying ? (
                  <Loader className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                {retrying
                  ? 'Retrying…'
                  : `Retry ${errorPhotoIds.length} failed upload${errorPhotoIds.length !== 1 ? 's' : ''}`}
              </button>
            </div>
          )}

          <section data-testid="group-photo-roster" className="shrink-0 border-b border-slate-200 bg-white">
            <div className="px-3 pt-3 pb-1.5 text-[10px] font-extrabold uppercase tracking-widest text-slate-400">
              Photo targets
            </div>
            <div className="space-y-1 px-2 pb-2">
              {captureTargetGroups.map((group) => {
                const isActive = selectedGroup?.id === group.id
                const label = group.isDefaultClassGroup
                  ? `${selectedClass?.className ?? group.name} — Class Photo`
                  : group.name
                return (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() => void handleSelectGroup(group)}
                    className={cn(
                      "flex w-full min-w-0 items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
                      isActive
                        ? "border-teal-200 bg-teal-50 text-teal-950"
                        : "border-transparent text-slate-700 hover:border-slate-200 hover:bg-slate-50",
                    )}
                  >
                    <Camera className={cn(
                      "size-3.5 shrink-0",
                      isActive ? "text-teal-600" : "text-slate-400",
                    )} />
                    <span className="min-w-0 flex-1 truncate text-xs font-bold">{label}</span>
                    <Badge className="shrink-0 bg-slate-100 px-1.5 py-0 text-[10px] font-bold text-slate-600 shadow-none hover:bg-slate-100">
                      {group.memberStudentIds.length}
                    </Badge>
                  </button>
                )
              })}
              {captureTargetGroups.length === 0 && (
                <p className="px-2 pb-1 text-center text-xs text-slate-500">No photo targets yet.</p>
              )}
            </div>
          </section>

          {/* People list */}
          <div className="flex-1 overflow-y-auto">
            <div className="py-2">
              <div className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                {employeePlural}
              </div>
              {filteredStudents.map((s) => (
                <StudentRow
                  key={s.id}
                  student={s}
                  isSelected={selectedStudent?.id === s.id}
                  isActive={activeStudentId === s.id}
                  onClick={() => void handleSelectCaptureStudent(s)}
                   isDropActive={draggedStudentId === s.id}
                   onDragEnter={(event) => {
                     event.preventDefault()
                     setDraggedStudentId(s.id)
                   }}
                   onDragLeave={() => setDraggedStudentId((current) => current === s.id ? null : current)}
                   onDrop={(event) => void handleDropForStudent(s.id, event)}
                  uploadSummary={uploadStatusMap.get(s.id)}
                />
              ))}
              {filteredStudents.length === 0 && (
                <div className="p-8 text-center text-slate-400 text-xs font-medium">No {employeePlural.toLowerCase()} found</div>
              )}
            </div>
          </div>

          {/* Shortcut Guidance */}
          {!project?.finishedAt && (
            <div className="p-2 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[10px] text-slate-500 font-medium shrink-0">
              <span className="flex items-center gap-1.5"><kbd className="font-sans font-bold bg-white border border-slate-200 text-slate-700 px-1.5 py-0.5 rounded shadow-sm">/</kbd> Search</span>
              <span className="flex items-center gap-1.5"><kbd className="font-sans font-bold bg-white border border-slate-200 text-slate-700 px-1.5 py-0.5 rounded shadow-sm">↑↓</kbd> Navigate</span>
              <span className="flex items-center gap-1.5"><kbd className="font-sans font-bold bg-white border border-slate-200 text-slate-700 px-1.5 py-0.5 rounded shadow-sm">N</kbd> Next unphotographed</span>
              <span className="flex items-center gap-1.5"><kbd className="font-sans font-bold bg-white border border-slate-200 text-slate-700 px-1.5 py-0.5 rounded shadow-sm">Esc</kbd> Clear</span>
            </div>
          )}
        </div>

        {/* Right panel: QR code + photos */}
        <div className="shoot-content-panel flex-1 flex flex-col min-w-0 bg-slate-50">
          {selectedGroup ? (
            <GroupDetail
              group={selectedGroup}
              students={students}
              groupCaptures={groupCaptures}
              isActiveCaptureTarget={activeGroupId === selectedGroup.id}
              onMembershipChange={handleGroupMembership}
              onClearCaptureTarget={() => void setActiveGroupTarget(null)}
              onRefreshCaptures={() => void reloadGroupCaptures()}
            />
          ) : selectedStudent ? (
            <StudentDetail
              student={selectedStudent}
              isCorporate={isCorporate}
              projectId={projectId}
              photoStatusMap={photoStatusMap}
              onReassign={() => reloadStudents()}
              isActiveCaptureTarget={activeStudentId === selectedStudent.id}
              activeStudentSource={activeStudentSource}
              onClearCaptureTarget={() => void handleClearCaptureStudent()}
              offline={offline}
              employeeLabel={employeeLabel}
               isDropActive={draggedStudentId === selectedStudent.id}
               onDragEnter={(event) => {
                 event.preventDefault()
                 setDraggedStudentId(selectedStudent.id)
               }}
               onDragLeave={() => setDraggedStudentId((current) => current === selectedStudent.id ? null : current)}
               onDrop={(event) => void handleDropForStudent(selectedStudent.id, event)}
            />
          ) : unmatchedPhotos.length > 0 ? (
            <UnmatchedPhotosPanel
              photos={unmatchedPhotos}
              loading={unmatchedLoading}
              onOpen={(filePath) => window.api.invoke('photos:openInSystem', { filePath })}
              onReassign={setReassignDialogPhoto}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full p-12 text-center bg-slate-50">
              <div className="w-24 h-24 bg-white shadow-sm rounded-3xl flex items-center justify-center mb-6 border border-slate-200">
                <User className="size-12 text-slate-300" />
              </div>
              <h3 className="text-2xl font-extrabold text-slate-900 mb-2 tracking-tight">Select a subject</h3>
              <p className="text-slate-500 max-w-md text-base font-medium leading-relaxed">
                Click a student or group in the roster to set them as the active target and display their QR code for the camera.
              </p>
            </div>
          )}
        </div>
      </div>

      {reassignDialogPhoto && (
        <ReassignDialog
          photo={reassignDialogPhoto}
          projectId={projectId}
          onClose={() => setReassignDialogPhoto(null)}
          onDone={() => {
            setReassignDialogPhoto(null)
            void reloadUnmatchedPhotos()
            void reloadStudents()
          }}
        />
      )}
      <MoveStudentDialog
        open={moveStudentOpen}
        projectId={projectId}
        targetClassId={selectedClassId}
        targetClassName={classes.find((cls) => cls.id === selectedClassId)?.className ?? departmentLabel}
        students={allProjectStudents.filter((student) => student.classId !== selectedClassId)}
        employeeLabel={employeeLabel}
        departmentLabel={departmentLabel}
        onClose={() => setMoveStudentOpen(false)}
        onMoved={async (result) => {
          await handleStudentMoved(result)
          setMoveStudentOpen(false)
        }}
      />
      <AddStudentDialog
        open={addStudentOpen}
        projectId={projectId}
        classes={classes}
        initialClassId={selectedClassId}
        onClose={() => setAddStudentOpen(false)}
        onCreated={handleStudentCreated}
        departmentLabel={departmentLabel}
        employeeLabel={employeeLabel}
      />
    </div>
  )
}

function MoveStudentDialog({
  open,
  projectId,
  targetClassId,
  targetClassName,
  students,
  employeeLabel,
  departmentLabel,
  onClose,
  onMoved,
}: {
  open: boolean
  projectId: number
  targetClassId: number | null
  targetClassName: string
  students: Student[]
  employeeLabel: string
  departmentLabel: string
  onClose: () => void
  onMoved: (result: MoveStudentResult) => Promise<void>
}) {
  const [studentId, setStudentId] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setStudentId(String(students[0]?.id ?? ''))
  }, [open, students])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (saving || !targetClassId || !studentId) return
    setSaving(true)
    try {
      const result = await window.api.invoke('students:move', {
        projectId,
        studentId: Number(studentId),
        classId: targetClassId,
      }) as MoveStudentResult
      await onMoved(result)
    } catch (error) {
      addToast({
        type: 'error',
        title: `Could not move ${employeeLabel.toLowerCase()}`,
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={`Move ${employeeLabel} to ${targetClassName}`} className="max-w-md">
      <form className="space-y-5" onSubmit={handleSubmit}>
        <div>
          <label htmlFor="move-student-id" className="mb-2 block text-[11px] font-bold uppercase tracking-wider text-slate-500">
            {employeeLabel}
          </label>
          <select
            id="move-student-id"
            value={studentId}
            onChange={(event) => setStudentId(event.target.value)}
            className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-900 shadow-sm focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
            required
          >
            {students.map((student) => (
              <option key={student.id} value={student.id}>
                {student.lastName}, {student.firstName} · {student.className}
              </option>
            ))}
          </select>
        </div>
        <p className="rounded-lg border border-slate-100 bg-slate-50 p-3 text-xs font-medium leading-relaxed text-slate-500">
          This moves the existing {employeeLabel.toLowerCase()} without creating a duplicate. Their identity and existing photographs stay attached.
          If you are offline, the move will sync when connectivity returns.
        </p>
        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving} className="h-10 px-5 text-xs font-bold uppercase tracking-wider">
            Cancel
          </Button>
          <Button type="submit" disabled={saving || !studentId || !targetClassId} className="h-10 bg-teal-600 px-5 text-xs font-bold uppercase tracking-wider text-white shadow-sm hover:bg-teal-700">
            {saving ? <Loader className="mr-2 size-4 animate-spin" /> : <ArrowRight className="mr-2 size-4" />}
            {saving ? 'Moving…' : `Move to ${departmentLabel.toLowerCase()}`}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function AddStudentDialog({
  open,
  projectId,
  classes,
  initialClassId,
  onClose,
  onCreated,
  departmentLabel,
  employeeLabel,
}: {
  open: boolean
  projectId: number
  classes: Class[]
  initialClassId: number | null
  onClose: () => void
  onCreated: (result: CreateStudentResult) => Promise<void>
  departmentLabel: string
  employeeLabel: string
}) {
  const [classId, setClassId] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setClassId(String(initialClassId ?? classes[0]?.id ?? ''))
    setFirstName('')
    setLastName('')
  }, [classes, initialClassId, open])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    try {
      const result = await window.api.invoke('students:create', {
        projectId,
        classId: Number(classId),
        firstName,
        lastName,
      }) as CreateStudentResult
      await onCreated(result)
      onClose()
    } catch (error) {
      addToast({
        type: 'error',
        title: 'Could not add student',
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={`Add ${employeeLabel} to ${departmentLabel}`} className="max-w-md">
      <form className="space-y-5" onSubmit={handleSubmit}>
        <div>
          <label htmlFor="new-student-class" className="mb-2 block text-[11px] font-bold uppercase tracking-wider text-slate-500">
             {departmentLabel}
          </label>
          <select
            id="new-student-class"
            value={classId}
            onChange={(event) => setClassId(event.target.value)}
            className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500 shadow-sm"
            required
          >
            {classes.map((cls) => (
              <option key={cls.id} value={cls.id}>{cls.className}</option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="new-student-first-name" className="mb-2 block text-[11px] font-bold uppercase tracking-wider text-slate-500">
              First name
            </label>
            <Input
              id="new-student-first-name"
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
              maxLength={100}
              autoFocus
              required
              className="h-10 font-medium"
            />
          </div>
          <div>
            <label htmlFor="new-student-last-name" className="mb-2 block text-[11px] font-bold uppercase tracking-wider text-slate-500">
              Last name
            </label>
            <Input
              id="new-student-last-name"
              value={lastName}
              onChange={(event) => setLastName(event.target.value)}
              maxLength={100}
              required
              className="h-10 font-medium"
            />
          </div>
        </div>
        <p className="text-xs font-medium leading-relaxed text-slate-500 bg-slate-50 p-3 rounded-lg border border-slate-100">
           The {employeeLabel.toLowerCase()} is saved on this Mac immediately and selected as the active capture target.
          If you are offline, Volume Capture will add them to the cloud during Upload & Finish.
        </p>
        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving} className="text-xs font-bold uppercase tracking-wider h-10 px-5">
            Cancel
          </Button>
          <Button type="submit" disabled={saving || !classId || !firstName.trim() || !lastName.trim()} className="bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold uppercase tracking-wider h-10 px-5 shadow-sm">
            {saving ? <Loader className="size-4 mr-2 animate-spin" /> : <Plus className="size-4 mr-2" />}
             {saving ? 'Adding…' : `Add ${employeeLabel.toLowerCase()}`}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function UnmatchedPhotosPanel({
  photos,
  loading,
  onOpen,
  onReassign,
}: {
  photos: Photo[]
  loading: boolean
  onOpen: (filePath: string) => void | Promise<unknown>
  onReassign: (photo: Photo) => void
}) {
  return (
    <div className="flex-1 overflow-y-auto p-8">
      <div className="max-w-[1400px] mx-auto">
        <div className="mb-6 flex items-start gap-4 bg-white p-6 rounded-2xl border border-amber-200 shadow-sm">
          <div className="w-12 h-12 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center shrink-0">
            <AlertCircle className="size-6" />
          </div>
          <div>
            <h2 className="text-xl font-extrabold text-slate-900 tracking-tight">Photos needing assignment</h2>
            <p className="mt-1 text-sm font-medium text-slate-500 leading-relaxed max-w-2xl">
              These captures were saved, but no student QR or filename match was found. Assign them manually or photograph the student QR before the next portraits.
            </p>
          </div>
        </div>
        {loading ? (
          <div className="flex h-64 flex-col items-center justify-center bg-white border border-slate-200 rounded-2xl shadow-sm text-slate-400">
            <Loader className="mb-3 size-6 animate-spin text-amber-500" />
            <span className="text-sm font-bold">Loading captures...</span>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
            {photos.map((photo) => (
              <div key={photo.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm flex flex-col group transition-shadow hover:shadow-md">
                <div className="aspect-square bg-slate-100 relative">
                  {photo.thumbnailData ? (
                    <img
                      src={photo.thumbnailData}
                      alt={photo.fileName}
                      className="h-full w-full object-cover"
                      draggable={false}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center">
                      <Image className="size-8 text-slate-400" />
                    </div>
                  )}
                  <div className="absolute top-2 left-2">
                    <span className="bg-amber-500 text-white text-[9px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded shadow-sm">
                      Unassigned
                    </span>
                  </div>
                </div>
                <div className="space-y-3 p-4 flex-1 flex flex-col justify-between">
                  <p className="truncate text-xs font-mono font-medium text-slate-500" title={photo.fileName}>
                    {photo.fileName}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => void onOpen(photo.filePath)}
                      className="rounded-lg bg-slate-100 px-2 py-2 text-[10px] font-extrabold uppercase tracking-wider text-slate-700 hover:bg-slate-200 transition-colors flex items-center justify-center gap-1"
                    >
                      <ExternalLink className="size-3" /> Open
                    </button>
                    <button
                      type="button"
                      onClick={() => onReassign(photo)}
                      className="rounded-lg bg-teal-600 px-2 py-2 text-[10px] font-extrabold uppercase tracking-wider text-white hover:bg-teal-700 transition-colors flex items-center justify-center gap-1 shadow-sm"
                    >
                      Assign
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function UploadBadge({ summary }: { summary: StudentUploadSummary }) {
  if (summary.uploading > 0) {
    return (
      <span title="Uploading…" className="flex items-center gap-1 text-[10px] font-bold text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">
        <Loader className="size-3 animate-spin" /> {summary.uploading}
      </span>
    )
  }
  if (summary.error > 0) {
    return (
      <span title={`${summary.error} upload(s) failed`} className="flex items-center gap-1 text-[10px] font-bold text-red-600 bg-red-50 px-1.5 py-0.5 rounded">
        <XCircle className="size-3" /> {summary.error}
      </span>
    )
  }
  if (summary.pending > 0) {
    return (
      <span title={`${summary.pending} upload(s) queued`} className="flex items-center gap-1 text-[10px] font-bold text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">
        <Upload className="size-3" /> {summary.pending}
      </span>
    )
  }
  if (summary.done > 0) {
    return (
      <span title={`${summary.done} photo(s) uploaded`} className="flex items-center gap-1 text-[10px] font-bold text-green-600 bg-green-50 px-1.5 py-0.5 rounded">
        <CheckCircle className="size-3" /> {summary.done}
      </span>
    )
  }
  return null
}

function StudentRow({
  student: s,
  isSelected,
  isActive,
  onClick,
  isDropActive,
  onDragEnter,
  onDragLeave,
  onDrop,
  uploadSummary,
}: {
  student: Student
  isSelected: boolean
  isActive: boolean
  onClick: () => void
  isDropActive: boolean
  onDragEnter: (event: React.DragEvent<HTMLButtonElement>) => void
  onDragLeave: () => void
  onDrop: (event: React.DragEvent<HTMLButtonElement>) => void
  uploadSummary?: StudentUploadSummary
}) {
  return (
    <button
      data-student-row={s.id}
      aria-keyshortcuts="ArrowUp ArrowDown N"
      onClick={onClick}
      onDragEnter={onDragEnter}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        "text-left w-full p-3 border-b transition-colors flex items-center gap-3",
        isDropActive
          ? "bg-teal-100 border-l-4 border-l-teal-600 ring-2 ring-inset ring-teal-300"
          : isActive
            ? "bg-teal-50/50 border-l-4 border-l-teal-500"
            : isSelected
              ? "bg-slate-50 border-l-4 border-l-transparent"
              : "hover:bg-slate-50 border-l-4 border-l-transparent border-b-slate-100"
      )}
      aria-pressed={isActive}
      title={isDropActive ? 'Drop photos to import for this student' : isActive ? 'Active capture student' : 'Select as active capture student'}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1">
           <span className={cn("font-bold text-sm truncate", isActive ? "text-teal-950" : "text-slate-900")}>
             {s.lastName}, {s.firstName}
           </span>
           <div className="flex items-center gap-1.5 shrink-0">
             {isActive && (
               <Badge className="bg-teal-600 hover:bg-teal-600 text-white text-[9px] font-extrabold uppercase tracking-widest px-1.5 py-0.5 rounded-sm shadow-sm">
                 <Camera className="size-2.5 mr-1" />
                 Active
               </Badge>
             )}
             {s.photoCount > 0 && !isActive && (
               <Badge className="bg-slate-200 hover:bg-slate-200 text-slate-700 text-[10px] font-bold px-1.5 py-0.5 rounded shadow-none">
                 {s.photoCount}
               </Badge>
             )}
           </div>
        </div>
        <div className="flex items-center justify-between">
           <span className={cn("text-[10px] font-mono font-medium", isActive ? "text-teal-700" : "text-slate-500")}>
             {s.generatedStudentId}
           </span>
           <div className="flex items-center gap-1">
             {uploadSummary && <UploadBadge summary={uploadSummary} />}
           </div>
        </div>
      </div>
    </button>
  )
}

function StudentDetail({
  student,
  isCorporate,
  projectId,
  photoStatusMap,
  onReassign,
  isActiveCaptureTarget,
  activeStudentSource,
  onClearCaptureTarget,
  offline,
  employeeLabel,
  isDropActive,
  onDragEnter,
  onDragLeave,
  onDrop,
}: {
  student: Student
  isCorporate: boolean
  projectId: number
  photoStatusMap: Map<number, ProjectUploadStatusRow>
  onReassign: () => void
  isActiveCaptureTarget: boolean
  activeStudentSource: 'manual' | 'qr' | 'none'
  onClearCaptureTarget: () => void
  offline: boolean
  employeeLabel: string
  isDropActive: boolean
  onDragEnter: (event: React.DragEvent<HTMLDivElement>) => void
  onDragLeave: () => void
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void
}) {
  const employeeContext = getEmployeeCaptureContext(student, isCorporate)
  const {
    data: review,
    loading: capturesLoading,
    error: capturesError,
    reload: reloadCaptures,
    livePreview,
  } = useCaptures(student.id)
  const captures = review.captures
  const qrMarkers = review.qrMarkers
  const [reassignOpen, setReassignOpen] = useState(false)
  const [reassignPhoto, setReassignPhoto] = useState<Photo | null>(null)
  const [retryingPhotoId, setRetryingPhotoId] = useState<number | null>(null)
  const [retryingFileId, setRetryingFileId] = useState<number | null>(null)
  const [pairingFilter, setPairingFilter] = useState<CaptureFilter>('all')
  const [reviewCaptureKey, setReviewCaptureKey] = useState<string | null>(null)
  const [showQrOpen, setShowQrOpen] = useState(false)
  const [framingCapture, setFramingCapture] = useState<CaptureReview | null>(null)
  const [quickLookCapture, setQuickLookCapture] = useState<CaptureReview | null>(null)

  const captureCounts = captures.reduce(
    (counts, capture) => {
      if (capture.pairingStatus === 'pending') counts.unpaired++
      else counts[capture.pairingStatus]++
      return counts
    },
    { complete: 0, jpeg_only: 0, raw_only: 0, unpaired: 0, pending: 0 } as Record<CaptureReview['pairingStatus'], number>,
  )
  const filteredCaptures = pairingFilter === 'all'
    ? captures
    : captures.filter((capture) => pairingFilter === 'unpaired'
      ? capture.pairingStatus === 'unpaired' || capture.pairingStatus === 'pending'
      : capture.pairingStatus === pairingFilter)
  const latestCapture = captures[captures.length - 1] ?? null
  const isFollowingLatest = reviewCaptureKey === null
  const selectedCapture = isFollowingLatest
    ? latestCapture
    : captures.find((capture) => captureReviewKey(capture) === reviewCaptureKey) ?? latestCapture
  const livePreviewMatchesLatest = Boolean(
    isFollowingLatest
    && livePreview?.photo.previewUrl
  )

  useEffect(() => {
    if (reviewCaptureKey !== null && !captures.some((capture) => captureReviewKey(capture) === reviewCaptureKey)) {
      setReviewCaptureKey(null)
    }
  }, [captures, reviewCaptureKey])

  useEffect(() => {
    setReviewCaptureKey(null)
  }, [student.id])

  useEffect(() => {
    const handleReviewShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      const isInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      if (
        isInput ||
        showQrOpen ||
        reassignOpen ||
        framingCapture !== null ||
        quickLookCapture !== null ||
        document.querySelector('[role="dialog"], [aria-modal="true"]')
      ) return
      if (event.key.toLowerCase() === 'l' && latestCapture) {
        event.preventDefault()
        setReviewCaptureKey(null)
        return
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        const currentIndex = isFollowingLatest
          ? captures.length - 1
          : captures.findIndex((capture) => capture.id === selectedCapture?.id)
        if (event.key === 'ArrowLeft' && currentIndex > 0) {
          setReviewCaptureKey(captureReviewKey(captures[currentIndex - 1]))
        } else if (event.key === 'ArrowRight' && currentIndex >= 0 && currentIndex < captures.length - 1) {
          const nextCapture = captures[currentIndex + 1]
          setReviewCaptureKey(nextCapture.id === latestCapture?.id ? null : captureReviewKey(nextCapture))
        }
      }
    }
    window.addEventListener('keydown', handleReviewShortcut)
    return () => window.removeEventListener('keydown', handleReviewShortcut)
  }, [captures, framingCapture, isFollowingLatest, latestCapture, quickLookCapture, reassignOpen, selectedCapture?.id, showQrOpen])

  async function handleDeletePhoto(photoId: number) {
    await window.api.invoke('photos:delete', { photoId })
    reloadCaptures()
    onReassign()
  }

  async function handleOpenPhoto(filePath: string) {
    await window.api.invoke('photos:openInSystem', { filePath })
  }

  async function handleRetryPhoto(photoId: number) {
    if (retryingPhotoId !== null) return
    setRetryingPhotoId(photoId)
    try {
      const result = await window.api.invoke('upload:retry', { photoId }) as { ok: boolean; error?: string }
      if (result.ok) {
        addToast({ type: 'success', title: 'Photo upload retried' })
      } else {
        addToast({
          type: 'error',
          title: offline ? 'Upload still waiting' : 'Photo upload failed',
          description: result.error,
        })
      }
    } catch (error) {
      addToast({ type: 'error', title: 'Photo upload failed', description: String(error) })
    } finally {
      setRetryingPhotoId(null)
      reloadCaptures()
      onReassign()
    }
  }

  async function handleRetryFile(fileId: number) {
    if (retryingFileId !== null) return
    setRetryingFileId(fileId)
    try {
      const result = await window.api.invoke('upload:retryFile', { fileId })
      if (result.ok) {
        addToast({ type: 'success', title: 'Capture file upload retried' })
      } else {
        addToast({
          type: 'error',
          title: offline ? 'Upload still waiting' : 'Capture file upload failed',
          description: result.error,
        })
      }
    } catch (error) {
      addToast({ type: 'error', title: 'Capture file upload failed', description: String(error) })
    } finally {
      setRetryingFileId(null)
      reloadCaptures()
      onReassign()
    }
  }

  async function handleUpdateCaptureReview(
    captureId: number,
    values: {
      favorite?: boolean
      rejected?: boolean
      selected?: boolean
      rating?: number
      colorLabel?: CaptureReview['colorLabel']
    },
  ) {
    try {
      await window.api.invoke('captures:updateReview', { captureId, ...values })
      await reloadCaptures()
    } catch (error) {
      addToast({ type: 'error', title: 'Could not update capture review', description: String(error) })
    }
  }

  async function handleSaveFraming(
    captureId: number,
    framing: Omit<CaptureFraming, 'pending'>,
  ) {
    try {
      await window.api.invoke('captures:updateFraming', { captureId, framing })
      setFramingCapture(null)
      await reloadCaptures()
      addToast({ type: 'success', title: 'Framing saved', description: 'The original capture remains unchanged.' })
    } catch (error) {
      addToast({ type: 'error', title: 'Could not save framing', description: String(error) })
    }
  }

  return (
    <div
      className={cn(
        "flex flex-col h-full relative bg-slate-50 transition-colors",
        isDropActive && "ring-4 ring-inset ring-teal-400 bg-teal-50/30",
      )}
      onDragEnter={onDragEnter}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
       {/* Person info header */}
      <div className="shoot-subject-header bg-white border-b border-slate-200 px-8 py-6 flex flex-wrap gap-4 justify-between items-start shadow-sm z-10 shrink-0 relative">
        {isActiveCaptureTarget && (
          <div className="absolute top-0 left-0 w-full h-1 bg-teal-500" />
        )}
         <div className="flex flex-col min-w-0">
          <div className="flex flex-wrap items-center gap-3 mb-2">
            {isActiveCaptureTarget && (
              <Badge className="bg-teal-500 hover:bg-teal-500 text-white font-extrabold uppercase tracking-widest text-[10px] px-2.5 py-0.5 shadow-sm">
                <Camera className="size-3 mr-1.5" /> Active Target
              </Badge>
            )}
            <span className="text-[11px] font-mono font-medium text-slate-600 bg-slate-100 px-2 py-0.5 rounded-md border border-slate-200 truncate">
              {student.generatedStudentId}
            </span>
            <span className="text-[11px] font-extrabold uppercase tracking-widest text-slate-400 truncate">
              {student.className}
            </span>
            <span className="rounded-md border border-teal-100 bg-teal-50 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-widest text-teal-700">
              Portrait · 5:7
            </span>
          </div>
             <h2 className="shoot-subject-name text-3xl sm:text-4xl font-extrabold text-slate-900 tracking-tight break-words" aria-label={employeeLabel}>
            {student.firstName} {student.lastName}
          </h2>
           {employeeContext.length > 0 && (
             <dl className="mt-3 flex max-w-4xl flex-wrap gap-x-5 gap-y-2 text-sm">
               {employeeContext.map((item) => (
                 <div
                   key={item.label}
                   className={cn(
                     'min-w-0',
                     item.emphasized && 'basis-full rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-950',
                   )}
                 >
                   <dt className="text-[10px] font-extrabold uppercase tracking-widest text-slate-500">
                     {item.label}
                   </dt>
                   <dd className={cn('break-words font-semibold text-slate-800', item.emphasized && 'text-amber-950')}>
                     {item.value}
                   </dd>
                 </div>
               ))}
             </dl>
           )}
        </div>
        <div className="flex flex-col items-end gap-2 justify-center shrink-0">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {isActiveCaptureTarget && (
              <Button variant="outline" size="sm" onClick={onClearCaptureTarget} className="text-[10px] font-bold uppercase tracking-wider h-8 border-slate-300 text-slate-600 hover:bg-slate-100 hover:text-slate-900 shadow-sm">
                <XCircle className="size-3.5 mr-1.5" /> Clear Target
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowQrOpen(true)}
              className="h-8 border-slate-300 bg-white text-[10px] font-extrabold uppercase tracking-wider text-slate-700 shadow-sm hover:bg-slate-50"
            >
              <Camera className="mr-1.5 size-3.5" /> Show QR
            </Button>
          </div>
          <div className="text-[11px] font-bold uppercase tracking-widest text-slate-500">
            {captures.length} Capture{captures.length !== 1 ? 's' : ''} recorded
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="max-w-[1400px] mx-auto flex flex-col gap-5">
          {/* Latest confirmation stage and filmstrip */}
          <div className="shoot-capture-area min-w-0 flex flex-col gap-3">
            <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_164px]">
              <div className="min-w-0">
                {livePreviewMatchesLatest && livePreview ? (
                  <LivePreview
                    photo={livePreview.photo}
                    traceId={livePreview.pipeline?.traceId}
                    framing={latestCapture?.framing ?? defaultCaptureFraming}
                  />
                ) : selectedCapture ? (
                  <CaptureStage capture={selectedCapture} />
                ) : (
                  <div className="flex aspect-[16/7] min-h-[220px] items-center justify-center rounded-2xl border border-slate-200 bg-slate-900 text-center text-sm font-semibold text-slate-400">
                    <div>
                      <Camera className="mx-auto mb-3 size-9 text-slate-600" />
                      <p>Latest JPEG preview will appear here</p>
                      <p className="mt-1 text-xs font-medium text-slate-500">Ready for the next capture</p>
                    </div>
                  </div>
                )}
              </div>
              <PersistentQrCard
                student={student}
                employeeLabel={employeeLabel}
                onOpen={() => setShowQrOpen(true)}
              />
            </div>

            {selectedCapture && (
              <CaptureStageMeta
                capture={selectedCapture}
                uploadStatus={selectedCapture.legacyPhoto ? photoStatusMap.get(selectedCapture.legacyPhoto.id) : undefined}
                onUpdateReview={handleUpdateCaptureReview}
                onEditFraming={() => setFramingCapture(selectedCapture)}
              />
            )}

            {!isFollowingLatest && selectedCapture && latestCapture && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-950">
                <span><strong>Manual review:</strong> browsing this capture does not change the active {employeeLabel.toLowerCase()} or capture target.</span>
                <button
                  type="button"
                  onClick={() => setReviewCaptureKey(null)}
                  className="flex items-center gap-1 font-extrabold uppercase tracking-wider text-amber-800 hover:text-amber-950"
                >
                  Latest capture <ArrowRight className="size-3.5" />
                  <kbd className="ml-1 rounded border border-amber-300 bg-amber-100 px-1 py-0.5 text-[9px]">L</kbd>
                </button>
              </div>
            )}

            <CaptureFilmstrip
              captures={captures}
              selectedCaptureId={selectedCapture?.id ?? null}
              isFollowingLatest={isFollowingLatest}
              onSelect={(captureId) => {
                const capture = captures.find((candidate) => candidate.id === captureId)
                setReviewCaptureKey(captureId === latestCapture?.id || !capture ? null : captureReviewKey(capture))
              }}
              onLatest={() => setReviewCaptureKey(null)}
              onQuickLook={(capture) => setQuickLookCapture(capture)}
              onPrevious={() => {
                const index = isFollowingLatest
                  ? captures.length - 1
                  : captures.findIndex((capture) => capture.id === selectedCapture?.id)
                if (index > 0) setReviewCaptureKey(captureReviewKey(captures[index - 1]))
              }}
              onNext={() => {
                const index = isFollowingLatest
                  ? captures.length - 1
                  : captures.findIndex((capture) => capture.id === selectedCapture?.id)
                if (index >= 0 && index < captures.length - 1) {
                  const nextCapture = captures[index + 1]
                  setReviewCaptureKey(nextCapture.id === latestCapture?.id ? null : captureReviewKey(nextCapture))
                }
              }}
            />
          </div>

          {/* Detailed capture review remains below the latest stage. */}
          <div>
              <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
                <div>
                  <div className="text-[10px] font-extrabold text-teal-600 uppercase tracking-widest bg-teal-50 px-3.5 py-1.5 rounded-full border border-teal-100 shadow-sm w-fit">
                    Capture review
                  </div>
                  <p className="mt-2 text-xs font-semibold text-slate-500">Star a photo to include it in the parent gallery.</p>
                </div>
                <div className="flex flex-wrap gap-1 bg-white p-1 rounded-xl border border-slate-200 shadow-sm">
                  {captureFilterOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setPairingFilter(option.value)}
                      className={cn(
                        'rounded-lg px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-all flex items-center gap-1.5',
                        pairingFilter === option.value
                          ? 'bg-slate-900 text-white shadow-md'
                          : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100',
                      )}
                    >
                      {option.label}
                      <span className={cn(
                        "px-1.5 py-0.5 rounded text-[9px] font-extrabold",
                        pairingFilter === option.value ? "bg-slate-700 text-white" : "bg-slate-200 text-slate-600"
                      )}>
                        {option.value === 'all' ? captures.length : captureCounts[option.value]}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {capturesLoading && captures.length === 0 && qrMarkers.length === 0 ? (
                <div className="h-64 flex flex-col items-center justify-center bg-white border border-slate-200 rounded-3xl text-slate-400 shadow-sm">
                  <Loader className="size-8 animate-spin mb-4 text-teal-500" />
                  <span className="text-sm font-bold uppercase tracking-wider">Loading captures...</span>
                </div>
              ) : capturesError ? (
                <div className="h-64 flex flex-col items-center justify-center border border-red-200 bg-red-50 rounded-3xl px-6 text-center shadow-sm">
                  <AlertCircle className="size-10 text-red-400 mb-3" />
                  <p className="text-base font-extrabold text-red-700">Could not load these captures</p>
                  <p className="text-xs font-medium text-red-600 mt-1">{capturesError}</p>
                  <button
                    type="button"
                    onClick={() => void reloadCaptures()}
                    className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-[10px] font-extrabold uppercase tracking-wider text-white hover:bg-red-700 shadow-sm"
                  >
                    Try again
                  </button>
                </div>
              ) : captures.length === 0 && qrMarkers.length === 0 ? (
                <div className="h-72 flex flex-col items-center justify-center bg-white border-2 border-dashed border-slate-200 rounded-3xl p-8 text-center shadow-sm">
                  <div className="relative mb-5 flex aspect-[5/7] w-16 items-center justify-center rounded-2xl border-2 border-dashed border-teal-300 bg-teal-50 text-teal-600 shadow-sm">
                    <div className="absolute inset-2 rounded-xl border border-teal-200" />
                    <Camera className="size-10" />
                  </div>
                  <h3 className="text-xl font-extrabold text-slate-900 mb-2 tracking-tight">Ready for photos</h3>
                  <p className="mb-1 text-[10px] font-extrabold uppercase tracking-widest text-teal-700">Portrait framing · 5:7</p>
                  <p className="text-slate-500 max-w-sm text-sm font-medium leading-relaxed">
                    Show the QR code to the camera, then start shooting. Captures will appear here instantly.
                  </p>
                </div>
              ) : filteredCaptures.length === 0 && qrMarkers.length === 0 ? (
                <div className="h-64 flex flex-col items-center justify-center bg-white border border-slate-200 rounded-3xl shadow-sm text-center">
                  <AlertCircle className="size-10 text-slate-300 mb-3" />
                  <p className="text-sm font-extrabold text-slate-500 uppercase tracking-wider">No captures match filter</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3 gap-6">
                  {qrMarkers.map((marker) => (
                    <QrMarkerTile
                      key={marker.id}
                      marker={marker}
                      onOpen={() => handleOpenPhoto(marker.filePath)}
                    />
                  ))}
                  {filteredCaptures.map((capture) => (
                    <CaptureTile
                      key={capture.id}
                      capture={capture}
                      uploadStatus={capture.legacyPhoto ? photoStatusMap.get(capture.legacyPhoto.id) : undefined}
                      onOpen={() => handleOpenPhoto(capture.legacyPhoto?.filePath ?? capture.files[0]?.storedPath ?? '')}
                      onDelete={capture.legacyPhoto ? () => handleDeletePhoto(capture.legacyPhoto!.id) : undefined}
                      onRetry={capture.legacyPhoto ? () => handleRetryPhoto(capture.legacyPhoto!.id) : undefined}
                      retrying={capture.legacyPhoto?.id === retryingPhotoId}
                      onRetryFile={handleRetryFile}
                      retryingFileId={retryingFileId}
                      onUpdateReview={handleUpdateCaptureReview}
                      onReassign={capture.legacyPhoto ? () => {
                        setReassignPhoto(capture.legacyPhoto)
                        setReassignOpen(true)
                      } : undefined}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

      {reassignOpen && reassignPhoto && (
        <ReassignDialog
          photo={reassignPhoto}
          projectId={projectId}
          onClose={() => setReassignOpen(false)}
          onDone={() => {
            setReassignOpen(false)
            reloadCaptures()
            onReassign()
          }}
        />
      )}
      <Dialog
        open={showQrOpen}
        onClose={() => setShowQrOpen(false)}
        title={`Scan to link ${employeeLabel.toLowerCase()}`}
        className="max-w-sm"
      >
        <div className="flex flex-col items-center gap-4">
          {student.simpleQr ? (
            <img
              src={student.simpleQr}
              alt={`${employeeLabel} QR Code`}
              className="w-64 max-w-full aspect-square rounded-2xl border-2 border-slate-100 bg-slate-50 p-3 shadow-inner"
              draggable={false}
            />
          ) : (
            <div className="flex aspect-square w-64 max-w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50 p-4">
              <AlertCircle className="mb-2 size-8 text-slate-300" />
              <p className="text-xs font-bold text-slate-500 text-center">QR not generated</p>
              <p className="mt-1 text-[10px] font-medium text-slate-400 text-center">Generate in the web app</p>
            </div>
          )}
          <p className="w-full truncate rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-center font-mono text-[11px] font-medium text-slate-500">
            {student.firstName}.{student.lastName}.{student.generatedStudentId}
          </p>
          <p className="text-center text-xs font-medium text-slate-500">
            Present this code to the camera before capturing portraits.
          </p>
        </div>
      </Dialog>
      {framingCapture && (
        <ReframeEditor
          capture={framingCapture}
          onCancel={() => setFramingCapture(null)}
          onSave={handleSaveFraming}
        />
      )}
      {quickLookCapture && (
        <QuickLookDialog
          capture={quickLookCapture}
          latestCapture={latestCapture}
          onClose={() => setQuickLookCapture(null)}
        />
      )}
    </div>
  )
}

function captureUploadSummary(
  capture: CaptureReview,
  legacyUploadStatus?: ProjectUploadStatusRow,
) {
  const statuses = capture.files.map((file) => file.uploadStatus)
  const status = legacyUploadStatus?.uploadStatus
    ?? (statuses.includes('error')
      ? 'error'
      : statuses.includes('uploading')
        ? 'uploading'
        : statuses.includes('pending')
          ? 'pending'
          : statuses.length > 0 && statuses.every((fileStatus) => fileStatus === 'done')
            ? 'done'
            : null)
  if (status === 'error') return { label: 'Upload error', className: 'text-rose-600', icon: <XCircle className="size-3.5" /> }
  if (status === 'uploading') return { label: 'Uploading', className: 'text-blue-600', icon: <Loader className="size-3.5 animate-spin" /> }
  if (status === 'pending') return { label: 'Queued', className: 'text-amber-600', icon: <CloudUpload className="size-3.5" /> }
  if (status === 'done') return { label: 'Synced', className: 'text-emerald-600', icon: <CheckCircle className="size-3.5" /> }
  return { label: 'Local', className: 'text-slate-500', icon: <Image className="size-3.5" /> }
}

function captureReviewKey(capture: CaptureReview) {
  return `${capture.projectId}:${capture.studentId ?? 'none'}:${capture.capturedAt}:${capture.baseFilename}`
}

function PersistentQrCard({
  student,
  employeeLabel,
  onOpen,
}: {
  student: Student
  employeeLabel: string
  onOpen: () => void
}) {
  return (
    <aside
      className="flex min-w-0 items-center gap-3 rounded-2xl border border-teal-200 bg-teal-50/80 p-3 shadow-sm lg:flex-col lg:justify-center lg:gap-2.5 lg:p-3"
      aria-label={`${employeeLabel} QR code`}
      data-testid="card-persistent-qr"
    >
      <div className="flex size-[92px] shrink-0 items-center justify-center rounded-xl border border-teal-100 bg-white p-2 shadow-inner sm:size-[104px] lg:size-[132px] lg:p-2.5">
        {student.simpleQr ? (
          <img
            src={student.simpleQr}
            alt={`${employeeLabel} QR code for ${student.firstName} ${student.lastName}`}
            className="block aspect-square size-full object-contain"
            draggable={false}
            data-testid="img-persistent-qr"
          />
        ) : (
          <div className="flex flex-col items-center justify-center text-center">
            <QrCode className="size-7 text-slate-300" />
            <span className="mt-1 text-[9px] font-bold uppercase tracking-wide text-slate-400">Not generated</span>
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1 lg:w-full lg:flex-none lg:text-center">
        <div className="flex items-center gap-1.5 text-[9px] font-extrabold uppercase tracking-[.16em] text-teal-800 lg:justify-center">
          <QrCode className="size-3.5" />
          Capture QR
        </div>
        <p className="mt-1 truncate font-mono text-[10px] font-semibold text-teal-950" title={`${student.firstName}.${student.lastName}.${student.generatedStudentId}`}>
          {student.firstName}.{student.lastName}.{student.generatedStudentId}
        </p>
        <button
          type="button"
          onClick={onOpen}
          className="mt-2 inline-flex min-h-7 items-center rounded-md border border-teal-200 bg-white px-2.5 py-1 text-[9px] font-extrabold uppercase tracking-wider text-teal-800 shadow-sm transition-colors hover:bg-teal-100 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-1"
          data-testid="button-open-persistent-qr"
        >
          Show larger
        </button>
      </div>
    </aside>
  )
}

function CaptureStage({ capture }: { capture: CaptureReview }) {
  const imageSource = useCapturePreviewSource(capture)
  const framing = capture.framing
  return (
    <div
      className="shoot-preview relative flex min-h-[220px] max-h-[430px] items-center justify-center overflow-hidden rounded-2xl border border-slate-200 bg-slate-950 shadow-lg"
    >
      {imageSource ? (
        <CaptureFramingPreview
          source={imageSource}
          alt={`Capture ${capture.baseFilename}`}
          framing={framing ?? defaultCaptureFraming}
          maxBlockSize="430px"
          className="max-w-full"
        />
      ) : (
        <div className="flex flex-col items-center justify-center text-center text-slate-500">
          <Image className="mb-3 size-10 text-slate-600" />
          <p className="text-sm font-bold text-slate-300">JPEG preview unavailable</p>
          <p className="mt-1 text-xs font-medium">The capture remains safely stored below.</p>
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/75 to-transparent p-4">
        <span className="rounded bg-black/55 px-2 py-1 font-mono text-[10px] font-bold text-white">
          {capture.baseFilename}
        </span>
        <span className="rounded bg-black/55 px-2 py-1 text-[9px] font-extrabold uppercase tracking-wider text-white/80">
          JPEG preview
        </span>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/70 to-transparent px-4 pb-3 pt-7 text-[10px] font-medium text-white/80">
        <span>{new Date(capture.capturedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
        <span>{capture.pairingStatus === 'complete' ? 'JPEG + RAW' : capture.pairingStatus.replace('_', ' ')}</span>
      </div>
    </div>
  )
}

function CaptureStageMeta({
  capture,
  uploadStatus,
  onUpdateReview,
  onEditFraming,
}: {
  capture: CaptureReview
  uploadStatus?: ProjectUploadStatusRow
  onUpdateReview: (
    captureId: number,
    values: {
      favorite?: boolean
      rejected?: boolean
      selected?: boolean
      rating?: number
      colorLabel?: CaptureReview['colorLabel']
    },
  ) => void
  onEditFraming: () => void
}) {
  const upload = captureUploadSummary(capture, uploadStatus)
  return (
    <div data-testid="shoot-completeness" className="shoot-completeness grid grid-cols-2 gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-sm sm:grid-cols-5">
      <div className="min-w-0">
        <p className="text-[9px] font-extrabold uppercase tracking-widest text-slate-400">Rating</p>
        <div className="mt-1.5 flex items-center gap-0.5" aria-label={`${capture.rating} out of 5 stars`}>
          {Array.from({ length: 5 }, (_, index) => (
            <button
              key={index}
              type="button"
              title={`Rate ${index + 1} out of 5`}
              aria-label={`Rate ${index + 1} out of 5`}
              onClick={() => onUpdateReview(capture.id, { rating: index + 1 })}
              className="rounded p-0.5 hover:bg-amber-50"
            >
              <Star className="size-3.5 text-amber-400" fill={index < capture.rating ? 'currentColor' : 'none'} />
            </button>
          ))}
        </div>
      </div>
      <div className="min-w-0">
        <p className="text-[9px] font-extrabold uppercase tracking-widest text-slate-400">Pairing</p>
        <p className={cn('mt-2 truncate text-xs font-bold', capture.pairingStatus === 'unpaired' ? 'text-rose-600' : 'text-slate-700')}>
          {capture.pairingStatus === 'complete' ? 'JPEG + RAW' : capture.pairingStatus === 'jpeg_only' ? 'JPEG only' : capture.pairingStatus === 'raw_only' ? 'RAW only' : capture.pairingStatus === 'unpaired' ? 'Needs review' : 'Pending'}
        </p>
      </div>
      <div className="min-w-0">
        <p className="text-[9px] font-extrabold uppercase tracking-widest text-slate-400">Upload</p>
        <span className={cn('mt-2 flex items-center gap-1 text-[10px] font-extrabold uppercase tracking-wider', upload.className)}>
          {upload.icon} {upload.label}
        </span>
      </div>
      <div className="flex items-end gap-2 sm:justify-end">
        <button
          type="button"
          onClick={onEditFraming}
          className="rounded-lg border border-slate-200 px-2 py-1.5 text-[10px] font-extrabold uppercase tracking-wider text-slate-500 hover:bg-slate-50"
        >
          <Pencil className="mr-1 inline size-3" /> Edit framing
        </button>
        <button
          type="button"
          onClick={() => onUpdateReview(capture.id, { selected: !capture.selected })}
          className={cn('rounded-lg border px-2 py-1.5 text-[10px] font-extrabold uppercase tracking-wider', capture.selected ? 'border-teal-200 bg-teal-50 text-teal-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50')}
        >
          <Check className="mr-1 inline size-3" /> {capture.selected ? 'Selected' : 'Select'}
        </button>
        <button
          type="button"
          onClick={() => onUpdateReview(capture.id, { favorite: !capture.favorite })}
          className={cn('rounded-lg border px-2 py-1.5 text-[10px] font-extrabold uppercase tracking-wider', capture.favorite ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50')}
        >
          <Star className="mr-1 inline size-3" fill={capture.favorite ? 'currentColor' : 'none'} /> {capture.favorite ? 'Favorite' : 'Favorite'}
        </button>
      </div>
    </div>
  )
}

function QuickLookDialog({
  capture,
  latestCapture,
  onClose,
}: {
  capture: CaptureReview
  latestCapture: CaptureReview | null
  onClose: () => void
}) {
  const [zoom, setZoom] = useState(1)
  const [compareLatest, setCompareLatest] = useState(false)
  const captureSource = useCapturePreviewSource(capture)
  const latestSource = useCapturePreviewSource(latestCapture)
  const displayedSource = compareLatest && latestSource ? latestSource : captureSource
  const displayedName = compareLatest && latestCapture ? latestCapture.baseFilename : capture.baseFilename

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Quick Look ${capture.baseFilename}`}
      className="fixed inset-0 z-[100] flex flex-col bg-slate-950/95"
      onClick={onClose}
    >
      <div
        className="flex flex-wrap items-center justify-between gap-3 border-b border-white/15 px-5 py-3 text-white"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="min-w-0">
          <p className="text-sm font-bold">Quick Look</p>
          <p className="truncate text-xs text-white/60">{displayedName}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {latestCapture && latestCapture.id !== capture.id && latestSource && (
            <button
              type="button"
              onClick={() => setCompareLatest((value) => !value)}
              className={cn(
                'rounded-lg px-3 py-2 text-xs font-bold transition-colors',
                compareLatest ? 'bg-teal-500 text-white' : 'bg-white/10 text-white hover:bg-white/20',
              )}
            >
              {compareLatest ? 'Showing latest' : 'Compare with latest'}
            </button>
          )}
          <button
            type="button"
            onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
            className="rounded-lg bg-white/10 px-3 py-2 text-sm font-bold hover:bg-white/20"
          >
            −
          </button>
          <span className="w-14 text-center text-xs font-bold">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            onClick={() => setZoom((value) => Math.min(4, value + 0.25))}
            className="rounded-lg bg-white/10 px-3 py-2 text-sm font-bold hover:bg-white/20"
          >
            +
          </button>
          <button type="button" onClick={onClose} className="rounded-lg bg-white px-3 py-2 text-sm font-bold text-slate-900">
            Close
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6" onClick={(event) => event.stopPropagation()}>
        {displayedSource ? (
          <img
            src={displayedSource}
            alt={displayedName}
            draggable={false}
            style={{ transform: `scale(${zoom})` }}
            className="max-h-[82vh] max-w-[92vw] origin-center object-contain transition-transform"
          />
        ) : (
          <p className="text-sm font-semibold text-slate-400">Preview unavailable for this capture.</p>
        )}
      </div>
      <p className="border-t border-white/10 px-5 py-2 text-center text-[10px] font-medium uppercase tracking-wider text-white/45">
        Escape or click outside to close · Original file is unchanged
      </p>
    </div>
  )
}

const defaultCaptureFraming: Omit<CaptureFraming, 'pending'> = {
  cropX: 0,
  cropY: 0,
  cropScale: 100,
  aspectRatio: '5:7',
  straightenAngle: 0,
  rotation: 0,
}

const defaultGroupCaptureFraming: Omit<CaptureFraming, 'pending'> = {
  ...defaultCaptureFraming,
  aspectRatio: '7:5',
}

function captureAspectRatioStyle(
  framing?: Pick<CaptureFraming, 'aspectRatio'> | null,
) {
  if (!framing || framing.aspectRatio === 'original') return undefined
  const [width, height] = framing.aspectRatio.split(':').map(Number)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined
  }
  return { aspectRatio: `${width} / ${height}` }
}

function useCapturePreviewSource(capture: CaptureReview | null): string | undefined {
  const jpegFile = capture?.files.find((file) => file.fileRole === 'JPEG')
  const immediateSource = capture?.legacyPhoto?.previewUrl
    ?? jpegFile?.previewUrl
    ?? capture?.thumbnailData
    ?? capture?.legacyPhoto?.thumbnailData
    ?? undefined
  const filePath = jpegFile?.storedPath ?? capture?.legacyPhoto?.filePath
  const previewKey = capture ? `gallery-capture-${capture.id}` : null
  const [generatedPreview, setGeneratedPreview] = useState<{
    previewKey: string
    source: string
  } | null>(null)

  useEffect(() => {
    if (immediateSource || !previewKey || !filePath) return
    let mounted = true
    const cancel = previewScheduler.enqueue({
      id: `selected-${previewKey}`,
      priority: 'gallery',
      execute: async (signal) => {
        const source = await window.api.invoke('photos:getPreview', {
          filePath,
          previewKey,
        })
        if (
          mounted
          && !signal.aborted
          && typeof source === 'string'
          && source.startsWith('mc-preview://')
        ) {
          setGeneratedPreview({ previewKey, source })
        }
      },
    })
    return () => {
      mounted = false
      cancel()
    }
  }, [filePath, immediateSource, previewKey])

  return immediateSource
    ?? (generatedPreview?.previewKey === previewKey ? generatedPreview.source : undefined)
}

function ReframeEditor({
  capture,
  onCancel,
  onSave,
}: {
  capture: CaptureReview
  onCancel: () => void
  onSave: (captureId: number, framing: Omit<CaptureFraming, 'pending'>) => Promise<void>
}) {
  const [framing, setFraming] = useState<Omit<CaptureFraming, 'pending'>>({
    ...defaultCaptureFraming,
    ...capture.framing,
  })
  const source = useCapturePreviewSource(capture)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  const update = <K extends keyof Omit<CaptureFraming, 'pending'>>(key: K, value: Omit<CaptureFraming, 'pending'>[K]) => {
    setFraming((current) => ({ ...current, [key]: value }))
  }

  return (
    <div role="dialog" aria-modal="true" aria-label={`Edit framing ${capture.baseFilename}`} className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/70 p-4">
      <div className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <p className="text-sm font-extrabold text-slate-900">Edit framing</p>
            <p className="mt-1 text-xs text-slate-500">{capture.baseFilename} · non-destructive</p>
          </div>
          <button type="button" onClick={onCancel} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label="Close framing editor">
            <XCircle className="size-5" />
          </button>
        </div>
        <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto p-5 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="flex min-h-[280px] items-center justify-center overflow-hidden rounded-xl bg-slate-950 p-5">
            <div className="flex max-h-[62vh] w-full items-center justify-center overflow-hidden bg-black">
              {source ? (
                <CaptureFramingPreview
                  source={source}
                  alt={`Framing preview ${capture.baseFilename}`}
                  framing={framing}
                  maxBlockSize="62vh"
                  className="max-w-full"
                />
              ) : (
                <p className="text-sm font-semibold text-slate-400">Preview unavailable</p>
              )}
            </div>
          </div>
          <div className="space-y-4">
            <div>
              <label htmlFor="reframe-aspect" className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">Aspect ratio</label>
              <select
                id="reframe-aspect"
                value={framing.aspectRatio}
                onChange={(event) => update('aspectRatio', event.target.value as CaptureAspectRatio)}
                className="mt-1.5 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700"
              >
                <option value="original">Original</option>
                <option value="1:1">Square · 1:1</option>
                <option value="4:5">Portrait · 4:5</option>
                <option value="5:7">Portrait · 5:7</option>
                <option value="3:2">Classic · 3:2</option>
                <option value="7:5">Landscape · 7:5</option>
                <option value="16:9">Widescreen · 16:9</option>
              </select>
            </div>
            {([
              ['cropX', 'Horizontal position', -100, 100, 1],
              ['cropY', 'Vertical position', -100, 100, 1],
              ['cropScale', 'Crop scale', 100, 300, 1],
              ['straightenAngle', 'Straighten angle', -15, 15, 1],
            ] as const).map(([key, label, min, max, step]) => (
              <label key={key} className="block">
                <div className="flex items-center justify-between text-[10px] font-extrabold uppercase tracking-wider text-slate-500">
                  <span>{label}</span>
                  <span className="font-mono text-slate-700">{framing[key]}{key === 'cropScale' ? '%' : key === 'straightenAngle' ? '°' : ''}</span>
                </div>
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={step}
                  value={framing[key]}
                  onChange={(event) => update(key, Number(event.target.value) as never)}
                  className="mt-2 w-full accent-teal-600"
                />
              </label>
            ))}
            <div>
              <p className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">Rotate</p>
              <button
                type="button"
                onClick={() => update('rotation', ((framing.rotation + 90) % 360) as CaptureFraming['rotation'])}
                className="mt-1.5 flex w-full items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-extrabold uppercase tracking-wider text-slate-600 hover:bg-slate-50"
              >
                <RotateCw className="size-3.5" /> 90° clockwise · {framing.rotation}°
              </button>
            </div>
            <button
              type="button"
              onClick={() => setFraming(defaultCaptureFraming)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-extrabold uppercase tracking-wider text-slate-600 hover:bg-slate-50"
            >
              Reset adjustments
            </button>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4">
          <button type="button" onClick={onCancel} className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-extrabold uppercase tracking-wider text-slate-600 hover:bg-slate-50">
            Cancel
          </button>
          <button type="button" onClick={() => void onSave(capture.id, framing)} className="rounded-lg bg-teal-600 px-4 py-2 text-xs font-extrabold uppercase tracking-wider text-white hover:bg-teal-700">
            Save framing
          </button>
        </div>
      </div>
    </div>
  )
}

function CaptureFilmstrip({
  captures,
  selectedCaptureId,
  isFollowingLatest,
  onSelect,
  onQuickLook,
  onLatest,
  onPrevious,
  onNext,
}: {
  captures: CaptureReview[]
  selectedCaptureId: number | null
  isFollowingLatest: boolean
  onSelect: (captureId: number) => void
  onQuickLook: (capture: CaptureReview) => void
  onLatest: () => void
  onPrevious: () => void
  onNext: () => void
}) {
  const stripRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    if (isFollowingLatest) {
      strip.scrollTo({ left: strip.scrollWidth, behavior: 'smooth' })
      return
    }
    strip.querySelector<HTMLElement>(`[data-filmstrip-capture="${selectedCaptureId}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [captures.length, isFollowingLatest, selectedCaptureId])

  if (captures.length === 0) return null
  const latestCaptureId = captures[captures.length - 1].id

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[10px] font-extrabold uppercase tracking-[.18em] text-slate-500">Recent captures</p>
          <p className="mt-1 text-[11px] text-slate-400">Newest on the right · click to review without changing target</p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onPrevious}
            disabled={isFollowingLatest && captures.length < 2}
            aria-label="Previous capture"
            title="Previous capture"
            className="rounded-lg border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-35"
          >
            <ArrowLeft className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={isFollowingLatest || captures.length < 2}
            aria-label="Next capture"
            title="Next capture"
            className="rounded-lg border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-35"
          >
            <ArrowRight className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={onLatest}
            className={cn('rounded-full px-2 py-1 text-[9px] font-extrabold uppercase tracking-wider', isFollowingLatest ? 'bg-teal-50 text-teal-700' : 'bg-amber-50 text-amber-700 hover:bg-amber-100')}
          >
            {isFollowingLatest ? 'Following latest' : 'Latest capture'}
          </button>
        </div>
      </div>
      <div ref={stripRef} className="flex gap-2 overflow-x-auto pb-1">
        {captures.map((capture) => {
          const isCurrent = selectedCaptureId === capture.id
           const isNewest = capture.id === latestCaptureId
           const jpegFile = capture.files.find((file) => file.fileRole === 'JPEG')
           const source = capture.legacyPhoto?.previewUrl ?? jpegFile?.previewUrl
           const filePath = jpegFile?.storedPath ?? capture.legacyPhoto?.filePath
           const fallback = capture.thumbnailData ?? capture.legacyPhoto?.thumbnailData
          return (
            <button
              key={capture.id}
              data-filmstrip-capture={capture.id}
              type="button"
              onClick={() => onSelect(capture.id)}
              className={cn(
                'group relative min-w-[132px] overflow-hidden rounded-lg border-2 text-left transition-all sm:min-w-[150px]',
                isCurrent ? 'border-teal-500 shadow-[0_0_0_2px_rgba(20,184,166,.14)]' : 'border-slate-200 hover:border-slate-400',
              )}
              aria-label={`Review capture ${capture.baseFilename}`}
              aria-pressed={isCurrent}
            >
              <div
                className="relative aspect-[1.45] overflow-hidden bg-slate-900"
                style={captureAspectRatioStyle(capture.framing)}
              >
                <GalleryThumbnail
                  source={source}
                  fallback={fallback}
                  filePath={filePath}
                  previewKey={`gallery-capture-${capture.id}`}
                  alt={`Capture ${capture.baseFilename}`}
                  framing={capture.framing}
                />
                {(source || fallback || filePath) && (
                  <span
                    role="button"
                    tabIndex={0}
                    title="Quick Look"
                    aria-label={`Quick Look ${capture.baseFilename}`}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      onQuickLook(capture)
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      event.stopPropagation()
                      onQuickLook(capture)
                    }}
                    className="absolute bottom-2 right-2 rounded-md bg-black/70 p-1.5 text-white opacity-0 transition-opacity hover:bg-black/90 group-hover:opacity-100 group-focus-within:opacity-100"
                  >
                    <Maximize2 className="size-3.5" />
                  </span>
                )}
                <span className={cn('absolute left-2 top-2 rounded px-1.5 py-0.5 text-[8px] font-extrabold uppercase tracking-wider text-white', isNewest ? 'bg-red-600' : 'bg-black/60')}>
                  {isNewest ? 'Newest' : `Frame ${capture.sequence ?? ''}`}
                </span>
                {capture.favorite && <Star className="absolute right-2 top-2 size-3.5 text-amber-300" fill="currentColor" />}
              </div>
              <div className="flex items-center justify-between gap-2 bg-white px-2 py-2">
                <span className="font-mono text-[9px] text-slate-500">
                  {new Date(capture.capturedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <span className={cn('text-[9px] font-extrabold uppercase', capture.pairingStatus === 'complete' ? 'text-emerald-600' : capture.pairingStatus === 'unpaired' ? 'text-rose-600' : 'text-slate-500')}>
                  {capture.pairingStatus === 'complete' ? 'JPG+RAW' : capture.pairingStatus === 'jpeg_only' ? 'JPG' : capture.pairingStatus.replace('_', ' ')}
                </span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function GroupDetail({
  group,
  students,
  groupCaptures,
  isActiveCaptureTarget,
  onMembershipChange,
  onClearCaptureTarget,
  onRefreshCaptures,
}: {
  group: StudentGroup
  students: Student[]
  groupCaptures: GroupCaptureReview[]
  isActiveCaptureTarget: boolean
  onMembershipChange: (group: StudentGroup, studentId: number, checked: boolean) => void
  onClearCaptureTarget: () => void
  onRefreshCaptures: () => void
}) {
  const memberStudentIds = createGroupMemberStudentIdSet(group.memberStudentIds)

  function captureUploadState(capture: GroupCaptureReview) {
    const label = captureUploadLabel(capture.files)
    if (label === 'Upload failed') return { label, className: 'bg-red-50 text-red-700 border-red-200' }
    if (label === 'Uploading') return { label, className: 'bg-blue-50 text-blue-700 border-blue-200' }
    if (label === 'Queued') return { label, className: 'bg-amber-50 text-amber-700 border-amber-200' }
    if (label === 'Preparing gallery') return { label, className: 'bg-violet-50 text-violet-700 border-violet-200' }
    return { label, className: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
  }

  function fileUploadState(file: GroupCaptureReview['files'][number]) {
    if (file.uploadStatus === 'done' && file.fileRole === 'JPEG' && !file.galleryReady) {
      return { label: 'Preparing gallery', className: 'text-violet-700', icon: <Loader className="size-3 animate-spin" /> }
    }
    if (file.uploadStatus === 'done') {
      return { label: 'Uploaded', className: 'text-emerald-700', icon: <CheckCircle className="size-3" /> }
    }
    if (file.uploadStatus === 'uploading') {
      return { label: 'Uploading', className: 'text-blue-700', icon: <Loader className="size-3 animate-spin" /> }
    }
    if (file.uploadStatus === 'error') {
      return { label: 'Failed', className: 'text-red-700', icon: <XCircle className="size-3" /> }
    }
    return { label: 'Queued', className: 'text-amber-700', icon: <CloudUpload className="size-3" /> }
  }

  async function updateGroupRating(captureId: number, rating: number) {
    try {
      await window.api.invoke('groupCaptures:updateReview', { captureId, rating })
      onRefreshCaptures()
    } catch (error) {
      addToast({ type: 'error', title: 'Could not update group selection', description: String(error) })
    }
  }

  return (
    <div className="flex flex-col h-full relative bg-slate-50">
      <div className="shoot-subject-header bg-white border-b border-slate-200 px-8 py-6 flex flex-wrap gap-4 justify-between items-start shadow-sm z-10 shrink-0 relative">
        {isActiveCaptureTarget && (
          <div className="absolute top-0 left-0 w-full h-1 bg-teal-500" />
        )}
        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-3 mb-2">
            {isActiveCaptureTarget && (
              <Badge className="bg-teal-500 hover:bg-teal-500 text-white font-extrabold uppercase tracking-widest text-[10px] px-2.5 py-0.5 shadow-sm">
                <Camera className="size-3 mr-1.5" /> Active Target
              </Badge>
            )}
            <span className="text-[11px] font-extrabold uppercase tracking-widest text-slate-400">Custom Group</span>
            <span className="rounded-md border border-teal-100 bg-teal-50 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-widest text-teal-700">
              Landscape · 7:5
            </span>
          </div>
          <h2 className="shoot-subject-name text-3xl sm:text-4xl font-extrabold text-slate-900 tracking-tight break-words">
            {group.name}
          </h2>
        </div>
        <div className="flex flex-col items-end gap-3 justify-center shrink-0">
          {isActiveCaptureTarget && (
            <Button variant="outline" size="sm" onClick={onClearCaptureTarget} className="text-[10px] font-bold uppercase tracking-wider h-8 border-slate-300 text-slate-600 hover:bg-slate-100 hover:text-slate-900 shadow-sm">
              <XCircle className="size-3.5 mr-1.5" /> Clear Target
            </Button>
          )}
          <div className="text-[11px] font-bold uppercase tracking-widest text-slate-500">
            {groupCaptures.length} Capture{groupCaptures.length !== 1 ? 's' : ''} recorded
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-8">
        <div className="shoot-group-body max-w-[1400px] mx-auto flex flex-col xl:flex-row gap-8">
          {/* Members Column */}
          <div className="w-full xl:w-[340px] shrink-0">
            <div className="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden flex flex-col max-h-[300px] xl:max-h-[calc(100vh-250px)]">
              <div className="p-6 border-b border-slate-100 bg-slate-50 shrink-0">
                <div className="text-[10px] font-extrabold text-teal-600 uppercase tracking-widest mb-3 bg-teal-50 px-3.5 py-1.5 rounded-full border border-teal-100 w-fit shadow-sm">
                  1. Roster
                </div>
                <p className="text-base font-extrabold text-slate-900">Select group members</p>
                <p className="text-xs font-medium text-slate-500 mt-1.5 leading-relaxed">Photos will be assigned to all selected students.</p>
              </div>
              <div className="flex-1 overflow-y-auto p-3">
                {students.map(student => {
                  const isSelected = memberStudentIds.has(student.id)
                  return (
                    <label key={student.id} className={cn("flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-all border", isSelected ? "bg-teal-50/50 border-teal-200 shadow-sm" : "border-transparent hover:bg-slate-50")}>
                      <input type="checkbox" className="rounded border-slate-300 text-teal-600 focus:ring-teal-600 size-4" checked={isSelected} onChange={e => onMembershipChange(group, student.id, e.target.checked)} />
                      <div className="flex-1 min-w-0">
                        <p className={cn("text-sm font-bold truncate", isSelected ? "text-teal-950" : "text-slate-700")}>{student.lastName}, {student.firstName}</p>
                        <p className="text-[10px] font-mono font-medium text-slate-500 truncate mt-0.5">{student.generatedStudentId}</p>
                      </div>
                    </label>
                  )
                })}
              </div>
            </div>
          </div>

          {/* Captures Column */}
          <div className="shoot-capture-area flex-1 min-w-0 flex flex-col gap-4">
            <div className="flex items-center justify-between mb-1">
              <div className="text-[10px] font-extrabold text-teal-600 uppercase tracking-widest bg-teal-50 px-3.5 py-1.5 rounded-full border border-teal-100 shadow-sm w-fit">
                2. Group Captures
              </div>
              <Button size="sm" variant="outline" onClick={onRefreshCaptures} className="h-8 text-[10px] font-bold uppercase tracking-wider text-slate-600">
                <RefreshCw className="size-3.5 mr-1.5" /> Refresh
              </Button>
            </div>

            {groupCaptures.length === 0 ? (
              <div className="h-72 flex flex-col items-center justify-center bg-white border-2 border-dashed border-slate-200 rounded-3xl p-8 text-center shadow-sm">
                <div className="relative mb-5 flex aspect-[7/5] w-32 items-center justify-center rounded-2xl border-2 border-dashed border-teal-300 bg-teal-50 text-teal-600 shadow-sm">
                  <div className="absolute inset-2 rounded-xl border border-teal-200" />
                  <Camera className="size-10" />
                </div>
                <h3 className="text-xl font-extrabold text-slate-900 mb-2 tracking-tight">Ready for group photos</h3>
                <p className="mb-1 text-[10px] font-extrabold uppercase tracking-widest text-teal-700">Landscape framing · 7:5</p>
                <p className="text-slate-500 max-w-sm text-sm font-medium leading-relaxed mb-4">
                  Make sure all subjects are framed, then start shooting.
                </p>
                <Button onClick={onRefreshCaptures} className="bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold uppercase tracking-wider px-6 shadow-sm">
                  <RefreshCw className="size-4 mr-2" /> Check for Captures
                </Button>
              </div>
            ) : (
              <div className="grid grid-cols-1 2xl:grid-cols-2 gap-6">
                {groupCaptures.map(capture => {
                  const overallUploadState = captureUploadState(capture)
                  return (
                  <div key={capture.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm flex flex-col gap-4 relative overflow-hidden transition-shadow hover:shadow-md">
                    <div className="absolute top-0 left-0 w-1 h-full bg-teal-500" />
                    {capture.files.find(file => file.fileRole === 'JPEG') && (
                      <button
                        type="button"
                         className="aspect-[7/5] w-full overflow-hidden rounded-xl bg-slate-100"
                        onClick={() => void window.api.invoke('photos:openInSystem', {
                          filePath: capture.files.find(file => file.fileRole === 'JPEG')!.storedPath,
                        })}
                        title="Open full-size image to inspect focus and zoom"
                      >
                        <GalleryThumbnail
                          source={capture.files.find(file => file.fileRole === 'JPEG')!.previewUrl}
                          filePath={capture.files.find(file => file.fileRole === 'JPEG')!.storedPath}
                          previewKey={`group-capture-${capture.id}`}
                          alt={capture.baseFilename}
                           framing={defaultGroupCaptureFraming}
                        />
                      </button>
                    )}
                    <div>
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <span className="font-extrabold text-base text-slate-900 truncate">{capture.baseFilename}</span>
                        <Badge data-testid="shoot-completeness" className={cn('shoot-completeness shrink-0 border font-extrabold uppercase tracking-wider text-[9px] px-2 py-0.5 shadow-none', overallUploadState.className)}>
                          {overallUploadState.label}
                        </Badge>
                      </div>
                      <Badge className="bg-slate-100 text-slate-600 border-none font-extrabold uppercase tracking-wider text-[9px] px-2 py-0.5 shadow-none">{capture.pairingStatus}</Badge>
                    </div>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      {capture.files.map(file => {
                        const uploadState = fileUploadState(file)
                        return (
                          <button key={file.id} type="button" onClick={() => void window.api.invoke('photos:openInSystem', { filePath: file.storedPath })} className="hover:bg-teal-50 transition-colors flex min-w-[140px] flex-1 items-center justify-between gap-2 bg-slate-50 px-3 py-2 rounded-lg border border-slate-200 text-[10px] font-extrabold uppercase tracking-wider text-slate-600">
                            <span className="flex items-center gap-1.5"><ExternalLink className="size-3" /> {file.fileRole}</span>
                            <span className={cn('flex items-center gap-1 normal-case tracking-normal', uploadState.className)}>
                              {uploadState.icon} {uploadState.label}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                    <div className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
                      <span className="text-[10px] font-extrabold uppercase tracking-wider text-amber-900">Parent gallery</span>
                      <div className="flex items-center gap-0.5">
                        {[1, 2, 3, 4, 5].map(rating => (
                          <button
                            key={rating}
                            type="button"
                            aria-label={`Rate group photo ${rating} stars`}
                            onClick={() => void updateGroupRating(capture.id, capture.rating === rating ? 0 : rating)}
                            className="p-1 text-amber-500 hover:text-amber-600"
                          >
                            <Star className="size-5" fill={capture.rating >= rating ? 'currentColor' : 'none'} />
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function LivePreview({
  photo,
  traceId,
  framing,
}: {
  photo: Photo
  traceId?: string
  framing: Omit<CaptureFraming, 'pending'>
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [showImageFallback, setShowImageFallback] = useState(false)
  const [canvasPainted, setCanvasPainted] = useState(false)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [sourceSize, setSourceSize] = useState<{ width: number; height: number } | null>(null)

  useEffect(() => {
    if (!photo.previewUrl || !traceId) return
    let mounted = true
    setShowImageFallback(false)
    setCanvasPainted(false)
    setPreviewFailed(false)
    setSourceSize(null)
    const report = (
      stage:
        | 'React state update committed'
        | 'image decode started'
        | 'image decode complete'
        | 'image preview superseded'
        | 'image pixels painted',
      details?: string,
    ) => {
      void window.api.invoke('imagePipeline:rendererStage', {
        traceId,
        stage,
        atEpochMs: Date.now(),
        details,
      }).catch(() => {
        // Diagnostics are opt-in and must never affect the capture UI.
      })
    }

    report('React state update committed')
    const cancel = previewScheduler.enqueue({
      id: traceId,
      priority: 'live',
      execute: async (signal) => {
        try {
          const queue = previewScheduler.snapshot()
          report(
            'image decode started',
            `source=resized-local-url active=${queue.activePriority ?? 'none'}`
              + ` pendingLive=${queue.pendingLive ? '1' : '0'}`
              + ` galleryQueued=${queue.galleryQueued}`
              + ` galleryMax=${queue.maxGalleryQueued}`,
          )
          const bitmap = await decodeResizedPreview(photo.previewUrl!, 1440, signal)
          if (!bitmap || signal.aborted || !mounted) {
            bitmap?.close()
            return
          }

          report('image decode complete', `size=${bitmap.width}x${bitmap.height}`)
          const canvas = canvasRef.current
          const context = canvas?.getContext('2d')
          if (!canvas || !context || signal.aborted || !mounted) {
            bitmap.close()
            return
          }
          canvas.width = bitmap.width
          canvas.height = bitmap.height
          setSourceSize({ width: bitmap.width, height: bitmap.height })
          context.clearRect(0, 0, canvas.width, canvas.height)
          context.drawImage(bitmap, 0, 0)
          bitmap.close()
          setCanvasPainted(true)

          await waitForPaintFrames()
          if (!mounted || signal.aborted) return
          report('image pixels painted', `original=${photo.filePath}`)
        } catch (error) {
          if (!mounted || signal.aborted) return
          console.warn('[LivePreview] Canvas decode failed; using image fallback', error)
          setShowImageFallback(true)
        }
      },
      onCancelled: () => {
        report('image preview superseded', 'newer capture prioritized')
      },
    })

    return () => {
      mounted = false
      cancel()
    }
  }, [photo.filePath, photo.previewUrl, traceId])

  const geometry = sourceSize
    ? getCaptureCropGeometry(sourceSize.width, sourceSize.height, framing)
    : null
  const viewportStyle = geometry
    ? {
        ...capturePreviewViewportStyle(geometry, '430px'),
        height: 'auto',
      }
    : {
        width: 'min(100%, calc(430px * 0.7142857143))',
        height: 'auto',
        maxHeight: '430px',
        aspectRatio: '5 / 7',
      }
  const framedMediaStyle = geometry
    ? {
        width: `${(geometry.transformedWidth / geometry.cropWidth) * 100}%`,
        height: `${(geometry.transformedHeight / geometry.cropHeight) * 100}%`,
        left: `${-(geometry.cropLeft / geometry.cropWidth) * 100}%`,
        top: `${-(geometry.cropTop / geometry.cropHeight) * 100}%`,
      }
    : undefined
  const sourceMediaStyle = geometry
    ? {
        width: `${(geometry.sourceWidth / geometry.transformedWidth) * 100}%`,
        height: `${(geometry.sourceHeight / geometry.transformedHeight) * 100}%`,
        transform: `translate(-50%, -50%) rotate(${geometry.rotation + geometry.straightenAngle}deg)`,
      }
    : undefined

  return (
    <div
      className="shoot-preview relative mx-auto mb-4 flex max-h-[430px] min-h-[220px] items-center justify-center overflow-hidden rounded-2xl border border-slate-200 bg-black shadow-lg"
      style={viewportStyle}
    >
      <div className="absolute top-0 left-0 right-0 bg-gradient-to-b from-black/80 to-transparent p-5 z-10 flex justify-between items-start pointer-events-none transition-opacity duration-300">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 bg-red-600 text-white text-[10px] font-extrabold uppercase tracking-widest px-2.5 py-1 rounded shadow-sm">
            <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse shadow-[0_0_8px_rgba(255,255,255,0.8)]" />
            Live Preview
          </span>
          <span className="text-xs font-mono font-medium text-white/80 drop-shadow-md bg-black/40 px-2 py-0.5 rounded backdrop-blur-sm">{photo.fileName}</span>
        </div>
        <span className="text-[10px] font-bold text-white/60 uppercase tracking-widest bg-black/40 px-2.5 py-1 rounded backdrop-blur-sm hidden md:block">
          Prioritizing newest capture
        </span>
      </div>

      <div className="absolute inset-0 flex items-center justify-center bg-black">
        <div
          className={cn(
            geometry
              ? 'absolute'
              : 'relative flex h-full w-full items-center justify-center p-4',
          )}
          style={framedMediaStyle}
        >
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={`Latest capture ${photo.fileName}`}
            data-preview-url={photo.previewUrl}
            className={cn(
              geometry
                ? 'absolute left-1/2 top-1/2 max-w-none'
                : 'block max-h-full max-w-full object-contain',
              (!canvasPainted || showImageFallback) && 'hidden',
            )}
            style={sourceMediaStyle}
          />
          {(!canvasPainted || showImageFallback) && !previewFailed && (
            <img
              src={photo.previewUrl}
              alt={`Latest capture ${photo.fileName}`}
              className={cn(
                geometry
                  ? 'absolute left-1/2 top-1/2 max-w-none'
                  : 'block max-h-full max-w-full object-contain',
              )}
              style={sourceMediaStyle}
              draggable={false}
              onError={() => setPreviewFailed(true)}
            />
          )}
        </div>
        {previewFailed && !canvasPainted && (
          <div className="absolute inset-0 flex h-40 flex-col items-center justify-center px-6 text-center">
            <AlertCircle className="mb-3 size-10 text-amber-500" />
            <p className="text-base font-bold text-white">Preview could not be displayed</p>
            <p className="mt-1.5 text-xs text-slate-400 font-medium">The original photograph remains safely stored.</p>
          </div>
        )}
      </div>
    </div>
  )
}

function GalleryThumbnail({
  source,
  fallback,
  filePath,
  previewKey,
  alt,
  framing,
}: {
  source?: string
  fallback?: string | null
  filePath?: string
  previewKey?: string
  alt: string
  framing?: Omit<CaptureFraming, 'pending'>
}) {
  const [generatedSource, setGeneratedSource] = useState<string | null>(null)

  useEffect(() => {
    setGeneratedSource(null)
    if (fallback || (!source && !filePath)) return
    let mounted = true
    let objectUrl: string | null = null
    const cancel = previewScheduler.enqueue({
      id: `gallery-${previewKey ?? source ?? filePath}`,
      priority: 'gallery',
      execute: async (signal) => {
        const resolvedSource = source ?? await window.api.invoke('photos:getPreview', {
          filePath: filePath!,
          previewKey: previewKey ?? `gallery-${filePath}`,
        })
        if (!resolvedSource || signal.aborted || !mounted) return
        const bitmap = await decodeResizedPreview(resolvedSource, 320, signal)
        if (!bitmap || signal.aborted || !mounted) {
          bitmap?.close()
          return
        }
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
        bitmap.close()
        const blob = await new Promise<Blob | null>((resolve) => {
          canvas.toBlob(resolve, 'image/jpeg', 0.82)
        })
        if (!blob || !mounted || signal.aborted) return
        objectUrl = URL.createObjectURL(blob)
        setGeneratedSource(objectUrl)
      },
    })

    return () => {
      mounted = false
      cancel()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [fallback, filePath, previewKey, source])

  const imageSource = fallback ?? generatedSource
  if (!imageSource) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-slate-100">
        <Image className="size-8 text-slate-300" />
      </div>
    )
  }
  return (
    framing ? (
      <CaptureFramingPreview
        source={imageSource}
        alt={alt}
        framing={framing}
        maxBlockSize="100%"
        fill
        className="h-full w-full"
      />
    ) : (
      <img
        src={imageSource}
        alt={alt}
        className="h-full w-full object-cover transition-opacity duration-300 ease-in-out"
        draggable={false}
      />
    )
  )
}

function CaptureCompleteness({ capture }: { capture: CaptureReview }) {
  const hasJpeg = capture.pairingStatus === 'complete' || capture.pairingStatus === 'jpeg_only' || capture.pairingStatus === 'unpaired' || capture.files.some(f => f.fileFormat === 'JPG' || f.fileFormat === 'JPEG') || !!capture.legacyPhoto
  const hasRaw = capture.pairingStatus === 'complete' || capture.pairingStatus === 'raw_only' || capture.files.some(f => f.fileRole === 'RAW')

  return (
    <div className="flex flex-col gap-1.5 z-10">
      <div className="flex items-center gap-[1px] bg-black/70 backdrop-blur-md rounded px-[2px] py-[2px] w-fit shadow-sm border border-white/10">
        <div className={cn("text-[9px] font-extrabold uppercase px-1.5 py-[1px] rounded-[2px] tracking-widest", hasJpeg ? "bg-white text-slate-900 shadow-sm" : "text-white/40")} title={hasJpeg ? "JPEG captured" : "Waiting for JPEG"}>
          JPG
        </div>
        <div className={cn("text-[9px] font-extrabold uppercase px-1.5 py-[1px] rounded-[2px] tracking-widest", hasRaw ? "bg-white text-slate-900 shadow-sm" : "text-white/40")} title={hasRaw ? "RAW captured" : "Waiting for RAW"}>
          RAW
        </div>
      </div>
      {capture.pairingStatus === 'unpaired' && (
         <div className="bg-red-600/90 backdrop-blur-md text-white text-[9px] font-extrabold uppercase tracking-widest px-2 py-0.5 rounded shadow-sm border border-red-500/50 w-fit">
           Needs Review
         </div>
      )}
    </div>
  )
}

function PhotoTile({
  photo,
  framing,
  uploadStatus,
  onOpen,
  onDelete,
  onReassign,
  onRetry,
  retrying,
}: {
  photo: Photo
  framing?: Omit<CaptureFraming, 'pending'>
  uploadStatus?: ProjectUploadStatusRow
  onOpen: () => void
  onDelete: () => void
  onReassign: () => void
  onRetry: () => void
  retrying: boolean
}) {
  return (
    <div
      className="group relative aspect-square w-full overflow-hidden rounded-2xl border border-slate-200 bg-slate-100 shadow-sm transition-all hover:shadow-md"
      style={captureAspectRatioStyle(framing)}
    >
      <GalleryThumbnail
        source={photo.previewUrl}
        fallback={photo.thumbnailData}
        filePath={photo.filePath}
        previewKey={`gallery-photo-${photo.id}`}
        alt={photo.fileName}
        framing={framing}
      />

      {/* Hover overlay */}
      <div className="absolute inset-0 bg-slate-900/85 backdrop-blur-sm opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-all flex flex-col items-center justify-center gap-2.5 p-4 duration-200 z-20">
        <p className="text-white text-[11px] font-mono font-medium truncate w-full text-center mb-1 bg-black/40 px-2 py-1 rounded border border-white/10">{photo.fileName}</p>

        <button
          onClick={onOpen}
          className="w-full bg-white text-slate-900 hover:bg-slate-100 font-extrabold text-[10px] uppercase tracking-widest py-2 rounded-lg flex items-center justify-center gap-1.5 transition-colors shadow-sm"
        >
          <ExternalLink className="size-3.5" /> Open
        </button>

        <div className="grid grid-cols-2 gap-2 w-full">
          <button
            onClick={onReassign}
            className="w-full bg-white/10 text-white hover:bg-white/20 font-extrabold text-[10px] uppercase tracking-widest py-2 rounded-lg transition-colors border border-white/10"
          >
            Reassign
          </button>
          <button
            onClick={onDelete}
            className="w-full bg-red-500/80 text-white hover:bg-red-500 font-extrabold text-[10px] uppercase tracking-widest py-2 rounded-lg transition-colors border border-red-500/30"
          >
            Delete
          </button>
        </div>

        {uploadStatus?.uploadStatus === 'error' && (
          <button
            onClick={onRetry}
            disabled={retrying}
            className="w-full text-white text-[10px] font-extrabold uppercase tracking-widest bg-red-600 hover:bg-red-700 disabled:opacity-60 rounded-lg py-2 flex items-center justify-center gap-1 mt-1 shadow-sm"
          >
            {retrying && <Loader className="size-3 animate-spin" />}
            {retrying ? 'Retrying…' : 'Retry upload'}
          </button>
        )}
        {uploadStatus?.uploadStatus === 'done' && uploadStatus.fileUrl && (
          <a
            href={uploadStatus.fileUrl}
            download={photo.fileName}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full text-teal-900 text-[10px] font-extrabold uppercase tracking-widest bg-teal-100 hover:bg-teal-200 rounded-lg py-2 flex items-center justify-center gap-1 mt-1 shadow-sm transition-colors"
            title="Download uploaded photo"
          >
            <Download className="size-3.5" /> Download
          </a>
        )}
      </div>

      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-3 pt-6 z-0 pointer-events-none">
        <p className="text-white text-[10px] font-mono font-medium truncate">{photo.fileName}</p>
      </div>
    </div>
  )
}

function QrMarkerTile({
  marker,
  onOpen,
}: {
  marker: {
    id: number
    fileName: string
    filePath: string
    thumbnailData: string | null
    previewUrl?: string
  }
  onOpen: () => void
}) {
  return (
    <div className="group relative bg-slate-100 rounded-2xl overflow-hidden aspect-square border border-slate-200 shadow-sm transition-all hover:shadow-md h-full w-full">
        <GalleryThumbnail
          source={marker.previewUrl}
          fallback={marker.thumbnailData}
          filePath={marker.filePath}
          previewKey={`gallery-marker-${marker.id}`}
          alt={`QR marker ${marker.fileName}`}
        />

      <div className="absolute top-2 left-2 rounded bg-teal-600/90 px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-widest text-white shadow-sm border border-teal-500/50 backdrop-blur-sm z-10">
        QR MARKER
      </div>

      <div className="absolute inset-0 bg-slate-900/85 backdrop-blur-sm opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-all flex items-center justify-center p-4 z-20">
        <button
          type="button"
          onClick={onOpen}
          className="w-full bg-white text-slate-900 hover:bg-slate-100 font-extrabold text-[10px] uppercase tracking-widest py-2.5 rounded-lg flex items-center justify-center gap-1.5 transition-colors shadow-sm"
        >
          <ExternalLink className="size-3.5" /> Open Marker
        </button>
      </div>

      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-3 pt-6 z-0 pointer-events-none">
        <p className="text-white text-[10px] font-mono font-medium truncate">{marker.fileName}</p>
      </div>
    </div>
  )
}

function CaptureTile({
  capture,
  uploadStatus,
  onOpen,
  onDelete,
  onReassign,
  onRetry,
  retrying,
  onRetryFile,
  retryingFileId,
  onUpdateReview,
}: {
  capture: CaptureReview
  uploadStatus?: ProjectUploadStatusRow
  onOpen: () => void
  onDelete?: () => void
  onReassign?: () => void
  onRetry?: () => void
  retrying: boolean
  onRetryFile?: (fileId: number) => void
  retryingFileId?: number | null
  onUpdateReview?: (captureId: number, values: { favorite?: boolean; rejected?: boolean; selected?: boolean }) => void
}) {
  const [zoomOpen, setZoomOpen] = useState(false)
  const [zoom, setZoom] = useState(1)
  const photo = capture.legacyPhoto
  const rawFile = capture.files.find((file) => file.fileRole === 'RAW')
  const zoomSource = photo?.previewUrl ?? photo?.thumbnailData ?? undefined

  useEffect(() => {
    if (!zoomOpen) return
    const handleZoomKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setZoomOpen(false)
    }
    window.addEventListener('keydown', handleZoomKeyDown)
    return () => window.removeEventListener('keydown', handleZoomKeyDown)
  }, [zoomOpen])

  if (photo) {
    return (
      <div className="group relative flex w-full flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition-shadow hover:shadow-md">
        <PhotoTile
          photo={photo}
          framing={capture.framing}
          uploadStatus={uploadStatus}
          onOpen={onOpen}
          onDelete={onDelete!}
          onReassign={onReassign!}
          onRetry={onRetry!}
          retrying={retrying}
        />
        <div className="absolute top-2 left-2 z-10 pointer-events-none">
          <CaptureCompleteness capture={capture} />
        </div>
        <CaptureUploadBadge capture={capture} />
        <CaptureReviewControls capture={capture} onUpdateReview={onUpdateReview} />
        {zoomSource && (
          <button
            type="button"
            onClick={() => { setZoom(1); setZoomOpen(true) }}
            className="absolute right-2 top-2 z-30 rounded-lg bg-black/70 px-2.5 py-1.5 text-[10px] font-extrabold uppercase tracking-wider text-white opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
          >
            Inspect & zoom
          </button>
        )}
        {zoomOpen && zoomSource && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Inspect ${capture.baseFilename}`}
            className="fixed inset-0 z-[100] flex flex-col bg-black/95"
            onClick={() => setZoomOpen(false)}
          >
            <div className="flex items-center justify-between border-b border-white/15 px-5 py-3 text-white" onClick={(event) => event.stopPropagation()}>
              <span className="text-sm font-bold">{capture.baseFilename}</span>
              <div className="flex items-center gap-2">
                <button type="button" className="rounded-lg bg-white/10 px-3 py-2 text-sm font-bold hover:bg-white/20" onClick={() => setZoom(value => Math.max(0.5, value - 0.25))}>− Zoom out</button>
                <span className="w-14 text-center text-xs font-bold">{Math.round(zoom * 100)}%</span>
                <button type="button" className="rounded-lg bg-white/10 px-3 py-2 text-sm font-bold hover:bg-white/20" onClick={() => setZoom(value => Math.min(4, value + 0.25))}>+ Zoom in</button>
                <button type="button" className="rounded-lg bg-white px-3 py-2 text-sm font-bold text-slate-900" onClick={() => setZoomOpen(false)}>Close</button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-6" onClick={(event) => event.stopPropagation()}>
              <div className="flex min-h-full min-w-full items-center justify-center">
                <img src={zoomSource} alt={capture.baseFilename} draggable={false} style={{ transform: `scale(${zoom})` }} className="max-h-[78vh] max-w-[90vw] origin-center object-contain transition-transform" />
              </div>
            </div>
          </div>
        )}

        {rawFile?.uploadStatus === 'error' && onRetryFile && (
          <button
            type="button"
            onClick={() => onRetryFile(rawFile.id)}
            disabled={retryingFileId === rawFile.id}
            className="absolute bottom-10 right-2 z-30 rounded-lg bg-red-600 px-2 py-1 text-[9px] font-extrabold uppercase tracking-widest text-white opacity-0 transition-opacity group-hover:opacity-100 disabled:opacity-60 shadow-sm"
          >
            {retryingFileId === rawFile.id ? 'Retrying…' : 'Retry RAW'}
          </button>
        )}
      </div>
    )
  }

  return (
    <div
      className="group relative bg-slate-100 rounded-2xl overflow-hidden aspect-square border border-slate-200 shadow-sm transition-all hover:shadow-md h-full w-full"
      style={captureAspectRatioStyle(capture.framing)}
    >
      <div className="w-full h-full flex flex-col items-center justify-center gap-3 text-slate-400 bg-white">
        <div className="w-16 h-16 rounded-2xl bg-slate-50 flex flex-col items-center justify-center border border-slate-100 shadow-inner">
          <Image className="size-6 mb-1 text-slate-300" />
          <span className="text-[9px] font-extrabold tracking-widest uppercase text-slate-400">{capture.files[0]?.fileFormat ?? 'RAW'}</span>
        </div>
        <span className="text-[10px] font-bold tracking-widest uppercase">RAW Original</span>
      </div>

      <div className="absolute top-2 left-2 z-10 pointer-events-none">
        <CaptureCompleteness capture={capture} />
      </div>
      <CaptureUploadBadge capture={capture} />
      <CaptureReviewControls capture={capture} onUpdateReview={onUpdateReview} />

      <div className="absolute inset-0 bg-slate-900/85 backdrop-blur-sm opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-all flex flex-col items-center justify-center gap-3 p-4 z-20">
        <p className="text-center text-[10px] font-bold uppercase tracking-widest text-white/80 bg-black/40 px-3 py-1.5 rounded-lg border border-white/10 mb-2 leading-relaxed">
          RAW recorded without JPEG
        </p>

        {rawFile && (
          <button
            type="button"
            onClick={onOpen}
            className="w-full bg-white text-slate-900 hover:bg-slate-100 font-extrabold text-[10px] uppercase tracking-widest py-2.5 rounded-lg flex items-center justify-center gap-1.5 transition-colors shadow-sm"
          >
            <ExternalLink className="size-3.5" /> Open RAW
          </button>
        )}

        {rawFile?.uploadStatus === 'error' && onRetryFile && (
          <button
            type="button"
            onClick={() => onRetryFile(rawFile.id)}
            disabled={retryingFileId === rawFile.id}
            className="w-full bg-red-600 text-white hover:bg-red-700 disabled:opacity-60 font-extrabold text-[10px] uppercase tracking-widest py-2.5 rounded-lg transition-colors shadow-sm mt-1"
          >
            {retryingFileId === rawFile.id ? 'Retrying…' : 'Retry RAW Upload'}
          </button>
        )}
      </div>

      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-3 pt-6 z-0 pointer-events-none">
        <p className="text-white text-[10px] font-mono font-medium truncate">{capture.baseFilename}</p>
      </div>
    </div>
  )
}

function CaptureReviewControls({
  capture,
  onUpdateReview,
}: {
  capture: CaptureReview
  onUpdateReview?: (captureId: number, values: {
    favorite?: boolean
    rejected?: boolean
    selected?: boolean
    rating?: number
    colorLabel?: CaptureReview['colorLabel']
  }) => void
}) {
  if (!onUpdateReview) return null
  const colors = [
    ['red', 'bg-red-500'],
    ['yellow', 'bg-yellow-400'],
    ['green', 'bg-emerald-500'],
    ['blue', 'bg-blue-500'],
    ['purple', 'bg-purple-500'],
  ] as const
  return (
    <div className="relative z-30 flex flex-col gap-2 border-t border-slate-200 bg-white p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-[10px] font-extrabold uppercase tracking-wider text-slate-700">Parent gallery</p>
          <p className={cn(
            "text-[10px] font-semibold",
            capture.rating > 0 ? "text-teal-700" : "text-slate-400",
          )}>
            {capture.rating > 0
              ? `Shared · ${capture.rating} star${capture.rating === 1 ? '' : 's'}`
              : capture.rejected
                ? 'Not shared · reviewed'
                : 'Not reviewed · choose 1–5 stars'}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {capture.rating <= 0 && (
            <button
              type="button"
              onClick={() => onUpdateReview(capture.id, {
                rating: 0,
                favorite: false,
                selected: false,
                rejected: !capture.rejected,
              })}
              className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-[10px] font-extrabold uppercase tracking-wider text-slate-600 transition-colors hover:bg-slate-200"
            >
              {capture.rejected ? 'Review again' : 'Do not share'}
            </button>
          )}
          <button
            type="button"
            onClick={() => onUpdateReview(capture.id, {
              rating: capture.rating > 0 ? 0 : 5,
              favorite: capture.rating <= 0,
              selected: capture.rating <= 0,
              rejected: capture.rating > 0,
            })}
            className={cn(
              "rounded-lg px-2.5 py-1.5 text-[10px] font-extrabold uppercase tracking-wider transition-colors",
              capture.rating > 0
                ? "bg-teal-100 text-teal-800 hover:bg-teal-200"
                : "bg-blue-600 text-white hover:bg-blue-700",
            )}
          >
            {capture.rating > 0 ? 'Remove' : 'Share'}
          </button>
        </div>
      </div>
      <div className="flex items-center justify-center gap-1 rounded-lg border border-amber-200 bg-amber-50 px-2 py-2">
        {[1, 2, 3, 4, 5].map((rating) => (
          <button
            key={rating}
            type="button"
            aria-label={`Rate ${rating} star${rating === 1 ? '' : 's'}`}
            onClick={() => onUpdateReview(capture.id, {
              rating: capture.rating === rating ? 0 : rating,
              favorite: rating >= 4,
              selected: capture.rating !== rating,
              rejected: false,
            })}
            className="p-1.5 text-amber-500 hover:text-amber-600"
          >
            <Star className="size-5" fill={capture.rating >= rating ? 'currentColor' : 'none'} />
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-amber-200" />
        {colors.map(([label, color]) => (
          <button
            key={label}
            type="button"
            aria-label={`${label} color label${label === 'green' ? ' — share with parents' : ''}`}
            title={label === 'green' ? 'Green — share with parents' : `${label} label`}
            onClick={() => onUpdateReview(capture.id, {
              colorLabel: capture.colorLabel === label ? 'none' : label,
              selected: label === 'green' ? capture.colorLabel !== 'green' : capture.selected,
              rejected: false,
            })}
            className={cn(
              'size-5 rounded-full border-2 transition-transform hover:scale-110',
              color,
              capture.colorLabel === label ? 'border-white ring-2 ring-white/70' : 'border-black/30',
            )}
          />
        ))}
      </div>
      <button
        type="button"
        aria-label={capture.rejected ? 'Restore capture' : 'Reject capture'}
        title={capture.rejected ? 'Restore capture' : 'Reject capture'}
        onClick={() => onUpdateReview(capture.id, { rejected: !capture.rejected, selected: false })}
        className={cn(
          'self-start rounded-full p-2 shadow-sm transition-colors border',
          capture.rejected
            ? 'border-red-300 bg-red-100 text-red-700'
            : 'border-white/20 bg-black/60 backdrop-blur-md text-white hover:bg-black/80 hover:border-white/40',
        )}
      >
        <XCircle className="size-3.5" />
      </button>
    </div>
  )
}

function CaptureUploadBadge({ capture }: { capture: CaptureReview }) {
  const statuses = capture.files
    .map((file) => file.uploadStatus)
    .filter((status): status is UploadStatus => Boolean(status))
  if (statuses.length === 0) return null
  const status = statuses.includes('error')
    ? 'error'
    : statuses.includes('uploading')
      ? 'uploading'
      : statuses.includes('pending')
        ? 'pending'
        : 'done'
  const meta = getUploadStatusMeta(status)
  const StatusIcon = meta.icon
  return (
    <span
      className={cn(
        'absolute top-2 right-2 z-10 flex items-center justify-center rounded-full p-1.5 shadow-sm border backdrop-blur-md',
        meta.badgeClass,
      )}
      title={`Capture upload: ${meta.label}`}
    >
      <StatusIcon className={cn('size-3.5', meta.iconClass)} />
      <span className="sr-only">{meta.label}</span>
    </span>
  )
}

function getUploadStatusMeta(status: UploadStatus | undefined) {
  switch (status) {
    case 'pending':
      return {
        label: 'Waiting for upload',
        icon: Upload,
        badgeClass: 'bg-black/60 border-white/10',
        iconClass: 'text-amber-400',
        textClass: 'text-amber-200',
      }
    case 'uploading':
      return {
        label: 'Uploading…',
        icon: Loader,
        badgeClass: 'bg-black/60 border-white/10',
        iconClass: 'text-blue-400 animate-spin',
        textClass: 'text-blue-200',
      }
    case 'done':
      return {
        label: 'Uploaded',
        icon: CheckCircle,
        badgeClass: 'bg-black/60 border-white/10',
        iconClass: 'text-green-400',
        textClass: 'text-green-200',
      }
    case 'error':
      return {
        label: 'Upload failed',
        icon: XCircle,
        badgeClass: 'bg-red-500/90 border-red-400',
        iconClass: 'text-white',
        textClass: 'text-white',
      }
    default:
      return {
        label: 'Not uploaded',
        icon: CloudUpload,
        badgeClass: 'bg-black/60 border-white/10',
        iconClass: 'text-white/60',
        textClass: 'text-white/60',
      }
  }
}

function ReassignDialog({
  photo,
  projectId,
  onClose,
  onDone,
}: {
  photo: Photo
  projectId: number
  onClose: () => void
  onDone: () => void
}) {
  const { data: students, loading } = useStudents(projectId)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')

  const filtered = students.filter((s) => {
    const q = search.toLowerCase()
    return (
      s.firstName.toLowerCase().includes(q) ||
      s.lastName.toLowerCase().includes(q) ||
      s.generatedStudentId.toLowerCase().includes(q)
    )
  })

  async function handleSave() {
    if (!selectedId) return
    setSaving(true)
    try {
      await window.api.invoke('photos:reassign', { photoId: photo.id, studentId: selectedId })
      addToast({ type: 'success', title: 'Photo reassigned' })
      onDone()
    } catch (e) {
      addToast({ type: 'error', title: 'Reassign failed', description: String(e) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open title="Reassign Photo" onClose={onClose} className="max-w-md">
      <div className="space-y-4 mt-2">
        <p className="text-sm font-medium text-slate-500">
          Select the correct subject for this photo:
        </p>
        <div className="relative">
          <Search className="absolute left-3 top-3 size-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search roster…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2.5 text-sm font-medium border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500 shadow-sm"
          />
        </div>
        <div className="h-64 overflow-y-auto border border-slate-200 rounded-xl bg-slate-50 p-1.5 shadow-inner">
          {filtered.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelectedId(s.id)}
              className={cn(
                'w-full px-3 py-2.5 text-left text-sm rounded-lg transition-colors flex items-center justify-between mb-1 last:mb-0',
                selectedId === s.id ? 'bg-teal-100 text-teal-900 border border-teal-200 shadow-sm' : 'text-slate-700 hover:bg-white border border-transparent'
              )}
            >
              <span className="font-bold truncate mr-2">
                {s.lastName}, {s.firstName}
              </span>
              <span className="font-mono text-[11px] font-medium text-slate-500 bg-white px-2 py-0.5 rounded border border-slate-200 shrink-0">
                {s.generatedStudentId}
              </span>
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="h-full flex items-center justify-center text-xs font-bold uppercase tracking-wider text-slate-400">
              No subjects found
            </div>
          )}
        </div>
        <div className="flex gap-3 justify-end pt-2">
          <Button variant="outline" onClick={onClose} className="text-xs font-bold uppercase tracking-wider h-10 px-5">
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!selectedId || saving} className="bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold uppercase tracking-wider h-10 px-5 shadow-sm">
            {saving ? <Loader className="size-4 animate-spin mr-2" /> : null}
            {saving ? 'Saving…' : 'Reassign'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
