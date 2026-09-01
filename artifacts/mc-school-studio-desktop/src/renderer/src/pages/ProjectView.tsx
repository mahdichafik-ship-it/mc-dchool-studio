import React, { useState, useEffect, useRef } from 'react'
import {
  ArrowLeft,
  Folder,
  Play,
  Square,
  Search,
  Image,
  User,
  ChevronRight,
  Camera,
  AlertCircle,
  ExternalLink,
  Download,
  Upload,
  CloudUpload,
  CheckCircle,
  XCircle,
  Loader,
  RefreshCw,
  Star,
  Check,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import {
  useProject,
  useClasses,
  useStudents,
  useCaptures,
  useCaptureSummary,
  useUnmatchedPhotos,
  useWatcherStatus,
  useActiveCaptureTarget,
  useUploadStatus,
} from '@/hooks/useApi'
import { addToast } from '@/components/ui/toast'
import {
  decodeResizedPreview,
  previewScheduler,
  waitForPaintFrames,
} from '@/lib/previewScheduler'
import type {
  Student,
  Class,
  Photo,
  CaptureReview,
  StudentUploadSummary,
  ProjectUploadStatusRow,
  UploadStatus,
  CaptureExportMode,
  ProjectSyncProgressEvent,
} from '@/hooks/useApi'

interface Props {
  projectId: number
  onBack: () => void
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

export function ProjectView({ projectId, onBack, offline = false }: Props) {
  const { data: project, reload: reloadProject } = useProject(projectId)
  const { data: captureSummary } = useCaptureSummary(projectId)
  const { data: classes } = useClasses(projectId)
  const [selectedClassId, setSelectedClassId] = useState<number | null>(null)
  const { data: students, reload: reloadStudents } = useStudents(projectId, selectedClassId ?? undefined)
  const {
    data: unmatchedPhotos,
    loading: unmatchedLoading,
    reload: reloadUnmatchedPhotos,
  } = useUnmatchedPhotos(projectId)
  const [selectedStudent, setSelectedStudent] = useState<Student | null>(null)
  const { isRunning, start: startWatcher, stop: stopWatcher } = useWatcherStatus(projectId)
  const {
    studentId: activeStudentId,
    source: activeStudentSource,
    setTarget: setActiveCaptureTarget,
  } = useActiveCaptureTarget(projectId)
  const { statusMap: uploadStatusMap, photoStatusMap, errorPhotoIds, reload: reloadUploadStatus } = useUploadStatus(projectId)
  const [search, setSearch] = useState('')
  const [settingFolder, setSettingFolder] = useState(false)
  const [reassignDialogPhoto, setReassignDialogPhoto] = useState<Photo | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [exportMode, setExportMode] = useState<CaptureExportMode>('all')
  const [exporting, setExporting] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [syncProgress, setSyncProgress] = useState<ProjectSyncProgressEvent | null>(null)
  const pendingUploadCount = [...uploadStatusMap.values()]
    .reduce((count, summary) => count + summary.pending + summary.uploading, 0)

  useEffect(() => {
    return window.api.on('project:syncProgress', (event) => {
      if (event.projectId === projectId) setSyncProgress(event)
    })
  }, [projectId])

  // Closing the project ends the capture session. The native stop handler
  // drains any queued files before clearing the active student target.
  useEffect(() => {
    return () => {
      void stopWatcher()
    }
  }, [stopWatcher])

  // Re-select the student when students refresh (to get updated photoCount)
  useEffect(() => {
    if (selectedStudent) {
      const refreshed = students.find((s) => s.id === selectedStudent.id)
      if (refreshed) setSelectedStudent(refreshed)
    }
  }, [students])

  useEffect(() => {
    if (activeStudentId === null) return
    const activeStudent = students.find((student) => student.id === activeStudentId)
    if (activeStudent) setSelectedStudent(activeStudent)
  }, [activeStudentId, students])

  async function handleSelectCaptureStudent(student: Student) {
    setSelectedStudent(student)
    try {
      await setActiveCaptureTarget(student.id)
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

  async function handleSetWatchFolder() {
    const folder = await window.api.invoke('dialog:openFolder') as string | null
    if (!folder) return
    await window.api.invoke('projects:setWatchFolder', { projectId, folderPath: folder })
    reloadProject()
    addToast({ type: 'success', title: 'Watch folder set', description: folder })
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

  async function handleExportCaptures() {
    const destinationDir = await window.api.invoke('dialog:openFolder') as string | null
    if (!destinationDir) return
    setExporting(true)
    try {
      const result = await window.api.invoke('captures:export', {
        projectId,
        destinationDir,
        mode: exportMode,
      })
      if (!result.ok) {
        addToast({ type: 'error', title: 'Export failed', description: result.error })
        return
      }
      addToast({
        type: 'success',
        title: 'Capture export complete',
        description: `${result.exportedFileCount ?? 0} file${result.exportedFileCount === 1 ? '' : 's'} from ${result.exportedCaptureCount ?? 0} capture${result.exportedCaptureCount === 1 ? '' : 's'} exported`,
      })
    } catch (error) {
      addToast({ type: 'error', title: 'Export failed', description: String(error) })
    } finally {
      setExporting(false)
    }
  }

  async function handleUploadAndFinish() {
    if (!project || project.finishedAt || finishing) return
    setFinishing(true)
    setSyncProgress({
      projectId,
      phase: 'syncing',
      completed: 0,
      total: 0,
      failed: 0,
    })
    try {
      const result = await window.api.invoke('project:uploadAndFinish', { projectId })
      await reloadProject()
      await reloadUploadStatus()
      if (result.ok) {
        addToast({
          type: 'success',
          title: 'Project uploaded and finished',
          description: `${result.completed} local file${result.completed === 1 ? '' : 's'} synchronized successfully`,
        })
      } else {
        addToast({
          type: 'error',
          title: 'Project remains unfinished',
          description: result.error ?? 'Some local files could not be synchronized.',
        })
      }
    } catch (error) {
      addToast({ type: 'error', title: 'Could not finish project', description: String(error) })
    } finally {
      setFinishing(false)
    }
  }

  const filteredStudents = students.filter((s) => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      s.firstName.toLowerCase().includes(q) ||
      s.lastName.toLowerCase().includes(q) ||
      s.generatedStudentId.toLowerCase().includes(q)
    )
  })

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="bg-white border-b border-slate-200 px-6 py-3 flex items-center gap-4">
        <button onClick={onBack} className="text-slate-400 hover:text-slate-700 transition-colors">
          <ArrowLeft className="size-5" />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="font-bold text-slate-900 truncate">{project?.schoolName ?? '…'}</h1>
          <p className="text-xs text-slate-500">
            {project?.classCount} classes · {project?.studentCount} students · {
              captureSummary.total > 0
                ? `${captureSummary.total} captures`
                : `${project?.photoCount ?? 0} photos taken`
            }
          </p>
          {captureSummary.total > 0 && (
            <p className="mt-0.5 text-[11px] text-slate-400">
              {captureSummary.complete} paired · {captureSummary.jpegOnly} JPEG only · {captureSummary.rawOnly} RAW only
            </p>
          )}
           {pendingUploadCount > 0 && (
             <p className="mt-1 flex items-center gap-1 text-xs text-amber-700">
               <Upload className="size-3" />
               {pendingUploadCount} photo{pendingUploadCount === 1 ? '' : 's'} waiting for upload
             </p>
           )}
            {project?.finishedAt ? (
              <p className="mt-1 flex items-center gap-1 text-xs text-green-700">
                <CheckCircle className="size-3" />
                Project finished · local capture is closed
              </p>
            ) : (
              <p className="mt-1 flex items-center gap-1 text-xs text-slate-500">
                <Folder className="size-3" />
                Local capture is live · upload starts only when you finish the project
              </p>
            )}
            {syncProgress?.phase === 'error' && (
              <p className="mt-1 flex items-center gap-1 text-xs text-red-700">
                <AlertCircle className="size-3" />
                {syncProgress.failed} file{syncProgress.failed === 1 ? '' : 's'} failed · local project remains unfinished
              </p>
            )}
        </div>

        {/* Watch folder controls */}
        <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              onClick={() => void handleUploadAndFinish()}
              disabled={finishing || Boolean(project?.finishedAt) || captureSummary.total === 0}
              className={cn(
                'gap-1.5',
                project?.finishedAt
                  ? 'bg-green-600 hover:bg-green-600'
                  : 'bg-teal-600 hover:bg-teal-700',
              )}
              title={
                project?.finishedAt
                  ? 'This project has already been finished'
                  : 'Stop local capture, upload the local project, and finish it'
              }
            >
              {finishing ? (
                <Loader className="size-3.5 animate-spin" />
              ) : project?.finishedAt ? (
                <CheckCircle className="size-3.5" />
              ) : (
                <CloudUpload className="size-3.5" />
              )}
              {finishing
                ? syncProgress && syncProgress.total > 0
                  ? `Uploading ${syncProgress.completed}/${syncProgress.total}`
                  : 'Preparing…'
                : project?.finishedAt
                  ? 'Project finished'
                  : syncProgress?.phase === 'error'
                    ? 'Retry Upload & Finish'
                    : 'Upload & Finish Project'}
            </Button>
           {captureSummary.total > 0 && (
             <div className="flex items-center gap-1.5">
               <select
                 value={exportMode}
                 onChange={(event) => setExportMode(event.target.value as CaptureExportMode)}
                 className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-teal-500"
                 aria-label="Capture export mode"
               >
                 <option value="all">Export all captures</option>
                 <option value="paired">Export paired JPEG + RAW</option>
                 <option value="jpeg_only">Export JPEG-only</option>
                 <option value="raw_only">Export RAW-only</option>
                 <option value="selected">Export selected</option>
                 <option value="favorite">Export favorites</option>
                 <option value="final_selection">Export final selection</option>
               </select>
               <Button variant="outline" size="sm" onClick={handleExportCaptures} disabled={exporting}>
                 {exporting ? <Loader className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                 {exporting ? 'Exporting…' : 'Export'}
               </Button>
             </div>
           )}
          {project?.watchFolder ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500 max-w-[200px] truncate hidden lg:block">
                {project.watchFolder}
              </span>
              <Button variant="outline" size="sm" onClick={handleSetWatchFolder}>
                <Folder className="size-3.5" />
                Change folder
              </Button>
              <Button
                size="sm"
                variant={isRunning ? 'destructive' : 'default'}
                onClick={handleToggleWatcher}
                className="gap-1.5"
              >
                {isRunning ? (
                  <><Square className="size-3" fill="currentColor" /> Stop watching</>
                ) : (
                  <><Play className="size-3" fill="currentColor" /> Start watching</>
                )}
              </Button>
              {isRunning && (
                <span className="flex items-center gap-1 text-xs text-green-600 font-medium">
                  <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                  Live
                </span>
              )}
            </div>
          ) : (
            <Button variant="outline" size="sm" onClick={handleSetWatchFolder}>
              <Folder className="size-3.5" />
              Set watch folder
            </Button>
          )}
        </div>
      </div>

      {/* Body: split panel */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left panel: classes + students */}
        <div className="w-72 flex-shrink-0 border-r border-slate-200 bg-white flex flex-col overflow-hidden">
          {/* Class tabs */}
          <div className="flex overflow-x-auto border-b border-slate-100 shrink-0">
            <button
              onClick={() => setSelectedClassId(null)}
              className={cn(
                'px-3 py-2 text-xs font-medium whitespace-nowrap border-b-2 transition-colors',
                !selectedClassId
                  ? 'border-teal-500 text-teal-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700',
              )}
            >
              All ({students.length})
            </button>
            {classes.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelectedClassId(c.id)}
                className={cn(
                  'px-3 py-2 text-xs font-medium whitespace-nowrap border-b-2 transition-colors',
                  selectedClassId === c.id
                    ? 'border-teal-500 text-teal-600'
                    : 'border-transparent text-slate-500 hover:text-slate-700',
                )}
              >
                {c.className}
              </button>
            ))}
          </div>

          {/* Search */}
          <div className="px-3 py-2 border-b border-slate-100">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 size-3.5 text-slate-400" />
              <input
                type="text"
                placeholder="Search students…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-200 rounded-md bg-slate-50 focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
            </div>
          </div>

          {/* Retry failed uploads button */}
          {errorPhotoIds.length > 0 && (
            <div className="px-3 py-2 border-b border-red-100 bg-red-50">
              <button
                onClick={handleRetryFailed}
                disabled={retrying}
                className="w-full flex items-center justify-center gap-1.5 text-xs font-medium text-red-700 bg-red-100 hover:bg-red-200 disabled:opacity-60 rounded-md px-2 py-1.5 transition-colors"
              >
                {retrying ? (
                  <Loader className="size-3 animate-spin" />
                ) : (
                  <RefreshCw className="size-3" />
                )}
                {retrying
                  ? 'Retrying…'
                  : `Retry ${errorPhotoIds.length} failed upload${errorPhotoIds.length !== 1 ? 's' : ''}`}
              </button>
            </div>
          )}

          {/* Student list */}
          <div className="flex-1 overflow-y-auto">
            {filteredStudents.map((s) => (
              <StudentRow
                key={s.id}
                student={s}
                isSelected={selectedStudent?.id === s.id}
                isActive={activeStudentId === s.id}
                onClick={() => void handleSelectCaptureStudent(s)}
                uploadSummary={uploadStatusMap.get(s.id)}
              />
            ))}
            {filteredStudents.length === 0 && (
              <div className="text-center text-slate-400 text-xs py-8">No students found</div>
            )}
          </div>
        </div>

        {/* Right panel: QR code + photos */}
        <div className="flex-1 overflow-y-auto bg-slate-50">
          {selectedStudent ? (
            <StudentDetail
              student={selectedStudent}
              projectId={projectId}
              photoStatusMap={photoStatusMap}
              onReassign={() => reloadStudents()}
              isActiveCaptureTarget={activeStudentId === selectedStudent.id}
              activeStudentSource={activeStudentSource}
              onClearCaptureTarget={() => void handleClearCaptureStudent()}
              offline={offline}
            />
          ) : unmatchedPhotos.length > 0 ? (
            <UnmatchedPhotosPanel
              photos={unmatchedPhotos}
              loading={unmatchedLoading}
              onOpen={(filePath) => window.api.invoke('photos:openInSystem', { filePath })}
              onReassign={setReassignDialogPhoto}
            />
          ) : unmatchedPhotos.length > 0 ? (
            <UnmatchedPhotosPanel
              photos={unmatchedPhotos}
              loading={unmatchedLoading}
              onOpen={(filePath) => window.api.invoke('photos:openInSystem', { filePath })}
              onReassign={setReassignDialogPhoto}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-center p-8">
              <div className="w-20 h-20 rounded-2xl bg-slate-200 flex items-center justify-center mb-4">
                <User className="size-10 text-slate-400" />
              </div>
              <h3 className="font-semibold text-slate-600 mb-1">No student selected</h3>
              <p className="text-sm text-slate-400 max-w-xs">
                Click a student on the left to display their QR code for the photographer.
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
    </div>
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
    <div className="p-8">
      <div className="mb-5">
        <h2 className="text-lg font-bold text-slate-900">Photos needing assignment</h2>
        <p className="mt-1 text-sm text-slate-500">
          These captures were saved, but no student QR or filename match was found. Assign them manually or photograph the student QR before the next portraits.
        </p>
      </div>
      {loading ? (
        <div className="flex h-40 items-center justify-center text-sm text-slate-400">
          <Loader className="mr-2 size-4 animate-spin" /> Loading captures…
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {photos.map((photo) => (
            <div key={photo.id} className="overflow-hidden rounded-lg border border-amber-200 bg-white">
              <div className="aspect-square bg-slate-100">
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
              </div>
              <div className="space-y-2 p-2">
                <p className="truncate text-[11px] text-slate-600" title={photo.fileName}>
                  {photo.fileName}
                </p>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => void onOpen(photo.filePath)}
                    className="rounded bg-slate-100 px-2 py-1.5 text-xs text-slate-700 hover:bg-slate-200"
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    onClick={() => onReassign(photo)}
                    className="rounded bg-teal-600 px-2 py-1.5 text-xs font-medium text-white hover:bg-teal-700"
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
  )
}

function UploadBadge({ summary }: { summary: StudentUploadSummary }) {
  if (summary.uploading > 0) {
    return (
      <span title="Uploading…" className="flex items-center gap-0.5 text-[10px] text-blue-600">
        <Loader className="size-3 animate-spin" />
      </span>
    )
  }
  if (summary.error > 0) {
    return (
      <span title={`${summary.error} upload(s) failed`} className="flex items-center gap-0.5 text-[10px] text-red-500">
        <XCircle className="size-3" />
      </span>
    )
  }
  if (summary.pending > 0) {
    return (
      <span title={`${summary.pending} upload(s) queued`} className="flex items-center gap-0.5 text-[10px] text-amber-500">
        <Upload className="size-3" />
      </span>
    )
  }
  if (summary.done > 0) {
    return (
      <span title={`${summary.done} photo(s) uploaded`} className="flex items-center gap-0.5 text-[10px] text-green-600">
        <CheckCircle className="size-3" />
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
  uploadSummary,
}: {
  student: Student
  isSelected: boolean
  isActive: boolean
  onClick: () => void
  uploadSummary?: StudentUploadSummary
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full px-3 py-2.5 text-left flex items-center gap-2 transition-colors border-b border-slate-50',
        isActive
          ? 'bg-blue-100 border-l-4 border-l-blue-600 ring-1 ring-inset ring-blue-200'
          : isSelected
            ? 'bg-slate-100 border-l-2 border-l-slate-400'
          : 'hover:bg-slate-50',
      )}
      aria-pressed={isActive}
      title={isActive ? 'Active capture student' : 'Select as active capture student'}
    >
      <div className="flex-1 min-w-0">
        <p className={cn('text-sm font-medium truncate', isActive ? 'text-blue-800' : 'text-slate-800')}>
          {s.lastName}, {s.firstName}
        </p>
        <p className={cn('text-xs font-mono', isActive ? 'text-blue-600' : 'text-slate-400')}>
          {s.generatedStudentId}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {isActive && (
          <Badge className="border-blue-200 bg-blue-600 text-[9px] text-white">
            <Camera className="mr-0.5 size-2.5" />
            ACTIVE
          </Badge>
        )}
        {uploadSummary && <UploadBadge summary={uploadSummary} />}
        {s.photoCount > 0 ? (
          <Badge variant="success" className="text-[10px] px-1.5 py-0">
            <Camera className="size-2.5 mr-0.5" />
            {s.photoCount}
          </Badge>
        ) : null}
      </div>
    </button>
  )
}

function StudentDetail({
  student,
  projectId,
  photoStatusMap,
  onReassign,
  isActiveCaptureTarget,
  activeStudentSource,
  onClearCaptureTarget,
  offline,
}: {
  student: Student
  projectId: number
  photoStatusMap: Map<number, ProjectUploadStatusRow>
  onReassign: () => void
  isActiveCaptureTarget: boolean
  activeStudentSource: 'manual' | 'qr' | 'none'
  onClearCaptureTarget: () => void
  offline: boolean
}) {
  const { data: review, reload: reloadCaptures, livePreview } = useCaptures(student.id)
  const captures = review.captures
  const qrMarkers = review.qrMarkers
  const [reassignOpen, setReassignOpen] = useState(false)
  const [reassignPhoto, setReassignPhoto] = useState<Photo | null>(null)
  const [retryingPhotoId, setRetryingPhotoId] = useState<number | null>(null)
  const [retryingFileId, setRetryingFileId] = useState<number | null>(null)
  const [pairingFilter, setPairingFilter] = useState<CaptureFilter>('all')

  const captureCounts = captures.reduce(
    (counts, capture) => {
      counts[capture.pairingStatus]++
      return counts
    },
    { complete: 0, jpeg_only: 0, raw_only: 0, unpaired: 0, pending: 0 } as Record<CaptureReview['pairingStatus'], number>,
  )
  const filteredCaptures = pairingFilter === 'all'
    ? captures
    : captures.filter((capture) => capture.pairingStatus === pairingFilter)

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
    values: { favorite?: boolean; rejected?: boolean; selected?: boolean },
  ) {
    try {
      await window.api.invoke('captures:updateReview', { captureId, ...values })
      await reloadCaptures()
    } catch (error) {
      addToast({ type: 'error', title: 'Could not update capture review', description: String(error) })
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Student info header */}
      <div className="bg-white border-b border-slate-200 px-8 py-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-slate-900">
            {student.firstName} {student.lastName}
          </h2>
          <div className="flex items-center gap-3 mt-1">
            <span className="text-xs font-mono text-slate-500 bg-slate-100 px-2 py-0.5 rounded">
              {student.generatedStudentId}
            </span>
            <span className="text-xs text-slate-500">{student.className}</span>
          </div>
          {isActiveCaptureTarget && (
            <div className="mt-2 flex items-center gap-2 text-xs font-semibold text-blue-700">
              <span className="flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-1">
                <Camera className="size-3.5" />
                Active capture student{activeStudentSource === 'qr' ? ' · selected by QR' : ''}
              </span>
              <span className="font-normal text-blue-600">
                New JPEG and RAW captures will be assigned here
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isActiveCaptureTarget && (
            <Button variant="outline" size="sm" onClick={onClearCaptureTarget}>
              <XCircle className="size-3.5" />
              Clear target
            </Button>
          )}
            {captures.length > 0 || qrMarkers.length > 0 ? (
              <Badge variant="success">
                {captures.length} capture{captures.length !== 1 ? 's' : ''} recorded
                {qrMarkers.length > 0 && ` · ${qrMarkers.length} QR marker${qrMarkers.length !== 1 ? 's' : ''}`}
              </Badge>
          ) : (
            <Badge variant="warning">Not yet photographed</Badge>
          )}
        </div>
      </div>

      <div className="flex gap-8 p-8">
        {/* QR code panel */}
        <div className="flex flex-col items-center">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-3">
            QR Code — show to camera
          </p>
          {student.simpleQr ? (
            <div className="bg-white border-4 border-slate-900 rounded-2xl p-4 shadow-lg">
              <img
                src={student.simpleQr}
                alt="Student QR Code"
                className="w-64 h-64"
                draggable={false}
              />
            </div>
          ) : (
            <div className="w-72 h-72 bg-slate-100 rounded-2xl flex flex-col items-center justify-center border-2 border-dashed border-slate-300">
              <AlertCircle className="size-8 text-slate-400 mb-2" />
              <p className="text-sm text-slate-500 font-medium">QR not generated yet</p>
              <p className="text-xs text-slate-400 mt-1">Generate QR codes in the web app first</p>
            </div>
          )}
          <p className="text-xs text-slate-400 mt-3 font-mono">
            {student.firstName}.{student.lastName}.{student.generatedStudentId}
          </p>
        </div>

        {/* Photo gallery */}
        <div className="flex-1 min-w-0">
          {livePreview?.photo.previewUrl && (
            <LivePreview
              photo={livePreview.photo}
              traceId={livePreview.pipeline?.traceId}
            />
          )}
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-3">
             Capture review ({filteredCaptures.length + qrMarkers.length})
          </p>
          <div className="flex flex-wrap gap-1.5 mb-3">
            {captureFilterOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setPairingFilter(option.value)}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                  pairingFilter === option.value
                    ? 'border-teal-200 bg-teal-50 text-teal-700'
                    : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:text-slate-700',
                )}
              >
                {option.label} ({option.value === 'all' ? captures.length : captureCounts[option.value]})
              </button>
            ))}
          </div>

          {captures.length === 0 && qrMarkers.length === 0 ? (
            <div className="h-40 flex flex-col items-center justify-center border-2 border-dashed border-slate-200 rounded-xl">
              <Image className="size-8 text-slate-300 mb-2" />
              <p className="text-sm text-slate-400">No captures yet</p>
              <p className="text-xs text-slate-400 mt-0.5">
                JPEG and RAW files will appear here automatically when captured
              </p>
            </div>
          ) : filteredCaptures.length === 0 && qrMarkers.length === 0 ? (
            <div className="h-40 flex flex-col items-center justify-center border-2 border-dashed border-slate-200 rounded-xl">
              <AlertCircle className="size-8 text-slate-300 mb-2" />
              <p className="text-sm text-slate-400">No captures match this filter</p>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3">
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

      {/* Reassign dialog */}
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
    </div>
  )
}

function LivePreview({
  photo,
  traceId,
}: {
  photo: Photo
  traceId?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!photo.previewUrl || !traceId) return
    let mounted = true
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
        report('image decode started', 'source=resized-local-url')
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
        context.clearRect(0, 0, canvas.width, canvas.height)
        context.drawImage(bitmap, 0, 0)
        bitmap.close()

        await waitForPaintFrames()
        if (!mounted || signal.aborted) return
        report('image pixels painted', `original=${photo.filePath}`)
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

  return (
    <div className="mb-4 overflow-hidden rounded-xl border border-blue-200 bg-slate-950 shadow-sm">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-blue-200">
          Live preview · latest capture
        </p>
        <span className="text-[10px] text-slate-400">Prioritizing newest image</span>
      </div>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Latest capture ${photo.fileName}`}
        className="block max-h-96 w-full object-contain"
      />
    </div>
  )
}

function GalleryThumbnail({
  source,
  fallback,
  alt,
}: {
  source?: string
  fallback?: string | null
  alt: string
}) {
  const [generatedSource, setGeneratedSource] = useState<string | null>(null)

  useEffect(() => {
    setGeneratedSource(null)
    if (fallback || !source) return
    let mounted = true
    let objectUrl: string | null = null
    const cancel = previewScheduler.enqueue({
      id: `gallery-${source}`,
      priority: 'gallery',
      execute: async (signal) => {
        const bitmap = await decodeResizedPreview(source, 320, signal)
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
  }, [fallback, source])

  const imageSource = fallback ?? generatedSource
  if (!imageSource) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Image className="size-8 text-slate-400" />
      </div>
    )
  }
  return (
    <img
      src={imageSource}
      alt={alt}
      className="h-full w-full object-cover"
      draggable={false}
    />
  )
}

function PhotoTile({
  photo,
  uploadStatus,
  onOpen,
  onDelete,
  onReassign,
  onRetry,
  retrying,
}: {
  photo: Photo
  uploadStatus?: ProjectUploadStatusRow
  onOpen: () => void
  onDelete: () => void
  onReassign: () => void
  onRetry: () => void
  retrying: boolean
}) {
  const status = getUploadStatusMeta(uploadStatus?.uploadStatus)
  const StatusIcon = status.icon

  return (
    <div className="group relative bg-slate-100 rounded-lg overflow-hidden aspect-square">
      {photo.thumbnailData || photo.previewUrl ? (
        <GalleryThumbnail
          source={photo.previewUrl}
          fallback={photo.thumbnailData}
          alt={photo.fileName}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <Image className="size-8 text-slate-400" />
        </div>
      )}

      {/* Cloud upload state */}
      <div
        className={cn(
          'absolute top-1.5 right-1.5 flex items-center gap-1 rounded-full border px-1.5 py-1 shadow-sm',
          status.badgeClass,
        )}
        title={`Upload status: ${status.label}`}
      >
        <StatusIcon className={cn('size-3', status.iconClass)} />
        <span className="sr-only">{status.label}</span>
      </div>

      {/* Hover overlay */}
      <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-1 p-2">
        <div className={cn('text-[11px] font-medium flex items-center gap-1 mb-1', status.textClass)}>
          <StatusIcon className="size-3" />
          {status.label}
        </div>
        <button
          onClick={onOpen}
          className="w-full text-white text-xs bg-white/20 hover:bg-white/30 rounded px-2 py-1 flex items-center justify-center gap-1"
        >
          <ExternalLink className="size-3" /> Open
        </button>
        <button
          onClick={onReassign}
          className="w-full text-white text-xs bg-white/20 hover:bg-white/30 rounded px-2 py-1"
        >
          Reassign
        </button>
        <button
          onClick={onDelete}
          className="w-full text-white text-xs bg-red-500/70 hover:bg-red-500 rounded px-2 py-1"
        >
          Delete
        </button>
        {uploadStatus?.uploadStatus === 'error' && (
          <button
            onClick={onRetry}
            disabled={retrying}
            className="w-full text-white text-xs bg-red-500/70 hover:bg-red-500 disabled:opacity-60 rounded px-2 py-1 flex items-center justify-center gap-1"
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
            className="w-full text-white text-xs bg-teal-500/80 hover:bg-teal-500 rounded px-2 py-1 flex items-center justify-center gap-1"
            title="Download uploaded photo"
          >
            <Download className="size-3" /> Download
          </a>
        )}
      </div>

      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/50 to-transparent p-1.5">
        <p className="text-white text-[10px] truncate">{photo.fileName}</p>
      </div>
    </div>
  )
}

function QrMarkerTile({
  marker,
  onOpen,
}: {
  marker: {
    fileName: string
    filePath: string
    thumbnailData: string | null
    previewUrl?: string
  }
  onOpen: () => void
}) {
  return (
    <div className="group relative bg-slate-100 rounded-lg overflow-hidden aspect-square">
        {marker.thumbnailData || marker.previewUrl ? (
          <GalleryThumbnail
            source={marker.previewUrl}
            fallback={marker.thumbnailData}
            alt={`QR marker ${marker.fileName}`}
          />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <Image className="size-8 text-slate-400" />
        </div>
      )}

      <div className="absolute top-1.5 left-1.5 rounded-full bg-teal-700/90 px-2 py-1 text-[10px] font-semibold text-white shadow-sm">
        QR MARKER
      </div>

      <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center p-3">
        <button
          type="button"
          onClick={onOpen}
          className="w-full text-white text-xs bg-white/20 hover:bg-white/30 rounded px-2 py-1 flex items-center justify-center gap-1"
        >
          <ExternalLink className="size-3" /> Open marker
        </button>
      </div>

      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-1.5">
        <p className="text-white text-[10px] truncate">{marker.fileName}</p>
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
  const photo = capture.legacyPhoto
  const rawFile = capture.files.find((file) => file.fileRole === 'RAW')
  if (photo) {
    return (
      <div className="group relative">
        <PhotoTile
          photo={photo}
          uploadStatus={uploadStatus}
          onOpen={onOpen}
          onDelete={onDelete!}
          onReassign={onReassign!}
          onRetry={onRetry!}
          retrying={retrying}
        />
        <CaptureStatusBadge status={capture.pairingStatus} />
        <CaptureUploadBadge capture={capture} />
        <CaptureReviewControls capture={capture} onUpdateReview={onUpdateReview} />
        {rawFile?.uploadStatus === 'error' && onRetryFile && (
          <button
            type="button"
            onClick={() => onRetryFile(rawFile.id)}
            disabled={retryingFileId === rawFile.id}
            className="absolute bottom-8 right-1.5 z-10 rounded bg-red-600/90 px-2 py-1 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100 disabled:opacity-60"
          >
            {retryingFileId === rawFile.id ? 'Retrying…' : 'Retry RAW'}
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="group relative bg-slate-100 rounded-lg overflow-hidden aspect-square">
      <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-slate-400">
        <Image className="size-10" />
        <span className="text-xs font-semibold tracking-wide">RAW ORIGINAL</span>
        <span className="text-[10px] text-slate-400">{capture.files[0]?.fileFormat ?? 'RAW'}</span>
      </div>
      <CaptureStatusBadge status={capture.pairingStatus} />
       <CaptureUploadBadge capture={capture} />
       <CaptureReviewControls capture={capture} onUpdateReview={onUpdateReview} />
      <div className="absolute inset-0 bg-black/65 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-2 p-3">
        <p className="text-center text-xs text-white">
          RAW file recorded without a JPEG partner
        </p>
        {rawFile && (
          <button
            type="button"
            onClick={onOpen}
            className="w-full text-white text-xs bg-white/20 hover:bg-white/30 rounded px-2 py-1"
          >
            <ExternalLink className="size-3 inline mr-1" /> Open RAW
          </button>
        )}
         {rawFile?.uploadStatus === 'error' && onRetryFile && (
           <button
             type="button"
             onClick={() => onRetryFile(rawFile.id)}
             disabled={retryingFileId === rawFile.id}
             className="w-full text-white text-xs bg-red-500/70 hover:bg-red-500 disabled:opacity-60 rounded px-2 py-1"
           >
             {retryingFileId === rawFile.id ? 'Retrying…' : 'Retry RAW upload'}
           </button>
         )}
      </div>
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-1.5">
        <p className="text-white text-[10px] truncate">{capture.baseFilename}</p>
      </div>
    </div>
  )
}

function CaptureReviewControls({
  capture,
  onUpdateReview,
}: {
  capture: CaptureReview
  onUpdateReview?: (captureId: number, values: { favorite?: boolean; rejected?: boolean; selected?: boolean }) => void
}) {
  if (!onUpdateReview) return null
  return (
    <div className="absolute bottom-1.5 left-1.5 z-10 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
      <button
        type="button"
        aria-label={capture.favorite ? 'Remove favorite' : 'Mark favorite'}
        title={capture.favorite ? 'Remove favorite' : 'Mark favorite'}
        onClick={() => onUpdateReview(capture.id, { favorite: !capture.favorite })}
        className={cn(
          'rounded-full border p-1.5 shadow-sm',
          capture.favorite
            ? 'border-amber-300 bg-amber-100 text-amber-600'
            : 'border-white/70 bg-black/50 text-white hover:bg-black/70',
        )}
      >
        <Star className="size-3" fill={capture.favorite ? 'currentColor' : 'none'} />
      </button>
      <button
        type="button"
        aria-label={capture.selected ? 'Remove from selection' : 'Add to selection'}
        title={capture.selected ? 'Remove from selection' : 'Add to selection'}
        onClick={() => onUpdateReview(capture.id, { selected: !capture.selected, rejected: false })}
        className={cn(
          'rounded-full border p-1.5 shadow-sm',
          capture.selected
            ? 'border-teal-300 bg-teal-100 text-teal-700'
            : 'border-white/70 bg-black/50 text-white hover:bg-black/70',
        )}
      >
        <Check className="size-3" />
      </button>
      <button
        type="button"
        aria-label={capture.rejected ? 'Restore capture' : 'Reject capture'}
        title={capture.rejected ? 'Restore capture' : 'Reject capture'}
        onClick={() => onUpdateReview(capture.id, { rejected: !capture.rejected, selected: false })}
        className={cn(
          'rounded-full border p-1.5 shadow-sm',
          capture.rejected
            ? 'border-red-300 bg-red-100 text-red-700'
            : 'border-white/70 bg-black/50 text-white hover:bg-black/70',
        )}
      >
        <XCircle className="size-3" />
      </button>
    </div>
  )
}

function CaptureUploadBadge({ capture }: { capture: CaptureReview }) {
  const statuses = capture.files
    .filter((file) => file.fileRole === 'RAW')
    .map((file) => file.uploadStatus)
    .filter(Boolean)
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
        'absolute top-1.5 right-1.5 z-10 flex items-center gap-1 rounded-full border px-1.5 py-1 shadow-sm',
        meta.badgeClass,
      )}
      title={`Capture upload: ${meta.label}`}
    >
      <StatusIcon className={cn('size-3', meta.iconClass)} />
      <span className="sr-only">{meta.label}</span>
    </span>
  )
}

function CaptureStatusBadge({ status }: { status: CaptureReview['pairingStatus'] }) {
  const meta = {
    complete: { label: 'JPEG + RAW', className: 'bg-green-100/95 text-green-700 border-green-200' },
    jpeg_only: { label: 'JPEG only', className: 'bg-amber-100/95 text-amber-700 border-amber-200' },
    raw_only: { label: 'RAW only', className: 'bg-blue-100/95 text-blue-700 border-blue-200' },
    unpaired: { label: 'Needs review', className: 'bg-red-100/95 text-red-700 border-red-200' },
    pending: { label: 'Pending', className: 'bg-slate-100/95 text-slate-600 border-slate-200' },
  }[status]

  return (
    <span
      className={cn(
        'absolute top-1.5 left-1.5 z-10 rounded-full border px-1.5 py-1 text-[9px] font-semibold shadow-sm',
        meta.className,
      )}
    >
      {meta.label}
    </span>
  )
}

function getUploadStatusMeta(status: UploadStatus | undefined) {
  switch (status) {
    case 'pending':
      return {
        label: 'Waiting for upload',
        icon: Upload,
        badgeClass: 'bg-amber-50/95 border-amber-200',
        iconClass: 'text-amber-600',
        textClass: 'text-amber-200',
      }
    case 'uploading':
      return {
        label: 'Uploading…',
        icon: Loader,
        badgeClass: 'bg-blue-50/95 border-blue-200',
        iconClass: 'text-blue-600 animate-spin',
        textClass: 'text-blue-200',
      }
    case 'done':
      return {
        label: 'Uploaded',
        icon: CheckCircle,
        badgeClass: 'bg-green-50/95 border-green-200',
        iconClass: 'text-green-600',
        textClass: 'text-green-200',
      }
    case 'error':
      return {
        label: 'Upload failed',
        icon: XCircle,
        badgeClass: 'bg-red-50/95 border-red-200',
        iconClass: 'text-red-600',
        textClass: 'text-red-200',
      }
    default:
      return {
        label: 'Not uploaded',
        icon: CloudUpload,
        badgeClass: 'bg-slate-50/95 border-slate-200',
        iconClass: 'text-slate-500',
        textClass: 'text-slate-200',
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
    <Dialog open title="Reassign photo to student" onClose={onClose} className="max-w-sm">
      <p className="text-sm text-slate-500 mb-3">Select the student this photo belongs to:</p>
      <input
        type="text"
        placeholder="Search students…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg mb-2 focus:outline-none focus:ring-1 focus:ring-teal-500"
      />
      <div className="h-48 overflow-y-auto border border-slate-200 rounded-lg mb-4">
        {filtered.map((s) => (
          <button
            key={s.id}
            onClick={() => setSelectedId(s.id)}
            className={cn(
              'w-full px-3 py-2 text-left text-sm border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors',
              selectedId === s.id ? 'bg-teal-50 text-teal-700 font-medium' : 'text-slate-700',
            )}
          >
            {s.lastName}, {s.firstName}
            <span className="ml-2 font-mono text-xs text-slate-400">{s.generatedStudentId}</span>
          </button>
        ))}
      </div>
      <div className="flex gap-2 justify-end">
        <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" onClick={handleSave} disabled={!selectedId || saving}>
          {saving ? 'Saving…' : 'Reassign'}
        </Button>
      </div>
    </Dialog>
  )
}
