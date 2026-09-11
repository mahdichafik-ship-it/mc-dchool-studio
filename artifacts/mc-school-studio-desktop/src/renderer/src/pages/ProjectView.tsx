import React, { useState, useEffect, useRef } from 'react'
import {
  ArrowLeft, Folder, Play, Square, Search, Image, User,
  ChevronRight, Camera, AlertCircle, ExternalLink, Download,
  Upload, CloudUpload, CheckCircle, XCircle, Loader,
  RefreshCw, Star, Check, Plus, Pencil, Trash2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  useProject,
  useClasses,
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
  StudentGroup,
  GroupCaptureReview,
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
  const isCorporate = project?.projectType === 'corporate'
  const departmentLabel = isCorporate ? 'Department' : 'Class'
  const employeeLabel = isCorporate ? 'Employee' : 'Student'
  const employeePlural = `${employeeLabel}s`
  const { data: captureSummary } = useCaptureSummary(projectId)
  const [groupCaptureCount, setGroupCaptureCount] = useState(0)
  const { data: classes, reload: reloadClasses } = useClasses(projectId)
  const [selectedClassId, setSelectedClassId] = useState<number | null>(null)
  const { data: students, reload: reloadStudents } = useStudents(projectId, selectedClassId ?? undefined)
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
  const [addStudentOpen, setAddStudentOpen] = useState(false)
  const [reassignDialogPhoto, setReassignDialogPhoto] = useState<Photo | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [exportMode, setExportMode] = useState<CaptureExportMode>('all')
  const [exporting, setExporting] = useState<CaptureExportLayout | null>(null)
  const [finishing, setFinishing] = useState(false)
  const [renamingGroupId, setRenamingGroupId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [syncProgress, setSyncProgress] = useState<ProjectSyncProgressEvent | null>(null)
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false)
  const [finishDialogOpen, setFinishDialogOpen] = useState(false)
  const [uploadActionRunning, setUploadActionRunning] = useState(false)
  const autoStartAttemptedRef = useRef<number | null>(null)
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
    return window.api.on('project:syncProgress', (event) => {
      if (event.projectId === projectId) setSyncProgress(event)
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
      if (refreshed) setSelectedStudent(refreshed)
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
    setSelectedStudent(student)
    setSelectedGroup(null)
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

  async function handleStudentCreated(result: CreateStudentResult) {
    await Promise.all([reloadStudents(), reloadClasses(), reloadProject()])
    setSelectedClassId(result.student.classId)
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
        setFinishDialogOpen(false)
        setUploadDialogOpen(false)
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
      await reloadLiveUpload()
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
    } catch (error) {
      addToast({ type: 'error', title: 'Upload could not continue', description: String(error) })
    } finally {
      setUploadActionRunning(false)
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
    <div className="flex flex-col h-full font-sans bg-slate-50">
      {/* Header bar */}
      <header className="bg-slate-950 border-b border-slate-900 px-6 py-3 shrink-0 flex flex-wrap items-center justify-between gap-y-3 shadow-sm z-20">
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
              <span className="w-1 h-1 rounded-full bg-slate-700" />
              <span className="text-slate-300">
                {captureSummary.total > 0 ? `${captureSummary.total} captures` : `${project?.photoCount ?? 0} photos`}
              </span>
              {pendingUploadCount > 0 && (
                <>
                  <span className="w-1 h-1 rounded-full bg-amber-500/50" />
                  <span className="text-amber-400 flex items-center gap-1">
                    <Upload className="size-3" /> {pendingUploadCount} pending
                  </span>
                </>
              )}
              {syncProgress?.phase === 'error' && (
                 <>
                   <span className="w-1 h-1 rounded-full bg-red-500/50" />
                   <span className="text-red-400 flex items-center gap-1">
                     <AlertCircle className="size-3" /> {syncProgress.failed} failed
                   </span>
                 </>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4 shrink-0">
          {/* Watch Folder Control */}
          {project?.watchFolder ? (
            <div className={cn(
              "flex items-center h-8 rounded-md border transition-colors overflow-hidden",
              isRunning ? "bg-teal-500/10 border-teal-500/20" : "bg-slate-900 border-slate-800"
            )}>
               <div className="flex items-center gap-2 px-3">
                 <div className={cn("w-2 h-2 rounded-full", isRunning ? "bg-teal-400 animate-pulse shadow-[0_0_8px_rgba(45,212,191,0.6)]" : "bg-slate-600")} />
                 <span className={cn("text-[10px] font-bold uppercase tracking-wider", isRunning ? "text-teal-400" : "text-slate-400")}>
                   {isRunning ? "Live" : "Paused"}
                 </span>
               </div>
               <div className={cn("w-px h-full", isRunning ? "bg-teal-500/20" : "bg-slate-800")} />
               <button onClick={handleToggleWatcher} className={cn("px-3 h-full text-[10px] font-bold uppercase tracking-wider transition-colors flex items-center gap-1", isRunning ? "text-teal-400 hover:text-white hover:bg-teal-500/20" : "text-slate-300 hover:text-white hover:bg-slate-800")}>
                 {isRunning ? <Square className="size-3 fill-current" /> : <Play className="size-3 fill-current" />}
                 {isRunning ? "Stop" : "Start"}
               </button>
               <div className={cn("w-px h-full", isRunning ? "bg-teal-500/20" : "bg-slate-800")} />
               <button onClick={handleSetWatchFolder} aria-label="Change watch folder" className={cn("px-2 h-full transition-colors", isRunning ? "text-teal-600 hover:text-teal-300 hover:bg-teal-500/20" : "text-slate-400 hover:text-white hover:bg-slate-800")} title="Change folder">
                 <Folder className="size-3" />
               </button>
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={handleSetWatchFolder} className="h-8 bg-slate-900 border-slate-800 text-slate-300 hover:text-white hover:bg-slate-800 text-[10px] font-bold uppercase tracking-wider">
              <Folder className="size-3.5 mr-1.5" /> Set Watch Folder
            </Button>
          )}

          <div className="w-px h-6 bg-slate-800" />

          {/* Exports & Finish */}
          <div className="flex items-center gap-2">
             <div className={cn(
               "flex items-center h-8 rounded-md border overflow-hidden",
               liveUpload?.enabled ? "bg-blue-500/10 border-blue-500/30" : "bg-slate-900 border-slate-800",
             )}>
               <button
                 onClick={() => void handleToggleLiveUpload()}
                 disabled={uploadActionRunning || Boolean(project?.finishedAt)}
                 className={cn(
                   "h-full px-3 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider disabled:opacity-50",
                   liveUpload?.enabled ? "text-blue-300 hover:bg-blue-500/20" : "text-slate-300 hover:bg-slate-800",
                 )}
                 title="Uploads captures in the background without finishing the shoot"
               >
                 {liveUpload?.running ? <Loader className="size-3 animate-spin" /> : <CloudUpload className="size-3" />}
                 Live Upload {liveUpload?.enabled ? 'On' : 'Off'}
               </button>
               <div className={cn("w-px h-full", liveUpload?.enabled ? "bg-blue-500/30" : "bg-slate-800")} />
               <button
                 onClick={() => setUploadDialogOpen(true)}
                 className="h-full px-2.5 text-slate-300 hover:text-white hover:bg-slate-800 text-[10px] font-bold"
                 title="Open upload activity"
               >
                 {liveUpload?.uploading ? `${liveUpload.uploading} ↑` : liveUpload?.pending ? `${liveUpload.pending} queued` : 'Status'}
               </button>
             </div>
             {captureSummary.total > 0 && (
                <div className="flex items-center h-8 rounded-md bg-slate-900 border border-slate-800 overflow-hidden">
                   <select
                      value={exportMode}
                      onChange={(event) => setExportMode(event.target.value as CaptureExportMode)}
                      className="h-full bg-transparent px-2 text-[10px] font-bold uppercase tracking-wider text-slate-300 focus:outline-none border-r border-slate-800 cursor-pointer hover:bg-slate-800 transition-colors"
                   >
                     <option value="all">All</option>
                     <option value="paired">Paired</option>
                     <option value="jpeg_only">JPEG Only</option>
                     <option value="raw_only">RAW Only</option>
                     <option value="selected">Selected</option>
                     <option value="favorite">Favorites</option>
                     <option value="final_selection">Final</option>
                   </select>
                   <button onClick={() => void handleExportCaptures('capture_folders')} disabled={exporting !== null} className="px-3 h-full text-[10px] font-bold uppercase tracking-wider text-slate-300 hover:text-white hover:bg-slate-800 transition-colors flex items-center gap-1.5 disabled:opacity-50">
                      {exporting === 'capture_folders' ? <Loader className="size-3 animate-spin" /> : <Download className="size-3" />}
                      Export
                   </button>
                   <div className="w-px h-full bg-slate-800" />
                   <button onClick={() => void handleExportCaptures('lightroom_watch_folder')} disabled={exporting !== null} className="px-3 h-full text-[10px] font-bold uppercase tracking-wider text-slate-300 hover:text-white hover:bg-slate-800 transition-colors flex items-center gap-1.5 disabled:opacity-50" title="Send to Lightroom Auto Import">
                      {exporting === 'lightroom_watch_folder' ? <Loader className="size-3 animate-spin" /> : <Image className="size-3" />}
                      To LR
                   </button>
                </div>
             )}
             <Button
               size="sm"
               onClick={() => setFinishDialogOpen(true)}
               disabled={finishing || Boolean(project?.finishedAt) || (captureSummary.total === 0 && groupCaptureCount === 0)}
               className={cn(
                 "h-8 px-4 text-[10px] font-bold uppercase tracking-wider transition-colors",
                 project?.finishedAt ? "bg-slate-800 text-slate-400 hover:bg-slate-800" : "bg-blue-600 text-white hover:bg-blue-500 shadow-md"
               )}
             >
               {finishing ? (
                 <Loader className="size-3.5 mr-1.5 animate-spin" />
               ) : project?.finishedAt ? (
                 <CheckCircle className="size-3.5 mr-1.5" />
               ) : (
                 <CloudUpload className="size-3.5 mr-1.5" />
               )}
               {finishing ? (syncProgress && syncProgress.total > 0 ? `Uploading ${syncProgress.completed}/${syncProgress.total}` : 'Preparing…') : project?.finishedAt ? 'Finished' : 'Finish My Shoot'}
             </Button>
          </div>
        </div>
      </header>

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
          <div className="grid grid-cols-4 gap-2">
            {[
              ['Uploaded', liveUpload?.done ?? 0, 'text-emerald-700 bg-emerald-50'],
              ['Uploading', liveUpload?.uploading ?? 0, 'text-blue-700 bg-blue-50'],
              ['Queued', liveUpload?.pending ?? 0, 'text-amber-700 bg-amber-50'],
              ['Failed', liveUpload?.error ?? 0, 'text-red-700 bg-red-50'],
            ].map(([label, value, color]) => (
              <div key={String(label)} className={cn("rounded-lg p-3 text-center", String(color))}>
                <div className="text-xl font-extrabold">{String(value)}</div>
                <div className="text-[10px] font-bold uppercase tracking-wider">{String(label)}</div>
              </div>
            ))}
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
              disabled={uploadActionRunning || !liveUpload?.cloudReady || (liveUpload?.pending ?? 0) === 0}
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
                  Volume Capture will drain the watch folder, upload every remaining file,
                  and finish this photographer’s batch. It does not close the studio’s entire project.
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
          {!liveUpload?.cloudReady && (
            <p className="text-sm font-medium text-red-600">
              Connect to Volume Capture before finishing. Your local captures remain safe.
            </p>
          )}
          <div className="flex gap-3 justify-end">
            <Button variant="outline" disabled={finishing} onClick={() => setFinishDialogOpen(false)}>
              Keep Shooting
            </Button>
            <Button
              disabled={finishing || !liveUpload?.cloudReady}
              onClick={() => void handleUploadAndFinish()}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              {finishing && <Loader className="size-4 mr-2 animate-spin" />}
              {finishing && syncProgress?.total
                ? `Uploading ${syncProgress.completed}/${syncProgress.total}`
                : 'Upload Remaining & Finish'}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Body: split panel */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left panel: classes + students */}
        <div className="w-[340px] flex-shrink-0 bg-white border-r border-slate-200 shadow-[4px_0_24px_rgba(0,0,0,0.02)] z-10 flex flex-col">
          {/* Class tabs */}
          <div className="flex overflow-x-auto border-b border-slate-100 shrink-0 p-2 gap-1 hide-scrollbar">
            <button
              onClick={() => setSelectedClassId(null)}
              className={cn(
                "px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded-md whitespace-nowrap transition-colors",
                !selectedClassId ? "bg-slate-900 text-white shadow-sm" : "text-slate-500 hover:bg-slate-100 hover:text-slate-900"
              )}
            >
              All ({students.length})
            </button>
            {classes.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelectedClassId(c.id)}
                className={cn(
                  "px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded-md whitespace-nowrap transition-colors",
                  selectedClassId === c.id ? "bg-slate-900 text-white shadow-sm" : "text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                )}
              >
                {c.className}
              </button>
            ))}
          </div>

          {/* Search */}
          <div className="p-3 border-b border-slate-100 bg-slate-50/50 shrink-0">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-2.5 size-4 text-slate-400" />
                <input
                  type="text"
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

          {/* Student list */}
          <div className="flex-1 overflow-y-auto">
            {groups.length > 0 && (
              <div className="py-2 border-b border-slate-100">
                <div className="px-4 py-2 flex items-center justify-between text-[10px] font-bold uppercase tracking-widest text-slate-400">
                  <span>Groups</span>
                  {!project?.finishedAt && (
                    <button type="button" onClick={() => void handleCreateGroup()} className="text-teal-600 hover:text-teal-700 flex items-center gap-0.5">
                      <Plus className="size-3" /> New
                    </button>
                  )}
                </div>
                {groups.map((group) => (
                  <div key={group.id} className={cn("flex flex-col border-b border-slate-100 last:border-0", selectedGroup?.id === group.id ? "bg-teal-50/50" : "bg-white")}>
                    {renamingGroupId === group.id ? (
                      <div className="px-4 py-2">
                        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void handleRenameGroup(group) }}>
                          <input autoFocus value={renameValue} onChange={(e) => setRenameValue(e.target.value)} className="flex-1 h-7 px-2 text-xs font-medium border border-slate-300 rounded focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500" />
                          <Button type="submit" size="sm" className="h-7 px-2 bg-teal-600 hover:bg-teal-700 text-white text-[10px] uppercase font-bold tracking-wider">Save</Button>
                        </form>
                      </div>
                    ) : (
                      <div className={cn("flex items-center px-4 py-2 group/group transition-colors border-l-4", selectedGroup?.id === group.id ? "border-teal-500" : "border-transparent hover:bg-slate-50")}>
                        <button type="button" onClick={() => void handleSelectGroup(group)} className="flex-1 flex items-center justify-between text-left min-w-0 mr-2">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <div className={cn("w-6 h-6 rounded-md flex items-center justify-center shrink-0", selectedGroup?.id === group.id ? "bg-teal-100 text-teal-700" : "bg-slate-100 text-slate-500")}>
                              <User className="size-3.5" />
                            </div>
                            <span className={cn("text-sm font-bold truncate", selectedGroup?.id === group.id ? "text-teal-950" : "text-slate-800")}>{group.name}</span>
                          </div>
                          <Badge className="bg-slate-200 hover:bg-slate-200 text-slate-700 text-[10px] px-1.5 py-0 rounded font-bold shadow-none">
                            {group.memberStudentIds.length}
                          </Badge>
                        </button>
                        {!group.isDefaultClassGroup && !project?.finishedAt && (
                          <div className="flex items-center gap-1 opacity-0 group-hover/group:opacity-100 transition-opacity">
                            <button type="button" onClick={() => { setRenamingGroupId(group.id); setRenameValue(group.name) }} className="p-1 text-slate-400 hover:text-teal-600 transition-colors" title="Rename group">
                              <Pencil className="size-3.5" />
                            </button>
                            <button type="button" onClick={() => void handleDeleteGroup(group)} className="p-1 text-slate-400 hover:text-red-600 transition-colors" title="Delete group">
                              <Trash2 className="size-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

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
                  uploadSummary={uploadStatusMap.get(s.id)}
                />
              ))}
              {filteredStudents.length === 0 && (
                <div className="p-8 text-center text-slate-400 text-xs font-medium">No {employeePlural.toLowerCase()} found</div>
              )}
            </div>
          </div>
        </div>

        {/* Right panel: QR code + photos */}
        <div className="flex-1 flex flex-col min-w-0 bg-slate-50">
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
              projectId={projectId}
              photoStatusMap={photoStatusMap}
              onReassign={() => reloadStudents()}
              isActiveCaptureTarget={activeStudentId === selectedStudent.id}
              activeStudentSource={activeStudentSource}
              onClearCaptureTarget={() => void handleClearCaptureStudent()}
              offline={offline}
              employeeLabel={employeeLabel}
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
        "text-left w-full p-3 border-b transition-colors flex items-center gap-3",
        isActive ? "bg-teal-50/50 border-l-4 border-l-teal-500" : isSelected ? "bg-slate-50 border-l-4 border-l-transparent" : "hover:bg-slate-50 border-l-4 border-l-transparent border-b-slate-100"
      )}
      aria-pressed={isActive}
      title={isActive ? 'Active capture student' : 'Select as active capture student'}
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
  projectId,
  photoStatusMap,
  onReassign,
  isActiveCaptureTarget,
  activeStudentSource,
  onClearCaptureTarget,
  offline,
  employeeLabel,
}: {
  student: Student
  projectId: number
  photoStatusMap: Map<number, ProjectUploadStatusRow>
  onReassign: () => void
  isActiveCaptureTarget: boolean
  activeStudentSource: 'manual' | 'qr' | 'none'
  onClearCaptureTarget: () => void
  offline: boolean
  employeeLabel: string
}) {
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

  return (
    <div className="flex flex-col h-full relative bg-slate-50">
       {/* Person info header */}
      <div className="bg-white border-b border-slate-200 px-8 py-6 flex flex-wrap gap-4 justify-between items-start shadow-sm z-10 shrink-0 relative">
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
          </div>
             <h2 className="text-3xl sm:text-4xl font-extrabold text-slate-900 tracking-tight break-words" aria-label={employeeLabel}>
            {student.firstName} {student.lastName}
          </h2>
        </div>
        <div className="flex flex-col items-end gap-3 justify-center shrink-0">
          {isActiveCaptureTarget && (
            <Button variant="outline" size="sm" onClick={onClearCaptureTarget} className="text-[10px] font-bold uppercase tracking-wider h-8 border-slate-300 text-slate-600 hover:bg-slate-100 hover:text-slate-900 shadow-sm">
              <XCircle className="size-3.5 mr-1.5" /> Clear Target
            </Button>
          )}
          <div className="text-[11px] font-bold uppercase tracking-widest text-slate-500">
            {captures.length} Capture{captures.length !== 1 ? 's' : ''} recorded
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-[1400px] mx-auto flex flex-col-reverse xl:flex-row gap-8">
          {/* Photo gallery */}
          <div className="flex-1 min-w-0 flex flex-col gap-6">
            {livePreview?.photo.previewUrl && (
              <LivePreview
                photo={livePreview.photo}
                traceId={livePreview.pipeline?.traceId}
              />
            )}

            <div>
              <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
                <div className="text-[10px] font-extrabold text-teal-600 uppercase tracking-widest bg-teal-50 px-3.5 py-1.5 rounded-full border border-teal-100 shadow-sm w-fit">
                  2. Live Captures
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
                  <div className="w-20 h-20 bg-teal-50 text-teal-600 rounded-3xl flex items-center justify-center mb-5 shadow-sm border border-teal-100">
                    <Camera className="size-10" />
                  </div>
                  <h3 className="text-xl font-extrabold text-slate-900 mb-2 tracking-tight">Ready for photos</h3>
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
                <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
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

          {/* QR code panel */}
          <div className="w-full xl:w-[300px] shrink-0">
            <div className="bg-white rounded-3xl shadow-sm border border-slate-200 p-6 flex flex-col sm:flex-row xl:flex-col items-center sm:items-stretch xl:items-center gap-6">
              <div className="flex flex-col flex-1 justify-center items-center sm:items-start xl:items-center min-w-0 w-full">
                <div className="text-[10px] font-extrabold text-teal-600 uppercase tracking-widest mb-4 bg-teal-50 px-3.5 py-1.5 rounded-full border border-teal-100 shadow-sm">
                  1. Scan to link
                </div>
                <p className="text-[11px] text-slate-500 font-mono font-medium bg-slate-50 px-3 py-2 rounded-lg w-full truncate text-center sm:text-left xl:text-center border border-slate-100 hidden sm:block xl:hidden mb-4">
                  {student.firstName}.{student.lastName}.{student.generatedStudentId}
                </p>
                <div className="hidden sm:block xl:hidden text-xs text-slate-400 font-medium max-w-[200px]">
                  Present this code to the camera before capturing portraits.
                </div>
              </div>
              <div className="shrink-0 w-48 sm:w-40 xl:w-full flex flex-col items-center">
                {student.simpleQr ? (
                  <img
                    src={student.simpleQr}
                    alt="Student QR Code"
                    className="w-full aspect-square bg-slate-50 rounded-2xl border-2 border-slate-100 p-3 shadow-inner"
                    draggable={false}
                  />
                ) : (
                  <div className="w-full aspect-square bg-slate-50 rounded-2xl border-2 border-dashed border-slate-200 flex flex-col items-center justify-center p-4">
                    <AlertCircle className="size-8 text-slate-300 mb-2" />
                    <p className="text-xs font-bold text-slate-500 text-center">QR not generated</p>
                    <p className="text-[10px] font-medium text-slate-400 text-center mt-1">Generate in the web app</p>
                  </div>
                )}
              </div>
              <p className="text-[11px] text-slate-500 mt-2 sm:hidden xl:block font-mono font-medium bg-slate-50 px-3 py-2 rounded-lg w-full truncate text-center border border-slate-100">
                {student.firstName}.{student.lastName}.{student.generatedStudentId}
              </p>
            </div>
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
  return (
    <div className="flex flex-col h-full relative bg-slate-50">
      <div className="bg-white border-b border-slate-200 px-8 py-6 flex flex-wrap gap-4 justify-between items-start shadow-sm z-10 shrink-0 relative">
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
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold text-slate-900 tracking-tight break-words">
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
        <div className="max-w-[1400px] mx-auto flex flex-col xl:flex-row gap-8">
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
                  const isSelected = group.memberStudentIds.includes(student.id);
                  return (
                    <label key={student.id} className={cn("flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-all border", isSelected ? "bg-teal-50/50 border-teal-200 shadow-sm" : "border-transparent hover:bg-slate-50")}>
                      <input type="checkbox" className="rounded border-slate-300 text-teal-600 focus:ring-teal-600 size-4" checked={isSelected} onChange={e => onMembershipChange(group, student.id, e.target.checked)} />
                      <div className="flex-1 min-w-0">
                        <p className={cn("text-sm font-bold truncate", isSelected ? "text-teal-950" : "text-slate-700")}>{student.lastName}, {student.firstName}</p>
                        <p className="text-[10px] font-mono font-medium text-slate-500 truncate mt-0.5">{student.generatedStudentId}</p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Captures Column */}
          <div className="flex-1 min-w-0 flex flex-col gap-4">
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
                <div className="w-20 h-20 bg-teal-50 text-teal-600 rounded-3xl flex items-center justify-center mb-5 shadow-sm border border-teal-100">
                  <Camera className="size-10" />
                </div>
                <h3 className="text-xl font-extrabold text-slate-900 mb-2 tracking-tight">Ready for group photos</h3>
                <p className="text-slate-500 max-w-sm text-sm font-medium leading-relaxed mb-4">
                  Make sure all subjects are framed, then start shooting.
                </p>
                <Button onClick={onRefreshCaptures} className="bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold uppercase tracking-wider px-6 shadow-sm">
                  <RefreshCw className="size-4 mr-2" /> Check for Captures
                </Button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4">
                {groupCaptures.map(capture => (
                  <div key={capture.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm flex flex-col gap-4 relative overflow-hidden group/tile transition-shadow hover:shadow-md">
                    <div className="absolute top-0 left-0 w-1 h-full bg-teal-500" />
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <span className="font-extrabold text-base text-slate-900 truncate">{capture.baseFilename}</span>
                      </div>
                      <Badge className="bg-slate-100 text-slate-600 border-none font-extrabold uppercase tracking-wider text-[9px] px-2 py-0.5 shadow-none">{capture.pairingStatus}</Badge>
                    </div>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      {capture.files.map(file => (
                        <button key={file.id} type="button" onClick={() => void window.api.invoke('photos:openInSystem', { filePath: file.storedPath })} className="hover:text-teal-700 hover:bg-teal-50 transition-colors flex items-center justify-center gap-1.5 bg-slate-50 px-3 py-2 rounded-lg border border-slate-200 text-[10px] font-extrabold uppercase tracking-wider text-slate-600 flex-1">
                          <ExternalLink className="size-3" /> {file.fileRole}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
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
}: {
  photo: Photo
  traceId?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [showImageFallback, setShowImageFallback] = useState(false)
  const [canvasPainted, setCanvasPainted] = useState(false)
  const [previewFailed, setPreviewFailed] = useState(false)

  useEffect(() => {
    if (!photo.previewUrl || !traceId) return
    let mounted = true
    setShowImageFallback(false)
    setCanvasPainted(false)
    setPreviewFailed(false)
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

  return (
    <div className="mb-4 overflow-hidden rounded-2xl border border-slate-200 bg-black shadow-lg relative aspect-[16/9] md:aspect-[21/9] flex flex-col group">
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

      <div className="flex-1 w-full bg-black relative flex items-center justify-center p-4">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`Latest capture ${photo.fileName}`}
          className={cn(
            'block max-h-full max-w-full object-contain',
            (!canvasPainted || showImageFallback) && 'hidden',
          )}
        />
        {(!canvasPainted || showImageFallback) && !previewFailed && (
          <img
            src={photo.previewUrl}
            alt={`Latest capture ${photo.fileName}`}
            className="block max-h-full max-w-full object-contain"
            draggable={false}
            onError={() => setPreviewFailed(true)}
          />
        )}
        {previewFailed && !canvasPainted && (
          <div className="flex h-40 flex-col items-center justify-center px-6 text-center">
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
      <div className="flex h-full w-full items-center justify-center bg-slate-100">
        <Image className="size-8 text-slate-300" />
      </div>
    )
  }
  return (
    <img
      src={imageSource}
      alt={alt}
      className="h-full w-full object-cover transition-opacity duration-300 ease-in-out"
      draggable={false}
    />
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
  return (
    <div className="group relative bg-slate-100 rounded-2xl overflow-hidden aspect-square border border-slate-200 shadow-sm transition-all hover:shadow-md h-full w-full">
      {photo.thumbnailData || photo.previewUrl ? (
        <GalleryThumbnail
          source={photo.previewUrl}
          fallback={photo.thumbnailData}
          alt={photo.fileName}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <Image className="size-8 text-slate-300" />
        </div>
      )}

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
    fileName: string
    filePath: string
    thumbnailData: string | null
    previewUrl?: string
  }
  onOpen: () => void
}) {
  return (
    <div className="group relative bg-slate-100 rounded-2xl overflow-hidden aspect-square border border-slate-200 shadow-sm transition-all hover:shadow-md h-full w-full">
        {marker.thumbnailData || marker.previewUrl ? (
          <GalleryThumbnail
            source={marker.previewUrl}
            fallback={marker.thumbnailData}
            alt={`QR marker ${marker.fileName}`}
          />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <Image className="size-8 text-slate-300" />
        </div>
      )}

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
  const photo = capture.legacyPhoto
  const rawFile = capture.files.find((file) => file.fileRole === 'RAW')

  if (photo) {
    return (
      <div className="group relative rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow h-full w-full bg-slate-100">
        <PhotoTile
          photo={photo}
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
    <div className="group relative bg-slate-100 rounded-2xl overflow-hidden aspect-square border border-slate-200 shadow-sm transition-all hover:shadow-md h-full w-full">
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
  const hasActiveState = capture.rating > 0 || capture.colorLabel !== 'none' || capture.rejected
  const colors = [
    ['red', 'bg-red-500'],
    ['yellow', 'bg-yellow-400'],
    ['green', 'bg-emerald-500'],
    ['blue', 'bg-blue-500'],
    ['purple', 'bg-purple-500'],
  ] as const
  return (
    <div className={cn(
      "absolute bottom-2 left-2 right-2 z-30 flex flex-col gap-1.5 transition-all duration-200",
      hasActiveState
        ? "opacity-100 translate-y-0"
        : "opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 focus-within:opacity-100 focus-within:translate-y-0"
    )}>
      <div className="flex items-center gap-0.5 rounded-lg border border-white/20 bg-black/65 px-1.5 py-1 backdrop-blur-md">
        {[1, 2, 3, 4, 5].map((rating) => (
          <button
            key={rating}
            type="button"
            aria-label={`Rate ${rating} star${rating === 1 ? '' : 's'}`}
            onClick={() => onUpdateReview(capture.id, {
              rating: capture.rating === rating ? 0 : rating,
              favorite: rating >= 4,
            })}
            className="p-1 text-amber-300 hover:text-amber-200"
          >
            <Star className="size-3.5" fill={capture.rating >= rating ? 'currentColor' : 'none'} />
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-white/20" />
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
