import React, { useState, useCallback, useEffect } from 'react'
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
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useProject, useClasses, useStudents, usePhotos, useWatcherStatus, usePhotoEvents } from '@/hooks/useApi'
import { addToast } from '@/components/ui/toast'
import type { Student, Class, Photo, PhotoMatchedEvent } from '@/hooks/useApi'

interface Props {
  projectId: number
  onBack: () => void
}

export function ProjectView({ projectId, onBack }: Props) {
  const { data: project, reload: reloadProject } = useProject(projectId)
  const { data: classes } = useClasses(projectId)
  const [selectedClassId, setSelectedClassId] = useState<number | null>(null)
  const { data: students, reload: reloadStudents } = useStudents(projectId, selectedClassId ?? undefined)
  const [selectedStudent, setSelectedStudent] = useState<Student | null>(null)
  const { isRunning, start: startWatcher, stop: stopWatcher } = useWatcherStatus(projectId)
  const [search, setSearch] = useState('')
  const [settingFolder, setSettingFolder] = useState(false)
  const [reassignDialogPhoto, setReassignDialogPhoto] = useState<Photo | null>(null)

  // Re-select the student when students refresh (to get updated photoCount)
  useEffect(() => {
    if (selectedStudent) {
      const refreshed = students.find((s) => s.id === selectedStudent.id)
      if (refreshed) setSelectedStudent(refreshed)
    }
  }, [students])

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
            {project?.classCount} classes · {project?.studentCount} students · {project?.photoCount} photos taken
          </p>
        </div>

        {/* Watch folder controls */}
        <div className="flex items-center gap-2 shrink-0">
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

          {/* Student list */}
          <div className="flex-1 overflow-y-auto">
            {filteredStudents.map((s) => (
              <StudentRow
                key={s.id}
                student={s}
                isSelected={selectedStudent?.id === s.id}
                onClick={() => setSelectedStudent(s)}
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
              onReassign={() => reloadStudents()}
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
    </div>
  )
}

function StudentRow({
  student: s,
  isSelected,
  onClick,
}: {
  student: Student
  isSelected: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full px-3 py-2.5 text-left flex items-center gap-2 transition-colors border-b border-slate-50',
        isSelected
          ? 'bg-teal-50 border-l-2 border-l-teal-500'
          : 'hover:bg-slate-50',
      )}
    >
      <div className="flex-1 min-w-0">
        <p className={cn('text-sm font-medium truncate', isSelected ? 'text-teal-700' : 'text-slate-800')}>
          {s.lastName}, {s.firstName}
        </p>
        <p className="text-xs text-slate-400 font-mono">{s.generatedStudentId}</p>
      </div>
      {s.photoCount > 0 ? (
        <Badge variant="success" className="text-[10px] px-1.5 py-0 shrink-0">
          <Camera className="size-2.5 mr-0.5" />
          {s.photoCount}
        </Badge>
      ) : null}
    </button>
  )
}

function StudentDetail({
  student,
  projectId,
  onReassign,
}: {
  student: Student
  projectId: number
  onReassign: () => void
}) {
  const { data: photos, reload: reloadPhotos } = usePhotos(student.id)
  const [reassignOpen, setReassignOpen] = useState(false)
  const [reassignPhoto, setReassignPhoto] = useState<Photo | null>(null)

  const handlePhotoMatched = useCallback(
    (data: PhotoMatchedEvent) => {
      if (data.student.id === student.id) {
        reloadPhotos()
      }
    },
    [student.id, reloadPhotos],
  )
  usePhotoEvents(handlePhotoMatched)

  async function handleDeletePhoto(photoId: number) {
    await window.api.invoke('photos:delete', { photoId })
    reloadPhotos()
    onReassign()
  }

  async function handleOpenPhoto(filePath: string) {
    await window.api.invoke('photos:openInSystem', { filePath })
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
        </div>
        <div className="flex items-center gap-2">
          {photos.length > 0 ? (
            <Badge variant="success">{photos.length} photo{photos.length !== 1 ? 's' : ''} captured</Badge>
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
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-3">
            Captured photos ({photos.length})
          </p>

          {photos.length === 0 ? (
            <div className="h-40 flex flex-col items-center justify-center border-2 border-dashed border-slate-200 rounded-xl">
              <Image className="size-8 text-slate-300 mb-2" />
              <p className="text-sm text-slate-400">No photos yet</p>
              <p className="text-xs text-slate-400 mt-0.5">
                Photos will appear here automatically when captured
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              {photos.map((photo) => (
                <PhotoTile
                  key={photo.id}
                  photo={photo}
                  onOpen={() => handleOpenPhoto(photo.filePath)}
                  onDelete={() => handleDeletePhoto(photo.id)}
                  onReassign={() => {
                    setReassignPhoto(photo)
                    setReassignOpen(true)
                  }}
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
            reloadPhotos()
            onReassign()
          }}
        />
      )}
    </div>
  )
}

function PhotoTile({
  photo,
  onOpen,
  onDelete,
  onReassign,
}: {
  photo: Photo
  onOpen: () => void
  onDelete: () => void
  onReassign: () => void
}) {
  return (
    <div className="group relative bg-slate-100 rounded-lg overflow-hidden aspect-square">
      {photo.thumbnailData ? (
        <img
          src={photo.thumbnailData}
          alt={photo.fileName}
          className="w-full h-full object-cover"
          draggable={false}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <Image className="size-8 text-slate-400" />
        </div>
      )}

      {/* Hover overlay */}
      <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-1 p-2">
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
      </div>

      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/50 to-transparent p-1.5">
        <p className="text-white text-[10px] truncate">{photo.fileName}</p>
      </div>
    </div>
  )
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
